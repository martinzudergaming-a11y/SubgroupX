type Store = "local" | "session";
function store(kind: Store): Storage | null {
  try {
    const s = kind === "local" ? globalThis.localStorage : globalThis.sessionStorage;
    return s ?? null;
  } catch { return null; }
}
export function safeGet(key: string, kind: Store = "local"): string | null {
  try {
    const s = store(kind);
    if (!s) return null;
    const v = s.getItem(key);
    if (v !== null) return v;
    if (key.startsWith("oiia.")) {
      const legacy = s.getItem(`o11n.${key.slice(5)}`);
      if (legacy !== null) {
        s.setItem(key, legacy);
        s.removeItem(`o11n.${key.slice(5)}`);
        return legacy;
      }
    }
    return null;
  } catch { return null; }
}
export function safeSet(key: string, value: string, kind: Store = "local"): void {
  try { store(kind)?.setItem(key, value); } catch {  }
}
export function safeRemove(key: string, kind: Store = "local"): void {
  try { store(kind)?.removeItem(key); } catch {  }
}
