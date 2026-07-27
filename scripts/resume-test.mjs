import { spawn } from "node:child_process";
import fs from "node:fs";

const PORT = 4399;
const DATA = "/tmp/agentweb-resume";
const SECRET = "resume-secret";
const B = `http://localhost:${PORT}`;

fs.rmSync(DATA, { recursive: true, force: true });

function startServer() {
  const child = spawn("npx", ["tsx", "server/src/index.ts"], {
    env: { ...process.env, PORT: String(PORT), AGENT_WEB_DATA_DIR: DATA, AGENT_WEB_SECRET: SECRET, AGENT_WEB_KEY_SECRET: SECRET },
    stdio: "ignore",
  });
  return child;
}
async function waitHealth() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(B + "/healthz");
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("server did not start");
}
async function kill(child) {
  child.kill("SIGKILL");
  await new Promise((r) => setTimeout(r, 500));
}
const j = async (m, p, b, t) => {
  const r = await fetch(B + p, {
    method: m,
    headers: { "content-type": "application/json", ...(t ? { authorization: "Bearer " + t } : {}) },
    body: b ? JSON.stringify(b) : undefined,
  });
  return r.json();
};
function runTurn(token, sid, text) {
  return new Promise(async (resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws?token=${token}`);
    await new Promise((r) => ws.addEventListener("open", r));
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.type === "agent_event" && (m.event.t === "turn_end" || m.event.t === "agent_end")) {
        ws.close();
        resolve();
      }
    });
    ws.send(JSON.stringify({ type: "subscribe", sessionId: sid }));
    ws.send(JSON.stringify({ type: "send_message", sessionId: sid, text }));
  });
}

let ok = true;
const assert = (cond, msg) => {
  console.log(cond ? "  ✓ " + msg : "  ✗ " + msg);
  if (!cond) ok = false;
};

let a = startServer();
await waitHealth();
const su = await j("POST", "/api/auth/signup", { email: `resume${Date.now()}@t.dev`, password: "password123" });
const token = su.token;
const cs = await j("POST", "/api/sessions", { title: "Resume", provider: "mock", model: "mock-coder", sandboxMode: "workspace-write", approvalPolicy: "never" }, token);
const sid = cs.session.id;
await runTurn(token, sid, "/write a.txt\nfirst turn");
const tlA = await j("GET", `/api/sessions/${sid}/timeline`, null, token);
console.log("Phase A timeline:", tlA.items.map((i) => i.kind).join(","));
assert(tlA.items.some((i) => i.kind === "tool" && i.status === "success"), "A: wrote a.txt (tool success)");
await kill(a);
console.log("— killed server A —");

let b = startServer();
await waitHealth();
const tlB = await j("GET", `/api/sessions/${sid}/timeline`, null, token);
console.log("Phase B timeline (after restart):", tlB.items.map((i) => i.kind).join(","));
assert(tlB.items.length === tlA.items.length, "B: timeline persisted across restart");
assert(tlB.items.some((i) => i.kind === "user" && i.text.includes("first turn")), "B: user message replayed");

await runTurn(token, sid, "/read a.txt");
const file = await j("GET", `/api/sessions/${sid}/file?path=a.txt`, null, token);
assert(file.content === "first turn", "B: file from phase A still in the sandbox");
const tlB2 = await j("GET", `/api/sessions/${sid}/timeline`, null, token);
const readTool = tlB2.items.find((i) => i.kind === "tool" && i.name === "read_file");
assert(readTool && readTool.status === "success" && readTool.resultText.includes("first turn"), "B: agent read phase-A file (transcript resumed)");
await kill(b);

console.log(ok ? "\n✅ RESUME PASS" : "\n❌ RESUME FAIL");
process.exit(ok ? 0 : 1);
