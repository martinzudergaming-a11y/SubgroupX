import type { TimelineItem } from "@shared/protocol";

type ToolItem = Extract<TimelineItem, { kind: "tool" }>;
export type TimelineUnit =
  | { item: TimelineItem; tools?: undefined; run?: undefined }
  | { tools: ToolItem[]; run: TimelineItem[]; item?: undefined };

export type ToolFoldMode = "off" | "quiet" | "all";

const isSuccessTool = (i: TimelineItem): i is ToolItem =>
  i.kind === "tool" && i.status === "success";

const isFoldableTool = (i: TimelineItem): i is ToolItem =>
  isSuccessTool(i) && i.toolKind !== "canvas" && !(i.children && i.children.length > 0);

export const QUIET_BODY_MAX_CHARS = 80;

export function isQuietTool(t: ToolItem): boolean {
  switch (t.toolKind) {
    case "read":
    case "search":
    case "list":
      return true;
    case "write":
    case "edit":
      return false;
    default: {
      const body = (t.shell ? [t.shell.stdout, t.shell.stderr].filter(Boolean).join("\n") : t.resultText ?? "").trim();
      if (!body) return true;
      if (t.toolKind === "shell") return false;
      return !body.includes("\n") && body.length <= QUIET_BODY_MAX_CHARS;
    }
  }
}

export function isReasoningInterstitial(i: TimelineItem): boolean {
  return (
    i.kind === "assistant" &&
    !i.streaming &&
    !i.blocks.some((b) => b.type === "text" && b.text.trim() !== "")
  );
}

export function groupTimelineUnits(items: TimelineItem[], mode: ToolFoldMode): TimelineUnit[] {
  if (mode === "off") return items.map((item) => ({ item }));
  const foldable = (i: TimelineItem): i is ToolItem =>
    isFoldableTool(i) && (mode === "all" || isQuietTool(i));
  const units: TimelineUnit[] = [];
  let run: TimelineItem[] = [];
  let tools: ToolItem[] = [];
  let held: TimelineItem[] = [];
  const flush = () => {
    if (tools.length >= 2) units.push({ tools, run });
    else for (const it of run) units.push({ item: it });
    run = [];
    tools = [];
  };
  const spill = () => {
    for (const it of held) units.push({ item: it });
    held = [];
  };
  for (const item of items) {
    if (foldable(item)) {
      run.push(...held, item);
      held = [];
      tools.push(item);
      continue;
    }
    if (isReasoningInterstitial(item)) {
      held.push(item);
      continue;
    }
    flush();
    spill();
    units.push({ item });
  }
  flush();
  spill();
  return units;
}

export type ToolRunPart = { kind: "shell" | "read" | "write" | "edit" | "search" | "list" | "other"; name?: string; count: number };

const SUMMARY_KINDS = new Set(["shell", "read", "write", "edit", "search", "list"]);

export function summarizeToolRun(tools: ToolItem[]): ToolRunPart[] {
  const order: string[] = [];
  const byKey = new Map<string, ToolRunPart>();
  for (const t of tools) {
    const known = SUMMARY_KINDS.has(t.toolKind);
    const key = known ? t.toolKind : `name:${t.name}`;
    let part = byKey.get(key);
    if (!part) {
      part = { kind: known ? (t.toolKind as ToolRunPart["kind"]) : "other", name: known ? undefined : t.name, count: 0 };
      byKey.set(key, part);
      order.push(key);
    }
    part.count += 1;
  }
  return order.map((k) => byKey.get(k)!);
}
