import { lookup } from "node:dns/promises";
import net from "node:net";

export function isInternalIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const p = ip.split(".").map(Number);
    if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
    const [a, b] = p;
    if (a === 0) return true;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 192 && b === 0) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a >= 224) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase().replace(/^\[|\]$/g, "");
    if (x === "::1" || x === "::") return true;
    const m = x.match(/(?:::ffff:|::)(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return isInternalIp(m[1]);
    if (x.startsWith("fe8") || x.startsWith("fe9") || x.startsWith("fea") || x.startsWith("feb")) return true;
    if (x.startsWith("fc") || x.startsWith("fd")) return true;
    if (x.startsWith("ff")) return true;
    return false;
  }
  return true;
}

const ALLOW_INTERNAL = process.env.AGENT_WEB_SSH_ALLOW_INTERNAL === "1";

export async function resolveSafeSshHost(host: string): Promise<string> {
  const h = (host || "").trim();
  if (!h) throw new Error("ssh host is empty");

  if (net.isIP(h)) {
    if (!ALLOW_INTERNAL && isInternalIp(h)) {
      throw new Error(`refusing SSH to internal/reserved address ${h}`);
    }
    return h;
  }

  const results = await lookup(h, { all: true });
  if (results.length === 0) throw new Error(`cannot resolve SSH host ${h}`);
  if (!ALLOW_INTERNAL) {
    for (const r of results) {
      if (isInternalIp(r.address)) {
        throw new Error(`SSH host ${h} resolves to internal address ${r.address} — refused`);
      }
    }
  }
  return results[0].address;
}
