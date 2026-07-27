import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oiia-executor-availability-"));
process.env.AGENT_WEB_DATA_DIR = tmp;
process.env.AGENT_WEB_SECRET = "executor-check-fixed-secret-32chars";
process.env.AGENT_WEB_KEY_SECRET = "executor-check-fixed-secret-32chars";
process.env.AGENT_WEB_E2B_KEY = `e2b_${"0".repeat(40)}`;
process.env.AGENT_WEB_ALLOWED_EMAIL_DOMAINS = "*";
delete process.env.AGENT_WEB_ALLOW_UNCONFINED_LOCAL;

const availability = await import("../server/src/runtime/executor-availability.ts");
const { runtimeClient } = await import("../server/src/runtime/manager.ts");
const { registerMockProvider, MOCK_PROVIDER, MOCK_MODEL_ID } = await import("../server/src/runtime/providers.ts");
const { signup } = await import("../server/src/identity/auth.ts");
const { sessionDao } = await import("../server/src/persistence/index.ts");
const { E2BSandbox } = await import("../server/src/runtime/e2b-sandbox.ts");

registerMockProvider();

const providerCapacityError = new Error("403: team is blocked: missing payment method");
assert.equal(availability.isE2BCapacityError(providerCapacityError), true, "live E2B billing error must classify");
assert.equal(
  availability.isE2BCapacityError(new Error("insufficient credits to create sandbox")),
  true,
  "credit exhaustion must classify",
);
assert.equal(
  availability.isE2BCapacityError(new Error("Rate limit exceeded: The requests are being rate limited.")),
  false,
  "ordinary request throttling must not latch capacity closed",
);

delete process.env.AGENT_WEB_E2B_NEW_SESSION_DISABLED_REASON;
availability.resetObservedE2BCapacityFailureForTest();
assert.deepEqual(availability.executorAvailability(), {
  local: { available: false, reason: "policy_disabled" },
  e2b: { available: true },
});
assert.equal(availability.observeE2BCapacityError(providerCapacityError), true);
assert.deepEqual(availability.e2bExecutorStatus(), { available: false, reason: "capacity_unavailable" });
availability.resetObservedE2BCapacityFailureForTest();

process.env.AGENT_WEB_E2B_NEW_SESSION_DISABLED_REASON = "capacity";
assert.deepEqual(runtimeClient.getExecutorAvailability(), {
  local: { available: false, reason: "policy_disabled" },
  e2b: { available: false, reason: "capacity_unavailable" },
});

const user = await signup("executor-check@example.invalid", "password123");
const input = {
  title: "must not persist",
  provider: MOCK_PROVIDER,
  model: MOCK_MODEL_ID,
  sandboxMode: "workspace-write" as const,
  approvalPolicy: "never" as const,
};

assert.throws(
  () => runtimeClient.createSession(user, { ...input, sandboxKind: "e2b" }),
  /E2B cloud capacity is unavailable/,
  "explicit stale E2B request must fail closed",
);
assert.throws(
  () => runtimeClient.createSession(user, input),
  /E2B cloud capacity is unavailable/,
  "implicit local→E2B fallback must fail closed",
);
assert.equal(sessionDao.listForUser(user.id).length, 0, "refused sessions must not leave DB rows");

const sandbox = new E2BSandbox({ userId: user.id, mode: "workspace-write" }) as unknown as {
  acquire(): Promise<unknown>;
};
await assert.rejects(
  sandbox.acquire(),
  /E2B cloud capacity is unavailable/,
  "a legacy session with no sandbox id must not allocate behind the admission gate",
);

const connector = runtimeClient.connectorCreateToken(user.id, "test machine", "~/workspace");
const connectorSession = runtimeClient.createSession(user, {
  ...input,
  title: "connector works",
  sandboxKind: "connector",
  sandboxTargetId: connector.info.id,
});
assert.equal(connectorSession.sandboxKind, "connector");
assert.equal(connectorSession.sandboxTargetId, connector.info.id);

runtimeClient.connectorDelete(user.id, connector.info.id);
runtimeClient.deleteSession(user.id, connectorSession.id);
fs.rmSync(tmp, { recursive: true, force: true });
console.log("OK executor-availability: capacity gate + session admission + Connector fallback");
