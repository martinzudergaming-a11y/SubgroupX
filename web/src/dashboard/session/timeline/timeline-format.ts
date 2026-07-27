import type { TimelineItem } from "@shared/protocol";

export function formatUsage(u: { input: number; output: number; total: number; costUsd: number }): string {
  const tokens = `${u.total.toLocaleString()} tokens · ${u.input.toLocaleString()} in / ${u.output.toLocaleString()} out`;
  return u.costUsd > 0 ? `${tokens} · $${u.costUsd.toFixed(4)}` : tokens;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${Math.round(n)}`;
}

export type CacheModelRound = { seq: number; cacheRead: number; input: number; rate: number };

export function collectCacheModelRounds(items: TimelineItem[]): CacheModelRound[] {
  const rounds: CacheModelRound[] = [];
  for (const it of items) {
    if (it.kind !== "assistant" || !it.usage) continue;
    const cacheRead = it.usage.cacheRead;
    const input = it.usage.input;
    if (cacheRead == null) continue;
    const denom = cacheRead + input;
    if (denom <= 0) continue;
    rounds.push({ seq: it.seq, cacheRead, input, rate: cacheRead / denom });
  }
  return rounds;
}

export type ThinkingPreview = { mode: "heading" | "prose"; text: string };

const THINKING_PREVIEW_TAIL = 4096;
const THINKING_PREVIEW_MAX = 112;

function cleanThinkingPreview(text: string): string {
  const compact = text
    .replace(/<\/?(?:think|analysis)>/gi, " ")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s*(?:#{1,6}|[-+*]|\d+[.)])\s+/gm, "")
    .replace(/[*_~>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (compact.length <= THINKING_PREVIEW_MAX) return compact;
  const prefix = compact.slice(0, THINKING_PREVIEW_MAX + 1);
  const wordEnd = prefix.lastIndexOf(" ");
  return `${prefix.slice(0, wordEnd >= THINKING_PREVIEW_MAX * 0.65 ? wordEnd : THINKING_PREVIEW_MAX).trimEnd()}…`;
}

function latestCompleteSentence(text: string): string {
  let sentenceStart = 0;
  let latest = "";
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "\n") {
      sentenceStart = i + 1;
      continue;
    }
    const terminal = /[。！？!?]/.test(char)
      || (char === "." && (i === text.length - 1 || /\s/.test(text[i + 1] ?? "")));
    if (!terminal) continue;
    let end = i + 1;
    while (/["'”’)}\]]/.test(text[end] ?? "")) end++;
    const candidate = cleanThinkingPreview(text.slice(sentenceStart, end));
    if (candidate) latest = candidate;
    sentenceStart = end;
    i = end - 1;
  }
  return latest;
}

export function latestThinkingPreview(text: string, streamLive = false): ThinkingPreview | null {
  const tail = text.slice(-THINKING_PREVIEW_TAIL);
  if (!tail.trim()) return null;
  const lines = tail.split(/\r?\n/);
  let latestHeading = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const bold = /^(?:[-+*]\s+)?\*\*([^*]{1,160})\*\*(?:\s*[:：—-])?/.exec(line);
    const atxComplete = !streamLive || i < lines.length - 1 || /\r?\n$/.test(tail);
    const atx = atxComplete ? /^#{1,6}\s+(.+?)(?:\s+#+)?$/.exec(line) : null;
    const heading = cleanThinkingPreview(bold?.[1] ?? atx?.[1] ?? "");
    if (heading) latestHeading = heading;
  }
  if (latestHeading) return { mode: "heading", text: latestHeading };

  const sentence = latestCompleteSentence(tail);
  if (sentence) return { mode: "prose", text: sentence };
  const lastLine = [...lines].reverse().find((line) => line.trim()) ?? tail;
  const prose = cleanThinkingPreview(lastLine);
  return prose ? { mode: "prose", text: prose } : null;
}
