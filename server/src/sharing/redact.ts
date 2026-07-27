import type { TimelineItem } from "../../../shared/src/protocol.ts";
import type { ShareAssistantBlock, ShareAttachment, ShareDisplayState, ShareItem } from "../../../shared/src/share-protocol.ts";

const MAX_ITEMS = 2000;
const MAX_STRING = 20_000;
const MAX_TOTAL_BYTES = 1_000_000;
const MAX_ATTACHMENTS = 20;
const MAX_NAME = 100;
const REDACTED = "‹redacted›";
const TRUNCATED = "\n‹…truncated›";

const SECRET_PATTERNS: RegExp[] = [
  /AKIA[0-9A-Z]{16}/g,
  /\bASIA[0-9A-Z]{16}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g,
  /\b(?:api[_-]?key|secret|token|password|passwd|bearer)\b\s*[:=]\s*["']?[A-Za-z0-9_\-./+=]{16,}["']?/gi,
  /\/self\/[A-Za-z0-9_-]{16,43}\/trajectory\b/g,
];

function scrub(input: string, maxLen: number = MAX_STRING): string {
  let s = input;
  for (const re of SECRET_PATTERNS) s = s.replace(re, REDACTED);
  if (s.length > maxLen) s = s.slice(0, maxLen) + TRUNCATED;
  return s;
}
const MAX_STRING_DETAILED = 500_000;

function scrubArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === "string") out[k] = scrub(v);
    else if (v == null || typeof v === "number" || typeof v === "boolean") out[k] = v;
    else out[k] = scrub(JSON.stringify(v));
  }
  return out;
}

const ATTACH_MARKER_RE = /\[Attached \d+ file\(s\) in \.\/uploads\/:([^\]]*)\]/g;
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

function safeAttachmentName(raw: string): string {
  let n = raw.trim().split(/[\\/]/).pop() ?? "";
  try {
    n = decodeURIComponent(n);
  } catch {
  }
  n = n.split(/[\\/]/).pop() ?? "";
  if (CONTROL_CHARS_RE.test(n)) return "file";
  n = scrub(n).trim();
  if (n.length > MAX_NAME) n = n.slice(0, MAX_NAME);
  return n && n !== REDACTED ? n : "file";
}

function parseAttachments(text: string): { text: string; attachments?: ShareAttachment[] } {
  const names: ShareAttachment[] = [];
  let matched = false;
  const stripped = text.replace(ATTACH_MARKER_RE, (_full, list: string) => {
    matched = true;
    for (const part of String(list).split(",")) {
      if (names.length >= MAX_ATTACHMENTS) break;
      const p = part.trim();
      if (p) names.push({ name: safeAttachmentName(p) });
    }
    return "";
  });
  if (!matched) return { text };
  const cleaned = stripped.replace(/\n{3,}/g, "\n\n").trim();
  return { text: cleaned, attachments: names.length > 0 ? names : undefined };
}

function toolDisplayState(item: Extract<TimelineItem, { kind: "tool" }>): ShareDisplayState {
  if (
    item.status === "streaming_args" ||
    item.status === "ready" ||
    item.status === "pending" ||
    item.status === "approved" ||
    item.status === "running"
  ) {
    return "runningAtShare";
  }
  const args = item.arguments as Record<string, unknown>;
  const hadOutput =
    (typeof item.resultText === "string" && item.resultText.length > 0) ||
    item.shell != null ||
    ("old" in args || "new" in args || "oldText" in args || "newText" in args || "edits" in args);
  return hadOutput ? "completedOutputHidden" : "completedNoOutput";
}

