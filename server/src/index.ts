import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import { proxyConnectorUpgrade } from "./transport/connector-proxy.ts";
import { PORT, WEB_DIST, ensureDirs, RUNTIME_SOCKET, PRODUCT_NAME, servedAppVersion } from "./config.ts";
import { createApiRouter } from "./http/api.ts";
import { shareDao, teamTaskDao } from "./persistence/index.ts";
import { htmlEscape } from "./sharing/redact.ts";
import { createWebSocketServer } from "./transport/ws-server.ts";
import { tuneOutboundFetch } from "./transport/outbound-fetch.ts";

tuneOutboundFetch();
import { createPtyServer } from "./transport/pty-server.ts";
import { startWsHeartbeat, BROWSER_HEARTBEAT_MS } from "./transport/ws-util.ts";
import { connectorManager } from "./runtime/connector-manager.ts";
import { sessionManager } from "./runtime/manager.ts";
import { registerMockProvider } from "./runtime/providers.ts";
import { hardenSharedDataPaths } from "./runtime/sandbox.ts";
import { recoverInterruptedSessions } from "./runtime/recovery.ts";
import { startScheduler } from "./automations/scheduler.ts";
import { startDreaming } from "./runtime/memory-dreaming.ts";
import { startRuntimeTaskDispatcher } from "./orchestration/runtime-task-dispatcher.ts";
import { startWorkflowScheduler } from "./orchestration/workflow-scheduler.ts";
import { runtimeDrainState } from "./runtime/runtime-drain-state.ts";
import { auditPrune, logAudit } from "./observability/audit-log.ts";
import { GOOGLE_SITE_VERIFICATION_FILE, HOST_REDIRECTS, STATUS_HOST, STATUS_URL, SUPPORT_URL, publicOriginFor } from "./config.ts";
import { privacyPolicyHtml, termsOfServiceHtml } from "./http/legal-pages.ts";
import { createStatusRouter } from "./status/status-router.ts";
import { startStatusProber } from "./status/prober.ts";
import { startApiProbe } from "./status/api-probe.ts";

ensureDirs();
hardenSharedDataPaths();
registerMockProvider();
if (!RUNTIME_SOCKET) {
  recoverInterruptedSessions();
  sessionManager.reconcileTeamProvisioning(4_000);
  teamTaskDao.recoverAfterRestart(Date.now(), `boot-team-${process.pid}`);
  startRuntimeTaskDispatcher(sessionManager);
  startWorkflowScheduler(sessionManager);
}
auditPrune(true);
if (!RUNTIME_SOCKET) startScheduler();
if (!RUNTIME_SOCKET) startDreaming();
startStatusProber();
startApiProbe();

const app = express();
app.disable("x-powered-by");
if (process.env.AGENT_WEB_TRUST_PROXY) {
  app.set("trust proxy", Number(process.env.AGENT_WEB_TRUST_PROXY) || true);
}

app.use((req, res, next) => {
  const host = (req.headers.host || "").split(":")[0].toLowerCase();
  const target = HOST_REDIRECTS.get(host);
  if (target) return res.redirect(301, target + req.originalUrl);
  next();
});

const statusRouter = createStatusRouter();
app.use((req, res, next) => {
  const host = (req.headers.host || "").split(":")[0].toLowerCase();
  if (host !== STATUS_HOST) return next();
  statusRouter(req, res, (err?: unknown) => {
    if (err) return next(err);
    if (!res.headersSent) res.status(404).type("text/plain").send("Not found");
  });
});

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

app.get("/status", (_req, res) => {
  if (!STATUS_URL) return res.status(404).type("text/plain").send("Status page is not configured");
  return res.redirect(302, STATUS_URL);
});
app.get("/support", (_req, res) => {
  if (!SUPPORT_URL) return res.status(404).type("text/plain").send("Support contact is not configured");
  return res.redirect(302, SUPPORT_URL);
});

if (GOOGLE_SITE_VERIFICATION_FILE) {
  app.get(`/${GOOGLE_SITE_VERIFICATION_FILE}`, (_req, res) => {
    res.type("text/plain").send(`google-site-verification: ${GOOGLE_SITE_VERIFICATION_FILE}`);
  });
}

app.get("/privacy", (req, res) => {
  res.set("Cache-Control", "public, max-age=3600").type("html").send(privacyPolicyHtml(shareOrigin(req)));
});
app.get("/terms", (req, res) => {
  res.set("Cache-Control", "public, max-age=3600").type("html").send(termsOfServiceHtml(shareOrigin(req)));
});

app.use("/api", createApiRouter());

const SHARE_SHELL_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="robots" content="noindex,nofollow,noarchive,nosnippet,noimageindex" />
    <title>Shared transcript</title>
  </head>
  <body>
    <div id="root"></div>
    <noscript>This shared transcript requires JavaScript to view.</noscript>
  </body>
