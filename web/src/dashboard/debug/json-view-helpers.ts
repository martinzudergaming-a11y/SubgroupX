export type TokKind = "key" | "string" | "number" | "boolean" | "null" | "punct" | "plain";
export interface Tok {
  text: string;
  kind: TokKind;
}

const TOKEN_RE = /("(?:\\.|[^"\\])*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false)\b|\b(null)\b|([{}[\],:])/g;

export function tokenizeLine(line: string): Tok[] {
  const toks: Tok[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(line)) !== null) {
    if (m.index > last) toks.push({ text: line.slice(last, m.index), kind: "plain" });
    if (m[1] !== undefined) {
      const rest = line.slice(TOKEN_RE.lastIndex);
      const isKey = /^\s*:/.test(rest);
      toks.push({ text: m[1], kind: isKey ? "key" : "string" });
    } else if (m[2] !== undefined) {
      toks.push({ text: m[2], kind: "number" });
    } else if (m[3] !== undefined) {
      toks.push({ text: m[3], kind: "boolean" });
    } else if (m[4] !== undefined) {
      toks.push({ text: m[4], kind: "null" });
    } else if (m[5] !== undefined) {
      toks.push({ text: m[5], kind: "punct" });
    }
    last = TOKEN_RE.lastIndex;
  }
  if (last < line.length) toks.push({ text: line.slice(last), kind: "plain" });
  return toks;
}

export const KIND_CLASS: Record<TokKind, string> = {
  key: "text-[#2B6CB0] dark:text-[#7FB2F0]",
  string: "text-[#1A7F5A] dark:text-[#7FD0A8]",
  number: "text-[#9B5BBd] dark:text-[#C99CE8]",
  boolean: "text-[#B7791F] dark:text-[#E0B86B]",
  null: "text-[#B7791F] dark:text-[#E0B86B]",
  punct: "text-[#8A8A8A] dark:text-[#7A7A7A]",
  plain: "text-[#444] dark:text-[#CFCFCF]",
};

export function prettyOf(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "null";
  } catch {
    return String(value);
  }
}

export function primitiveClass(v: unknown): string {
  if (typeof v === "string") return KIND_CLASS.string;
  if (typeof v === "number") return KIND_CLASS.number;
  if (typeof v === "boolean" || v === null) return KIND_CLASS.boolean;
  return KIND_CLASS.plain;
}
export function primitiveText(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (v === null) return "null";
  return String(v);
}

export function collapsedSummary(v: unknown[] | Record<string, unknown>, isArr: boolean): string {
  const n = isArr ? (v as unknown[]).length : Object.keys(v).length;
  return isArr ? `${n} ${n === 1 ? "item" : "items"}` : `${n} ${n === 1 ? "key" : "keys"}`;
}

export const STRING_INLINE_CAP = 240;

export const DIFF_MAX_LINES = 3000;

export type DiffRow = { tag: " " | "-" | "+"; text: string };

export function lineDiff(a: string[], b: string[]): DiffRow[] | null {
  const n = a.length;
  const m = b.length;
  if (n > DIFF_MAX_LINES || m > DIFF_MAX_LINES) return null;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ tag: " ", text: a[i++] });
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ tag: "-", text: a[i++] });
    } else {
      out.push({ tag: "+", text: b[j++] });
    }
  }
  while (i < n) out.push({ tag: "-", text: a[i++] });
  while (j < m) out.push({ tag: "+", text: b[j++] });
  return out;
}

export const DIFF_ROW_CLASS: Record<DiffRow["tag"], string> = {
  " ": "text-[#999] dark:text-[#777]",
  "-": "bg-[#FDECEC] dark:bg-[#3A2422] text-[#B4453B] dark:text-[#E59A92]",
  "+": "bg-[#EAF7EE] dark:bg-[#1F3326] text-[#177245] dark:text-[#9FE0B9]",
};
