import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oiia-status-check-"));
process.env.AGENT_WEB_DATA_DIR = tmp;
process.env.AGENT_WEB_STATUS_HOST = "status.test";
process.env.AGENT_WEB_JAIL_KEY = "test-key-for-probe";
process.env.AGENT_WEB_JAIL_BASE_URL = "http://operator.test/v1";

let server: http.Server | null = null;
try {
  const { recordTurnPerf, aggregatePerf } = await import("../server/src/status/perf.ts");
  const { evaluateIncident, COMPONENTS, probeApi } = await import("../server/src/status/prober.ts");
  const { createStatusRouter } = await import("../server/src/status/status-router.ts");
  const { probeModelApi } = await import("../server/src/status/api-probe.ts");
  const { statusSampleDao, statusIncidentDao, db } = await import("../server/src/persistence/index.ts");
  const { parseHostRedirects } = await import("../server/src/config.ts");
  const express = (await import("express")).default;

  const redirects = parseHostRedirects(JSON.stringify({
    "retired.test": "https://app.test/",
    "bad path": "https://ignored.test/",
    "bad?.test": "https://ignored.test/",
    "bad-scheme.test": "javascript:alert(1)",
    "path-target.test": "https://ignored.test/base",
    "credentials.test": "https://user:password@ignored.test/",
  }));
  assert.equal(redirects.get("retired.test"), "https://app.test", "valid host redirect is normalized to an origin");
  assert.equal(redirects.size, 1, "malformed host redirects fail closed");
  assert.equal(parseHostRedirects("not-json").size, 0, "invalid redirect JSON fails closed");
  console.log("  OK deployment host redirects (validated + fail-closed)");

  recordTurnPerf({ provider: "gw", model: "operator-model", ttftMs: 100, totalMs: 1000, ok: true });
  recordTurnPerf({ provider: "gw", model: "operator-model", ttftMs: 300, totalMs: 3000, ok: true });
  recordTurnPerf({ provider: "gw", model: "operator-model", ttftMs: null, totalMs: 5000, ok: true });
  recordTurnPerf({ provider: "gw", model: "operator-model", ttftMs: null, totalMs: null, ok: false });
  const rep = aggregatePerf(60_000);
  assert.equal(rep.totalTurns, 4, "all 4 turns counted");
  assert.ok(Math.abs(rep.errorRate - 0.25) < 1e-9, "error rate 1/4");
  const m = rep.models[0];
  assert.equal(m.model, "operator-model");
  assert.equal(m.ttftP50, 200, "TTFT p50 of [100,300] = 200 (null/err excluded)");
  assert.equal(m.ttftP95, 290, "TTFT p95 of [100,300]");
  assert.ok(m.totalP50 != null, "latency p50 present");
  console.log("  OK perf aggregation (percentiles + exclusion + error rate)");

  assert.equal(probeApi().ok, true, "API operational below min sample size (no low-traffic false outage)");
  for (let i = 0; i < 4; i++) recordTurnPerf({ provider: "gw", model: "operator-model", ttftMs: null, totalMs: 10, ok: false });
  assert.equal(probeApi().ok, false, "API marked down once error rate is high AND samples are sufficient");
  console.log("  OK API status low-traffic guard (min sample size before degrade)");

  const realFetch = globalThis.fetch;
  let probePayload: Record<string, unknown> | null = null;
  const sse = [
    'data: {"type":"response.created"}',
    'data: {"type":"response.in_progress"}',
    'data: {"type":"response.output_text.delta","delta":"ok"}',
    'data: {"type":"response.output_text.done","text":"ok"}',
    'data: {"type":"response.completed"}',
    "",
  ].join("\n");
  globalThis.fetch = (async (_input, init) => {
    probePayload = JSON.parse(String(init?.body ?? "{}"));
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  const okProbe = await probeModelApi();
  assert.ok(okProbe && okProbe.ok === true, "synthetic probe ok on a completed stream with text");
  assert.ok(okProbe!.ttftMs !== null, "synthetic probe captures TTFT from first output_text.delta");
  assert.equal(probePayload?.model, "operator-model-b", "synthetic probe follows the operator default model");
  assert.deepEqual(
    probePayload?.input,
    [{ role: "user", content: [{ type: "input_text", text: "Reply with exactly: ok" }] }],
    "synthetic probe uses the upstream-compatible Responses input shape",
  );
  assert.equal(probePayload?.prompt_cache_key, "oiia-status-probe", "synthetic probe sends the stable cache key");
  assert.deepEqual(probePayload?.include, ["reasoning.encrypted_content"], "synthetic probe requests encrypted reasoning compatibility data");
  const sseNoNL =
    'data: {"type":"response.output_text.delta","delta":"ok"}\ndata: {"type":"response.completed"}';
  globalThis.fetch = (async () =>
    new Response(sseNoNL, { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch;
  const noNlProbe = await probeModelApi();
  assert.ok(noNlProbe && noNlProbe.ok === true, "synthetic probe parses a final line lacking a trailing newline (EOF flush)");
  let openBodyCancelled = false;
  globalThis.fetch = (async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            'data: {"type":"response.output_text.delta","delta":"ok"}\n' +
            'data: {"type":"response.completed"}\n\n',
          ));
        },
        cancel() {
          openBodyCancelled = true;
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )) as typeof fetch;
  const openBodyStarted = performance.now();
  const openBodyProbe = await probeModelApi();
  assert.ok(openBodyProbe?.ok, "response.completed settles even while the HTTP body remains open");
  assert.ok(performance.now() - openBodyStarted < 250, "terminal-event settlement does not wait for transport EOF");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(openBodyCancelled, true, "completed probe cancels the idle response body");
  globalThis.fetch = (async () => new Response("nope", { status: 500 })) as typeof fetch;
  const badProbe = await probeModelApi();
  assert.ok(badProbe && badProbe.ok === false, "synthetic probe fails on a non-200 response");
  globalThis.fetch = realFetch;
  console.log("  OK synthetic Model-API probe (SSE TTFT + terminal-event settlement + failure handling)");

  const web = COMPONENTS.find((c) => c.key === "web")!;
  const mkSample = (ok: number, ts: number) =>
    statusSampleDao.add({ id: "s_" + ts + "_" + Math.random(), ts, component: "web", ok, latency_ms: 1, detail_json: "{}" });
  let t = Date.now();
  mkSample(0, (t += 1000)); evaluateIncident(web, t);
  assert.equal(statusIncidentDao.openFor("web"), null, "1 failure must NOT open an incident");
  mkSample(0, (t += 1000)); evaluateIncident(web, t);
  assert.equal(statusIncidentDao.openFor("web"), null, "2 failures must NOT open an incident");
  mkSample(0, (t += 1000)); evaluateIncident(web, t);
  const opened = statusIncidentDao.openFor("web");
  assert.ok(opened, "3 consecutive failures MUST open an incident");
  assert.equal(opened!.severity, "major", "web is critical → major");
  mkSample(1, (t += 1000)); evaluateIncident(web, t);
  assert.ok(statusIncidentDao.openFor("web"), "1 success must NOT resolve");
  mkSample(1, (t += 1000)); evaluateIncident(web, t);
  assert.equal(statusIncidentDao.openFor("web"), null, "2 consecutive successes MUST resolve");
  console.log("  OK incident open (3 fails) + resolve (2 successes)");

  const app = express();
  app.set("trust proxy", true);
  const statusRouter = createStatusRouter();
  const STATUS_HOST = "status.test";
  app.use((req, res, next) => {
    const host = (req.headers.host || "").split(":")[0].toLowerCase();
    if (host !== STATUS_HOST) return next();
    statusRouter(req, res, (err?: unknown) => {
      if (err) return next(err);
      if (!res.headersSent) res.status(404).type("text/plain").send("Not found");
    });
  });
  app.post("/api/sessions", (_req, res) => res.json({ leaked: true }));
  app.get("/", (_req, res) => res.type("text").send("MAIN-APP"));

  server = http.createServer(app);
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const req = (p: string, headers: Record<string, string>, method = "GET") =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const rq = http.request(base + p, { method, headers }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      });
      rq.on("error", reject);
      rq.end();
    });

  const ui = await req("/", { host: "status.test" });
  assert.ok(ui.body.includes("System Status"), "status host serves the status UI");
  const sum = await req("/api/status/summary", { host: "status.test" });
  const summary = JSON.parse(sum.body);
  assert.ok(summary.overall && Array.isArray(summary.components), "summary JSON shape");
  assert.equal(summary.components.length, COMPONENTS.length, "all components present");

  const leak = await req("/api/sessions", { host: "status.test" }, "POST");
  assert.equal(leak.status, 404, "status host must NOT fall through to app routes (404)");
  assert.ok(!leak.body.includes("leaked"), "app route must be unreachable on the status host");

  const mainHome = await req("/", { host: "app.test" });
  assert.equal(mainHome.body, "MAIN-APP", "main host reaches the app");
  const noStatusApi = await req("/api/status/summary", { host: "app.test" });
  assert.equal(noStatusApi.status, 404, "status API is not exposed on the main host");

  const spoof = await req("/", { host: "app.test", "x-forwarded-host": "status.test" });
  assert.equal(spoof.body, "MAIN-APP", "X-Forwarded-Host spoof must not flip routing");
  console.log("  OK host isolation + X-Forwarded-Host spoof-resistance");

  server.close();
  server = null;
  db.close();
  console.log("all status checks passed");
} finally {
  server?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
