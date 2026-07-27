import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { DEFAULT_PRODUCT_NAME } from "../../shared/src/brand.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(__dirname, "..", "..");

export const DATA_DIR = process.env.AGENT_WEB_DATA_DIR
  ? path.resolve(process.env.AGENT_WEB_DATA_DIR)
  : path.join(ROOT, "data");

export const DB_PATH = path.join(DATA_DIR, "agent-web.db");
export const WORKSPACES_DIR = path.join(DATA_DIR, "workspaces");
export const WEB_DIST = process.env.AGENT_WEB_WEB_DIST
  ? path.resolve(process.env.AGENT_WEB_WEB_DIST)
  : path.join(ROOT, "web", "dist");

export const RUNTIME_SOCKET = (process.env.AGENT_WEB_RUNTIME_SOCKET ?? "").trim();

export const APP_VERSION = process.env.BUILD_VERSION || "dev";

let servedVersionCache: { mtimeMs: number; value: string } | null = null;
export function servedAppVersion(): string {
  const file = path.join(WEB_DIST, "version.txt");
  try {
    const mtimeMs = fs.statSync(file).mtimeMs;
    if (servedVersionCache?.mtimeMs === mtimeMs) return servedVersionCache.value;
    const v = fs.readFileSync(file, "utf8").trim();
    if (v) {
      servedVersionCache = { mtimeMs, value: v };
      return v;
    }
  } catch {  }
  return APP_VERSION;
}

function loadEmbeddedSecrets(): void {
  const candidates = ["secrets.dev.json", "secrets.json"].map((f) => path.join(DATA_DIR, f));
  const file = candidates.find((f) => fs.existsSync(f));
  if (!file) return;
  const secrets = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, string>;
  for (const [k, v] of Object.entries(secrets)) {
    if (process.env[k] === undefined && typeof v === "string") process.env[k] = v;
  }
}
loadEmbeddedSecrets();

if (process.env.AGENT_WEB_EXA_KEY && !process.env.EXA_API_KEY) process.env.EXA_API_KEY = process.env.AGENT_WEB_EXA_KEY;
if (process.env.AGENT_WEB_CONTEXT7_KEY && !process.env.CONTEXT7_API_KEY) process.env.CONTEXT7_API_KEY = process.env.AGENT_WEB_CONTEXT7_KEY;

const csvSet = (raw: string | undefined): Set<string> =>
  new Set((raw ?? "").split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean));

export const ADMIN_EMAILS = csvSet(process.env.AGENT_WEB_ADMIN_EMAILS);

export function isAdminEmail(email: string): boolean {
  return ADMIN_EMAILS.has(email.trim().toLowerCase());
}

export const CAPTURE_RAW = process.env.AGENT_WEB_CAPTURE_RAW === "1" || ADMIN_EMAILS.size > 0;

export const PORT = Number(process.env.PORT || 4317);

export const PRODUCT_NAME = process.env.AGENT_WEB_PRODUCT_NAME || DEFAULT_PRODUCT_NAME;

export const STATUS_HOST = (process.env.AGENT_WEB_STATUS_HOST || "").trim().toLowerCase();

function externalUrl(raw: string | undefined, protocols: ReadonlySet<string>): string {
  if (!raw?.trim()) return "";
  try {
    const url = new URL(raw.trim());
    return protocols.has(url.protocol) && !url.username && !url.password ? url.toString() : "";
  } catch {
    return "";
  }
}

export const STATUS_URL = externalUrl(
  process.env.AGENT_WEB_STATUS_URL || (STATUS_HOST ? `https://${STATUS_HOST}/` : ""),
  new Set(["http:", "https:"]),
);

export const SUPPORT_URL = externalUrl(process.env.AGENT_WEB_SUPPORT_URL, new Set(["https:", "mailto:"]));

export const GOOGLE_SITE_VERIFICATION_FILE = (() => {
  const raw = process.env.AGENT_WEB_GOOGLE_SITE_VERIFICATION?.trim() ?? "";
  const name = raw.endsWith(".html") ? raw : raw ? `${raw}.html` : "";
  return /^google[a-f0-9]{8,64}\.html$/i.test(name) ? name : "";
})();

export const LEGAL_CONTACT_EMAIL = (() => {
  const explicit = process.env.AGENT_WEB_LEGAL_CONTACT?.trim();
  if (explicit && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(explicit)) return explicit;
  if (SUPPORT_URL.startsWith("mailto:")) {
    const addr = SUPPORT_URL.slice("mailto:".length).split("?")[0];
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) return addr;
  }
  return "";
})();

export function parseHostRedirects(raw: string | undefined): ReadonlyMap<string, string> {
  const redirects = new Map<string, string>();
  if (!raw?.trim()) return redirects;
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return redirects;
  }
  if (!decoded || Array.isArray(decoded) || typeof decoded !== "object") return redirects;
  for (const [sourceRaw, targetRaw] of Object.entries(decoded)) {
    const source = sourceRaw.trim().toLowerCase();
    const validHost = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(source);
    if (!validHost || typeof targetRaw !== "string") continue;
    const target = externalUrl(targetRaw, new Set(["http:", "https:"]));
    if (!target) continue;
    const parsed = new URL(target);
    if (parsed.pathname !== "/" || parsed.search || parsed.hash) continue;
    redirects.set(source, parsed.origin);
  }
  return redirects;
}

export const HOST_REDIRECTS = parseHostRedirects(process.env.AGENT_WEB_HOST_REDIRECTS);

export const PUBLIC_URL = (process.env.AGENT_WEB_PUBLIC_URL || "").replace(/\/$/, "");
const TRUSTED_HOSTS = csvSet(process.env.AGENT_WEB_TRUSTED_HOSTS);
if (PUBLIC_URL) {
  try {
    TRUSTED_HOSTS.add(new URL(PUBLIC_URL).host.toLowerCase());
  } catch {
  }
}
export function publicOriginFor(proto: string, host: string | undefined): string {
  if (PUBLIC_URL) return PUBLIC_URL;
  const h = (host || "").toLowerCase();
  if (h && TRUSTED_HOSTS.has(h)) return `${proto}://${h}`;
  const first = TRUSTED_HOSTS.values().next().value;
  return first ? `https://${first}` : `${proto}://localhost:${process.env.PORT || 4317}`;
}

const IS_PROD = process.env.NODE_ENV === "production";

function resolveSecret(envName: string, purpose: string): string {
  const v = process.env[envName];
  if (v) return v;
  if (IS_PROD) throw new Error(`${envName} is required in production (${purpose}) — refusing to start on an insecure default`);
  return "dev-" + crypto.randomBytes(32).toString("hex");
}

export const JWT_SECRET = resolveSecret("AGENT_WEB_SECRET", "JWT signing");

export const KEY_ENC_SECRET = process.env.AGENT_WEB_KEY_SECRET || JWT_SECRET;

export function ensureDirs(): void {
  for (const d of [DATA_DIR, WORKSPACES_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

export interface McpServerConfig {
  id: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export function mcpServersFromEnv(): McpServerConfig[] {
  const raw = process.env.AGENT_WEB_MCP;
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((e) => e && typeof e.id === "string" && typeof e.command === "string")
      .filter((e: McpServerConfig) => {
        const isExa = e.id === "exa" || (e.args ?? []).some((a) => String(a).includes("exa-mcp-server"));
        return !isExa || Boolean(process.env.EXA_API_KEY);
      });
  } catch {
    return [];
  }
}