</html>`;

app.get("/robots.txt", (_req, res) => {
  res.type("text/plain").send("User-agent: *\nDisallow:\n");
});

app.get("/version.txt", (_req, res) => {
  res.set("Cache-Control", "no-store, must-revalidate").type("text/plain").send(servedAppVersion());
});

const SHARE_DIST_HTML = path.join(WEB_DIST, "share.html");

const SHARE_TOKEN_RE = /^[A-Za-z0-9_-]{16,43}$/;
const SHARE_OG_DESC = "A shared conversation transcript on oiia.";

function shareOrigin(req: express.Request): string {
  return publicOriginFor(req.protocol, req.get("host"));
}

function readHtmlShell(file: string, fallback: string, cache: { text: string | null; mtimeMs: number }): string {
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    return cache.text ?? fallback;
  }
  if (cache.text === null || cache.mtimeMs !== mtimeMs) {
    try {
      cache.text = fs.readFileSync(file, "utf8");
      cache.mtimeMs = mtimeMs;
    } catch {
      return cache.text ?? fallback;
    }
  }
  return cache.text;
}

const shareHtmlCache = { text: null as string | null, mtimeMs: 0 };
function shareHtmlTemplate(): string {
  return readHtmlShell(SHARE_DIST_HTML, SHARE_SHELL_HTML, shareHtmlCache);
}

function buildShareDesc(metaJson: string | null | undefined): string {
  try {
    const m = JSON.parse(metaJson || "{}") as { itemCount?: number; modelName?: string; model?: string; createdAt?: number };
    const parts: string[] = [];
    if (typeof m.itemCount === "number" && m.itemCount > 0) parts.push(`${m.itemCount} message${m.itemCount === 1 ? "" : "s"}`);
    const model = m.modelName || m.model;
    if (typeof model === "string" && model) parts.push(model);
    if (typeof m.createdAt === "number" && m.createdAt > 0) {
      parts.push(`shared ${new Date(m.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`);
    }
    return parts.length ? parts.join(" · ") : SHARE_OG_DESC;
  } catch {
    return SHARE_OG_DESC;
  }
}

function buildShareOgTags(req: express.Request, token: string | null, escapedTitle: string | null, escapedDesc: string): string {
  const origin = shareOrigin(req);
  const img = `${origin}/og-card.png`;
  const url = token ? `${origin}/share/${token}` : `${origin}/share`;
  const title = escapedTitle ? `${escapedTitle} · oiia` : "Shared conversation · oiia";
  return [
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="oiia" />`,
    `<meta property="og:title" content="${title}" />`,
    `<meta property="og:description" content="${escapedDesc}" />`,
    `<meta property="og:image" content="${img}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta property="og:url" content="${url}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${title}" />`,
    `<meta name="twitter:description" content="${escapedDesc}" />`,
    `<meta name="twitter:image" content="${img}" />`,
  ].join("\n    ");
}

const shareHtmlHits = new Map<string, number>();
let shareHtmlWindowStart = 0;
function shareHtmlRateLimited(ip: string): boolean {
  const now = Date.now();
  if (now - shareHtmlWindowStart > 60_000) {
    shareHtmlHits.clear();
    shareHtmlWindowStart = now;
  }
  const n = (shareHtmlHits.get(ip) ?? 0) + 1;
  shareHtmlHits.set(ip, n);
  return n > 240;
}

app.get(/^\/share(\/|$)/, (req, res) => {
  res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive, nosnippet, noimageindex");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
  if (shareHtmlRateLimited(req.ip ?? "")) {
    res.status(429).type("text/plain").send("Too many requests");
    return;
  }
  const m = req.path.match(/^\/share\/([^/]+)/);
  const token = m && SHARE_TOKEN_RE.test(m[1]) ? m[1] : null;
  let escapedTitle: string | null = null;
  let escapedDesc = htmlEscape(SHARE_OG_DESC);
  if (token) {
    const row = shareDao.byToken(token);
    if (row && !row.revoked_at && row.title) {
      escapedTitle = htmlEscape(row.title);
      escapedDesc = htmlEscape(buildShareDesc(row.meta_json));
    }
  }
  const og = buildShareOgTags(req, token, escapedTitle, escapedDesc);
  const html = shareHtmlTemplate().replace("</head>", () => `    ${og}\n  </head>`);
  res.type("html").send(html);
});

