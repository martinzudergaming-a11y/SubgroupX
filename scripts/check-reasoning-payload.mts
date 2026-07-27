process.env.AGENT_WEB_JAIL_BASE_URL = "http://operator.test/v1";
process.env.AGENT_WEB_JAIL_MODEL = "operator-model";
process.env.AGENT_WEB_JAIL_MODEL_LEVELS = "operator-model=xhigh,max";

const { JAIL_PROVIDER, resolveModel } = await import("../server/src/runtime/providers.ts");
import { streamSimple } from "@earendil-works/pi-ai/compat";

const model = resolveModel(JAIL_PROVIDER, "operator-model");
const levels = ["low", "medium", "high", "xhigh", "max"] as const;
let failed = false;

for (const level of levels) {
  let payload: any = null;
  const ctx = { messages: [{ role: "user" as const, content: "ping", timestamp: Date.now() }] };
  const ev = streamSimple(model, ctx, {
    apiKey: "sk-no-network",
    reasoning: level,
    onPayload: (p: any) => { payload = p; throw new Error("__captured__"); },
  } as any);
  try { for await (const _ of ev) {  } } catch {  }
  const effort = payload?.reasoning?.effort;
  const ok = effort === level;
  if (!ok) failed = true;
  console.log(`${ok ? "✓" : "✗"} thinking "${level}" → reasoning.effort=${JSON.stringify(effort)}`);
}

if (failed) {
  console.error("\nFAIL: a thinking level did not map to the matching reasoning.effort.");
  process.exit(1);
}
console.log("\nOK: every thinking level is transmitted to the model as reasoning.effort.");
