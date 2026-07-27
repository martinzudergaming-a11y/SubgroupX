import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root })
  .toString("utf8")
  .split("\0")
  .filter(Boolean);

const violations: string[] = [];
const add = (file: string, reason: string, line?: number) =>
  violations.push(`${file}${line ? `:${line}` : ""}: ${reason}`);

const forbiddenNames = [
  /(^|\/)\.env(?:\.|$)/i,
  /(^|\/)(?:id_rsa|id_ed25519)(?:\.|$)/i,
  /(^|\/)(?:secrets?|credentials?)(?:\.[^.\/]+)?\.json$/i,
  /\.(?:pem|p12|pfx|key)$/i,
];
for (const file of tracked) {
  if (forbiddenNames.some((rx) => rx.test(file))) add(file, "secret-bearing filename must not be tracked");
}

const emailFixturePath = (file: string) =>
  /^(?:test\/|scripts\/(?:check-(?:access-gate|ban|client-log-intake|connector|email|google-auth|password-reset|verify)|backfill-canonical-email)|server\/src\/identity\/(?:auth|email-verify)\.ts|web\/src\/i18n\/|.*package-lock\.json$)/.test(file);
const credentialFixturePath = (file: string) =>
  /^(?:test\/|scripts\/check-|web\/src\/i18n\/)/.test(file);
const ipFixturePath = (file: string) =>
  /^(?:test\/|scripts\/check-ssh-guard\.mts$)/.test(file);
const reservedEmailDomain = (domain: string) =>
  domain === "example.com" || domain.endsWith(".example") || domain.endsWith(".invalid") ||
  domain.endsWith(".test") || domain === "test.dev" || domain === "e2e.dev" || domain === "agent.dev";
const allowedOrganizationEmailDomains = new Set(["subgroupx.dev"]);

const emailRx = /\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b/gi;
const homePathRx = /(?:file:\/\/)?\/(?:Users)\/[^\s"'`<>/]+\//;
const windowsHomeRx = /[A-Z]:\\Users\\[^\\\s"'`<>]+\\/i;
const machineNameRx = new RegExp("\\b[A-Z0-9._-]*(?:de)?Mac" + "Book(?:-[A-Z0-9._-]+)?\\b", "i");
const ipv4Rx = /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g;
const secretPatterns: Array<[RegExp, string]> = [
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/, "GitHub token-shaped literal"],
  [/\bsk-(?:proj-|ant-|live-)?[A-Za-z0-9_-]{20,}\b/, "provider key-shaped literal"],
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS access-key-shaped literal"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, "Google API-key-shaped literal"],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/, "JWT-shaped literal"],
  [/-----BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY-----/, "private-key block"],
];

function reservedOrNonPublicIp(value: string): boolean {
  if (net.isIP(value) !== 4) return true;
  const [a, b, c] = value.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113);
}

const deploymentSurface = new Set([
  "docs/DEPLOY.md",
  "scripts/deploy.sh",
  "server/src/config.ts",
  "server/src/index.ts",
  "web/src/auth/Suspended.tsx",
  "web/src/dashboard/shell/LeftSidebar.tsx",
]);
const publicDomainRx = /\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|top|dev|ai|cn|co|me|app|cloud)\b/gi;
const allowedDeploymentDomains = new Set([
  "ghcr.io",
  "github.com",
  "oiia.cauchy.top",
  "subgroupx.dev",
]);
assert.ok(allowedDeploymentDomains.has("oiia.cauchy.top"));
assert.ok(allowedOrganizationEmailDomains.has("subgroupx.dev"));
assert.ok(!allowedDeploymentDomains.has(`status.${"oiia.cauchy.top"}`), "domain allowlist must stay exact");

for (const file of tracked) {
  const abs = path.join(root, file);
  const st = fs.statSync(abs);
  if (!st.isFile() || st.size > 25 * 1024 * 1024) continue;
  const buf = fs.readFileSync(abs);
  const text = buf.toString("utf8") + (buf.includes(0) ? "\n" + buf.toString("latin1") : "");
  const lines = text.split(/\r?\n/);

  for (const match of text.matchAll(emailRx)) {
    const domain = match[1]!.toLowerCase();
    if (
      !reservedEmailDomain(domain) &&
      !allowedOrganizationEmailDomains.has(domain) &&
      !emailFixturePath(file)
    ) {
      add(file, `non-fixture email literal (${domain})`);
    }
  }
  if (homePathRx.test(text) || windowsHomeRx.test(text)) add(file, "contributor-specific home path");
  if (machineNameRx.test(text)) add(file, "contributor-specific machine name");
  const ipScanText = text.replace(/<path\b[^>]*\bd="[^"]*"[^>]*>/gi, "");
  for (const match of ipScanText.matchAll(ipv4Rx)) {
    if (!ipFixturePath(file) && !reservedOrNonPublicIp(match[0])) add(file, `public IPv4 literal (${match[0]})`);
  }
  if (!credentialFixturePath(file)) {
    for (const [rx, label] of secretPatterns) if (rx.test(text)) add(file, label);
  }
  if (deploymentSurface.has(file)) {
    const domainScanText = text.replace(/\b[\w.-]+\.(?:ts|tsx|mts|mjs|js|json|md|sh|sock)\b/gi, "");
    for (const match of domainScanText.matchAll(publicDomainRx)) {
      const domain = match[0].toLowerCase();
      if (!allowedDeploymentDomains.has(domain)) add(file, `deployment-specific public domain (${domain})`);
    }
  }

  if (/\.(?:ts|tsx|mts|mjs|js|jsx|sh|yml|yaml|md)$/.test(file)) {
    lines.forEach((line, index) => {
      if (!file.endsWith(".md") && !/^\s*(?:(?:\/\/|#|\/\*|\*)\s*)/.test(line)) return;
      if (/\b(?:prod(?:uction)?\s+(?:logs?|bisect|incident)|real prod|escape under investigation)\b/i.test(line)) {
        add(file, "comment contains incident-specific production detail", index + 1);
      }
      if (/(?:incident|prod(?:uction)?|observed|compromis).*\b20\d{2}-\d{2}/i.test(line)) {
        add(file, "comment couples operational detail to a dated incident", index + 1);
      }
    });
  }
}

if (violations.length) {
  console.error(violations.join("\n"));
  console.error(`\n${violations.length} repository sanitization violation(s)`);
  process.exit(1);
}
assert.ok(tracked.length > 0);
console.log(`repository sanitization check passed (${tracked.length} tracked files)`);
console.log("note: OCR review remains mandatory for changed raster/video artifacts");
