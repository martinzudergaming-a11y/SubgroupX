import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const PROVIDERS = new URL("../server/src/runtime/providers.ts", import.meta.url).href;

async function probe() {
  const {
    DEFAULT_JAIL_MODEL_ID,
    JAIL_MODEL_IDS,
    JAIL_PROVIDER,
    jailAvailable,
    resolveModel,
    listModelsForProviders,
    apiKeyResolver,
  } = await import(PROVIDERS);
  const models = listModelsForProviders([]);
  const operatorModels = models.filter((x: any) => x.provider === JAIL_PROVIDER);
  const resolvedCatalog = JAIL_MODEL_IDS.map((id: string) => {
    const model = resolveModel(JAIL_PROVIDER, id);
    return { id: model.id, name: model.name, baseUrl: model.baseUrl };
  });
  const resolved = resolveModel(JAIL_PROVIDER, DEFAULT_JAIL_MODEL_ID);
  const fallback = resolveModel(JAIL_PROVIDER, "not-configured");
  let replay: Record<string, unknown> | null = null;
  if (jailAvailable()) {
    let request: { url: string; redirect: RequestRedirect | undefined; body: Record<string, unknown> } | null = null;
    globalThis.fetch = (async (input, init) => {
      request = {
        url: String(input),
        redirect: init?.redirect,
        body: JSON.parse(String(init?.body ?? "{}")),
      };
      return new Response(JSON.stringify({ output_text: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const { replayOperatorRequest } = await import("../server/src/runtime/replay.ts");
    const result = await replayOperatorRequest({ model: resolved.id, input: [], include: [] });
    replay = { ok: result.ok, request };
  }
  process.stdout.write(JSON.stringify({
    available: jailAvailable(),
    listed: operatorModels.length > 0,
    operatorModels: operatorModels.map((model: any) => ({ id: model.id, name: model.name })),
    resolvedCatalog,
    configuredIds: JAIL_MODEL_IDS,
    defaultId: models[0]?.id,
    defaultProvider: models[0]?.provider,
    resolvedId: resolved?.id,
    resolvedName: resolved?.name,
    resolvedBaseUrl: resolved?.baseUrl,
    fallbackId: fallback?.id,
    fallbackName: fallback?.name,
    key: apiKeyResolver("u_any")(JAIL_PROVIDER) ?? null,
    replay,
  }));
}

if (process.env.__JAIL_PROBE === "1") {
  await probe();
  process.exit(0);
}

function run(env: Record<string, string | undefined>): any {
  const r = spawnSync(process.execPath, ["--import", "tsx", SELF], {
    encoding: "utf8",
    env: { ...process.env, __JAIL_PROBE: "1", ...env },
  });
  if (r.status !== 0) throw new Error(`probe failed: ${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout.trim());
}

const CLEAN = {
  AGENT_WEB_JAIL_KEY: undefined,
  AGENT_WEB_JAIL_BASE_URL: undefined,
  AGENT_WEB_JAIL_API: undefined,
  AGENT_WEB_JAIL_MODEL: undefined,
  AGENT_WEB_JAIL_MODELS: undefined,
};

const on = run({
  ...CLEAN,
  AGENT_WEB_JAIL_KEY: "sk-test-operator-key",
  AGENT_WEB_JAIL_BASE_URL: "http://operator.internal:3000/v1",
});
assert.equal(on.available, true, "channel is available when KEY + BASE_URL are set");
assert.equal(on.listed, true, "operator model is listed when enabled");
assert.equal(on.defaultProvider, "0AI-jail", "operator channel is the global default provider");
assert.equal(on.defaultId, "operator-model-b", "Operator Model B is the global default model");
assert.equal(on.resolvedId, "operator-model-b");
assert.equal(on.resolvedName, "Operator Model B");
assert.equal(on.resolvedBaseUrl, "http://operator.internal:3000/v1", "base URL comes only from env");
assert.equal(on.fallbackId, "operator-model-b", "stale ids fall back to the configured operator model");
assert.equal(on.fallbackName, "Operator Model B");
assert.equal(on.key, "sk-test-operator-key", "resolver returns the operator env key");
assert.equal(on.replay?.ok, true, "admin replay uses the configured operator channel");
assert.equal(on.replay?.request?.url, "http://operator.internal:3000/v1/responses");
assert.equal(on.replay?.request?.redirect, "error", "replay rejects redirects");
assert.equal(on.replay?.request?.body?.stream, false);
assert.equal(on.replay?.request?.body?.prompt_cache_key, "oiia-admin-replay");
assert.deepEqual(on.replay?.request?.body?.include, ["reasoning.encrypted_content"]);
console.log("  OK enabled: 0AI-jail/Operator Model B is first + env-only endpoint/key + stale-id fallback");

const multi = run({
  ...CLEAN,
  AGENT_WEB_JAIL_KEY: "sk-test-operator-key",
  AGENT_WEB_JAIL_BASE_URL: "http://operator.internal:3000/v1",
  AGENT_WEB_JAIL_MODELS: "operator-model-a, operator-model  operator-model-b,operator-model-a",
});
assert.deepEqual(multi.configuredIds, ["operator-model-b", "operator-model-a", "operator-model"]);
assert.deepEqual(multi.operatorModels, [
  { id: "operator-model-b", name: "Operator Model B" },
  { id: "operator-model-a", name: "Operator Model A" },
  { id: "operator-model", name: "Operator Model" },
]);
assert.deepEqual(multi.resolvedCatalog, [
  { id: "operator-model-b", name: "Operator Model B", baseUrl: "http://operator.internal:3000/v1" },
  { id: "operator-model-a", name: "Operator Model A", baseUrl: "http://operator.internal:3000/v1" },
  { id: "operator-model", name: "Operator Model", baseUrl: "http://operator.internal:3000/v1" },
]);
console.log("  OK allowlist: Operator Model B remains first; Operator Model A and Operator Model stay selectable");

const override = run({
  ...CLEAN,
  AGENT_WEB_JAIL_KEY: "sk-test-operator-key",
  AGENT_WEB_JAIL_BASE_URL: "http://operator.internal:3000/v1",
  AGENT_WEB_JAIL_MODEL: "deployment-model",
  AGENT_WEB_JAIL_MODELS: "operator-model-a,operator-model-b",
});
assert.equal(override.defaultProvider, "0AI-jail");
assert.equal(override.defaultId, "deployment-model");
assert.equal(override.fallbackId, "deployment-model");
assert.deepEqual(override.configuredIds, ["deployment-model", "operator-model-a", "operator-model-b"]);
console.log("  OK override: deployment model remains the deterministic first/default entry");

const noUrl = run({ ...CLEAN, AGENT_WEB_JAIL_KEY: "sk-test-operator-key" });
assert.equal(noUrl.available, false, "channel is dormant without BASE_URL");
assert.equal(noUrl.listed, false);

const noKey = run({ ...CLEAN, AGENT_WEB_JAIL_BASE_URL: "http://operator.internal:3000/v1" });
assert.equal(noKey.available, false, "channel is dormant without KEY");
assert.equal(noKey.listed, false);
assert.equal(noKey.key, null, "operator provider never falls through to a user-stored key");
console.log("  OK dormant: KEY and BASE_URL are both mandatory");

console.log("OK jail-provider: one env-only 0AI-jail channel defaults to Operator Model B and supports an explicit model allowlist");
