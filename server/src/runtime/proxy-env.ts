const PROXY_URL_RE = /^(https?|socks4|socks5|socks5h):\/\/[^\s]+$/i;

export function proxyEnv(proxyUrl?: string | null): Record<string, string> {
  const url = (proxyUrl ?? "").trim();
  if (!url || !PROXY_URL_RE.test(url)) return {};
  const noProxy = "localhost,127.0.0.1,::1";
  return {
    HTTP_PROXY: url, HTTPS_PROXY: url, ALL_PROXY: url,
    http_proxy: url, https_proxy: url, all_proxy: url,
    NO_PROXY: noProxy, no_proxy: noProxy,
  };
}

export function effectiveProxy(proxyUrl?: string | null, jumpServer?: string | null): string | null {
  const p = (proxyUrl ?? "").trim();
  if (p && PROXY_URL_RE.test(p)) return p;
  const j = (jumpServer ?? "").trim();
  if (j && PROXY_URL_RE.test(j)) return j;
  return null;
}

export function evalEgress(
  proxyUrl?: string | null,
  jumpServer?: string | null,
): { state: "direct" | "proxy" | "proxy_invalid" | "jump_only"; detail: string | null } {
  const p = (proxyUrl ?? "").trim();
  const j = (jumpServer ?? "").trim();
  const applied = effectiveProxy(p, j);
  if (applied) return { state: "proxy", detail: applied };
  if (p) return { state: "proxy_invalid", detail: p };
  if (j) return { state: "jump_only", detail: j };
  return { state: "direct", detail: null };
}