function redactItem(item: TimelineItem, detailed: boolean): ShareItem | null {
  switch (item.kind) {
    case "user": {
      const { text, attachments } = parseAttachments(item.text);
      const out: Extract<ShareItem, { kind: "user" }> = {
        kind: "user",
        id: item.id,
        seq: item.seq,
        text: scrub(text),
        ts: item.ts,
        ...(item.turnId ? { turnId: item.turnId } : {}),
      };
      if (attachments) out.attachments = attachments;
      return out;
    }

    case "assistant": {
      const blocks: ShareAssistantBlock[] = [];
      for (const b of item.blocks) {
        if (b.type === "text") blocks.push({ type: "text", text: scrub(b.text) });
        else if (b.type === "toolCall") blocks.push({ type: "toolCall", id: b.id, name: b.name, arguments: scrubArgs(b.arguments) });
        else if (b.type === "thinking" && detailed) blocks.push({ type: "thinking", text: scrub(b.thinking) });
      }
      return { kind: "assistant", id: item.id, seq: item.seq, ts: item.ts, blocks, ...(item.turnId ? { turnId: item.turnId } : {}) };
    }

    case "tool": {
      const {
        old: _old,
        new: _new,
        oldText: _oldText,
        newText: _newText,
        edits: _edits,
        ...restArgs
      } = item.arguments as Record<string, unknown>;
      const children = item.children
        ? (item.children.map((c) => redactItem(c, detailed)).filter(Boolean) as ShareItem[])
        : undefined;
      const redacted: Extract<ShareItem, { kind: "tool" }> = {
        kind: "tool",
        id: item.id,
        seq: item.seq,
        name: item.name,
        toolKind: item.toolKind,
        path: item.path,
        arguments: detailed ? scrubArgs(item.arguments as Record<string, unknown>) : scrubArgs(restArgs),
        status: item.status,
        displayState: toolDisplayState(item),
        ts: item.ts,
        durationMs: item.durationMs,
        ...(item.termination ? { termination: item.termination } : {}),
        ...(item.turnId ? { turnId: item.turnId } : {}),
      };
      if (item.shell) {
        redacted.outcome = { exitCode: item.shell.exitCode, timedOut: item.shell.timedOut, truncated: item.shell.truncated };
      }
      if (detailed && typeof item.resultText === "string" && item.resultText.length > 0) {
        redacted.resultText = scrub(item.resultText, MAX_STRING_DETAILED);
      }
      if (children && children.length > 0) redacted.children = children;
      return redacted;
    }

    case "error":
      return { kind: "error", id: item.id, seq: item.seq, message: scrub(item.message), ts: item.ts, ...(item.turnId ? { turnId: item.turnId } : {}) };

    case "interrupted":
      return {
        kind: "interrupted",
        id: item.id,
        seq: item.seq,
        ts: item.ts,
        resumeText: item.resumeText ? scrub(item.resumeText) : undefined,
        ...(item.turnId ? { turnId: item.turnId } : {}),
      };

    case "compaction":
      return { kind: "compaction", id: item.id, seq: item.seq, ts: item.ts, summarizedCount: item.summarizedCount };

    case "compaction_pending":
      return null;

    case "recap":
      return null;

    case "team_assignment":
      return null;

    default: {
      const _never: never = item;
      void _never;
      return null;
    }
  }
}

export interface RedactedSnapshot {
  items: ShareItem[];
  itemCount: number;
  originalCount: number;
  truncated: boolean;
}

export function buildShareSnapshot(
  timeline: TimelineItem[],
  opts?: { detailed?: boolean; maxBytes?: number },
): RedactedSnapshot {
  const detailed = opts?.detailed === true;
  const maxBytes = opts?.maxBytes ?? MAX_TOTAL_BYTES;
  const originalCount = timeline.length;
  const recent = timeline.length > MAX_ITEMS ? timeline.slice(timeline.length - MAX_ITEMS) : timeline;
  let items = recent.map((it) => redactItem(it, detailed)).filter(Boolean) as ShareItem[];

  while (Number.isFinite(maxBytes) && items.length > 0 && Buffer.byteLength(JSON.stringify(items), "utf8") > maxBytes) {
    items = items.slice(1);
  }
  return { items, itemCount: items.length, originalCount, truncated: items.length < originalCount };
}

export function redactTitle(title: string): string {
  return scrub(title).slice(0, 200);
}

export function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