const homeHtmlCache = { text: null as string | null, mtimeMs: 0 };
function homeHtmlWithOg(req: express.Request): string {
  const shell = readHtmlShell(path.join(WEB_DIST, "index.html"), "", homeHtmlCache);
  const origin = publicOriginFor(req.protocol, req.get("host"));
  const name = htmlEscape(PRODUCT_NAME);
  const title = `${name} · the agent runs in the cloud, the work runs on your machine`;
  const desc = htmlEscape(
    "Hosted agent sessions that execute wherever you point them — a cloud sandbox, a host over SSH, " +
      "or a machine with no public IP at all. Run many agents at once, and keep the session when the tab dies.",
  );
  const tags = [
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="${name}" />`,
    `<meta property="og:title" content="${title}" />`,
    `<meta property="og:description" content="${desc}" />`,
    `<meta property="og:image" content="${origin}/og-home.png" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta property="og:url" content="${origin}/" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${title}" />`,
    `<meta name="twitter:description" content="${desc}" />`,
    `<meta name="twitter:image" content="${origin}/og-home.png" />`,
    `<meta name="description" content="${desc}" />`,
  ].join("\n    ");
  return shell.replace("</head>", `  ${tags}\n  </head>`);
}

if (fs.existsSync(WEB_DIST)) {
  app.get("/", (req, res) => {
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.type("html").send(homeHtmlWithOg(req));
  });
  app.use(
    express.static(WEB_DIST, {
      setHeaders: (res, filePath) => {
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        } else {
          res.setHeader("Cache-Control", "no-cache");
          res.setHeader("Referrer-Policy", "no-referrer");
        }
      },
    }),
  );
  app.get(/^(?!\/(api|ws|pty|healthz|share|robots\.txt|privacy|terms|support|status)).*/, (_req, res) => {
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.sendFile(path.join(WEB_DIST, "index.html"));
  });
} else {
  app.get("/", (_req, res) => {
    res.type("text").send(`${PRODUCT_NAME} server is running. Build the web app with \`npm run build:web\`.`);
  });
}

const server = http.createServer(app);

server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

const wsServer = createWebSocketServer();
const ptyServer = createPtyServer();
startWsHeartbeat(wsServer, BROWSER_HEARTBEAT_MS);
startWsHeartbeat(ptyServer, BROWSER_HEARTBEAT_MS);
const connectorServer = RUNTIME_SOCKET ? null : connectorManager.createServer();
server.on("upgrade", (req, socket, head) => {
  const { pathname } = new URL(req.url ?? "/", "http://localhost");
  if (pathname === "/ws") {
    wsServer.handleUpgrade(req, socket, head, (ws) => wsServer.emit("connection", ws, req));
  } else if (pathname === "/pty") {
    ptyServer.handleUpgrade(req, socket, head, (ws) => ptyServer.emit("connection", ws, req));
  } else if (pathname === "/connector" && connectorServer) {
    connectorServer.handleUpgrade(req, socket, head, (ws) => connectorServer.emit("connection", ws, req));
  } else if (pathname === "/connector" && RUNTIME_SOCKET) {
    proxyConnectorUpgrade(req, socket, head, RUNTIME_SOCKET);
  } else {
    socket.destroy();
  }
});

server.listen(PORT, () => {
  runtimeDrainState.start();
  logAudit("server_start", { data: { port: PORT, webDist: fs.existsSync(WEB_DIST), version: process.env.BUILD_VERSION || "dev" } });
  console.log(`[${PRODUCT_NAME}] server listening on http://localhost:${PORT}`);
  console.log(`[${PRODUCT_NAME}] web dist ${fs.existsSync(WEB_DIST) ? "served" : "NOT built yet"} from ${WEB_DIST}`);
});

let shuttingDown = false;
async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    console.warn(`[${PRODUCT_NAME}] ${signal} again during shutdown — forcing exit`);
    process.exit(1);
  }
  shuttingDown = true;
  if (RUNTIME_SOCKET) {
    runtimeDrainState.stop();
    logAudit("server_draining", { data: { signal, split: true } });
    console.log(`[${PRODUCT_NAME}] ${signal}: web tier shutting down (split mode — not draining the runtime)`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref?.();
    return;
  }
  sessionManager.setDraining();
  runtimeDrainState.stop();
  logAudit("server_draining", { data: { signal } });
  console.log(`[${PRODUCT_NAME}] ${signal}: draining in-flight agent turns before exit…`);
  const force = setTimeout(() => {
    console.warn(`[${PRODUCT_NAME}] drain deadline exceeded — forcing exit`);
    process.exit(0);
  }, 58_000);
  force.unref?.();
  try {
    const { finished, interrupted } = await sessionManager.drainTurns({ waitMs: 50_000, settleMs: 5_000 });
    console.log(`[${PRODUCT_NAME}] drained turns: ${finished} finished, ${interrupted} interrupted`);
  } catch (e) {
    console.error(`[${PRODUCT_NAME}] drain error:`, e instanceof Error ? e.message : e);
  }
  clearTimeout(force);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref?.();
}
process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => void gracefulShutdown("SIGINT"));

process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason instanceof Error ? (reason.stack ?? reason.message) : reason);
});
