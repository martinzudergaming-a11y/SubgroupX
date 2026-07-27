import type { AssistantBlock, TimelineItem, ToolCallStatus, WireAgentEvent } from "./protocol.ts";

let localSeq = 1_000_000;
const nextSeq = () => localSeq++;
type SeqAllocator = () => number;

export function timelineSeqAllocator(items: readonly TimelineItem[]): SeqAllocator {
  let cursor = items.reduce((highest, item) => Math.max(highest, item.seq), 0);
  return () => ++cursor;
}

const STATUS_RANK: Record<ToolCallStatus, number> = {
  streaming_args: 0,
  ready: 1,
  pending: 2,
  approved: 3,
  running: 4,
  success: 5,
  error: 5,
  denied: 5,
};
const statusRank = (s: ToolCallStatus): number => STATUS_RANK[s] ?? 0;

function projectToolCallBlock(
  items: TimelineItem[],
  block: Extract<AssistantBlock, { type: "toolCall" }>,
  turnId: string | undefined,
  observedAt: number,
  allocateSeq: SeqAllocator,
): TimelineItem[] {
  const i = items.findIndex((it) => it.id === block.id);
  if (i === -1) {
    return [
      ...items,
      {
        kind: "tool",
        id: block.id,
        seq: allocateSeq(),
        name: block.name,
        toolKind: block.toolKind ?? "other",
        path: block.path,
        arguments: block.arguments,
        status: "streaming_args",
        ts: observedAt,
        turnId,
      },
    ];
  }
  const cur = items[i];
  if (cur.kind !== "tool") return items;
  const copy = items.slice();
  copy[i] = {
    ...cur,
    name: block.name || cur.name,
    toolKind: block.toolKind ?? cur.toolKind,
    path: block.path ?? cur.path,
    arguments: block.arguments,
    turnId: cur.turnId ?? turnId,
    status: cur.status,
  };
  return copy;
}

function projectAssistantToolCalls(
  items: TimelineItem[],
  blocks: AssistantBlock[],
  turnId: string | undefined,
  observedAt: number,
  allocateSeq: SeqAllocator,
): TimelineItem[] {
  let out = items;
  for (const b of blocks) {
    if (b.type === "toolCall") out = projectToolCallBlock(out, b, turnId, observedAt, allocateSeq);
  }
  return out;
}

export function reduceTimeline(
  items: TimelineItem[],
  ev: WireAgentEvent,
  observedAt = Date.now(),
  allocateSeq: SeqAllocator = nextSeq,
): TimelineItem[] {
  const idx = (id: string) => items.findIndex((i) => i.id === id);
  const replace = (i: number, item: TimelineItem): TimelineItem[] => {
    const copy = items.slice();
    copy[i] = item;
    return copy;
  };

  switch (ev.t) {
    case "team_assignment": {
      if (idx(ev.id) !== -1) return items;
      return [...items, {
        kind: "team_assignment",
        id: ev.id,
        seq: ev.seq,
        taskId: ev.taskId,
        title: ev.title,
        ts: ev.ts,
        turnId: ev.turnId,
      }];
    }
    case "user_message": {
      if (idx(ev.id) !== -1) return items;
      return [...items, { kind: "user", id: ev.id, seq: ev.seq ?? allocateSeq(), text: ev.text, ts: observedAt, turnId: ev.turnId }];
    }
    case "assistant_start": {
      if (idx(ev.id) !== -1) return items;
      return [...items, { kind: "assistant", id: ev.id, seq: allocateSeq(), blocks: [], streaming: true, ts: observedAt, turnId: ev.turnId }];
    }
    case "assistant_update": {
      const i = idx(ev.id);
      let next: TimelineItem[];
      if (i === -1) {
        next = [...items, { kind: "assistant", id: ev.id, seq: allocateSeq(), blocks: ev.blocks, streaming: true, ts: observedAt, turnId: ev.turnId }];
      } else {
        const cur = items[i];
        if (cur.kind !== "assistant") return items;
        next = replace(i, { ...cur, blocks: ev.blocks, streaming: true, turnId: cur.turnId ?? ev.turnId });
      }
      return projectAssistantToolCalls(next, ev.blocks, ev.turnId, observedAt, allocateSeq);
    }
    case "assistant_end": {
      const i = idx(ev.id);
      let next: TimelineItem[];
      if (i === -1) {
        next = [...items, { kind: "assistant", id: ev.id, seq: allocateSeq(), blocks: ev.blocks, streaming: false, usage: ev.usage, ts: observedAt, turnId: ev.turnId }];
      } else {
        const cur = items[i];
        if (cur.kind !== "assistant") return items;
        next = replace(i, { ...cur, blocks: ev.blocks, streaming: false, usage: ev.usage, turnId: cur.turnId ?? ev.turnId });
      }
      return projectAssistantToolCalls(next, ev.blocks, ev.turnId, observedAt, allocateSeq);
    }
    case "tool_start": {
      const i = idx(ev.id);
      if (i !== -1) {
        const cur = items[i];
        if (cur.kind !== "tool") return items;
        const status = statusRank("pending") > statusRank(cur.status) ? "pending" : cur.status;
        return replace(i, { ...cur, name: ev.name, toolKind: ev.toolKind, path: ev.path ?? cur.path, arguments: ev.arguments, status, turnId: cur.turnId ?? ev.turnId });
      }
      return [
        ...items,
        {
          kind: "tool",
          id: ev.id,
          seq: allocateSeq(),
          name: ev.name,
          toolKind: ev.toolKind,
          path: ev.path,
          arguments: ev.arguments,
          status: "pending",
          ts: observedAt,
          turnId: ev.turnId,
        },
      ];
    }
    case "tool_status": {
      const i = idx(ev.id);
      if (i === -1) return items;
      const cur = items[i];
      if (cur.kind !== "tool") return items;
      if (statusRank(ev.status) < statusRank(cur.status)) return items;
      return replace(i, {
        ...cur,
        status: ev.status,
        runningElapsedMs: ev.status === "running" ? (ev.runningElapsedMs ?? cur.runningElapsedMs ?? 0) : undefined,
        turnId: cur.turnId ?? ev.turnId,
      });
    }
    case "tool_end": {
      const i = idx(ev.id);
      if (i === -1) {
        if (!ev.name || !ev.toolKind || !ev.arguments) return items;
        return [...items, {
          kind: "tool",
          id: ev.id,
          seq: allocateSeq(),
          name: ev.name,
          toolKind: ev.toolKind,
          path: ev.path,
          arguments: ev.arguments,
          status: ev.status,
          termination: ev.termination,
          resultText: ev.resultText,
          isError: ev.isError,
          durationMs: ev.durationMs,
          shell: ev.shell,
          edit: ev.edit,
          ts: observedAt,
          turnId: ev.turnId,
        }];
      }
      const cur = items[i];
      if (cur.kind !== "tool") return items;
      return replace(i, { ...cur, status: ev.status, termination: ev.termination ?? cur.termination, resultText: ev.resultText, isError: ev.isError, durationMs: ev.durationMs ?? cur.durationMs, runningElapsedMs: undefined, shell: ev.shell ?? cur.shell, edit: ev.edit ?? cur.edit, turnId: cur.turnId ?? ev.turnId });
    }
    case "subagent_event": {
      const i = idx(ev.parentId);
      if (i === -1) return items;
      const cur = items[i];
      if (cur.kind !== "tool") return items;
      let childProgress = cur.childProgress;
      if (
        ev.taskId !== undefined
        && ev.leaseGeneration !== undefined
        && ev.progressSeq !== undefined
        && ev.progressAt !== undefined
      ) {
        if (childProgress?.taskId === ev.taskId && ev.leaseGeneration < childProgress.leaseGeneration) return items;
        if (
          childProgress?.taskId === ev.taskId
          && ev.leaseGeneration === childProgress.leaseGeneration
          && ev.progressSeq <= childProgress.lastSeq
        ) return items;
        const newAttempt = !childProgress
          || childProgress.taskId !== ev.taskId
          || ev.leaseGeneration > childProgress.leaseGeneration;
        if (newAttempt && (ev.progressSeq !== 1 || ev.event.t !== "turn_start")) return items;
        if (!newAttempt && ev.progressSeq !== childProgress!.lastSeq + 1) return items;
        if (newAttempt) {
          if (ev.event.t !== "turn_start") return items;
          childProgress = {
            taskId: ev.taskId,
            leaseGeneration: ev.leaseGeneration,
            turnId: ev.event.turnId,
            status: "in_progress",
            startedAt: ev.event.startedAt,
            lastSeq: ev.progressSeq,
            source: ev.source ?? "worker",
          };
        } else {
          childProgress = {
            ...childProgress!,
            lastSeq: ev.progressSeq,
            source: ev.source ?? childProgress!.source,
            ...(ev.event.t === "turn_end"
              ? {
                  turnId: ev.event.turnId,
                  status: ev.event.status,
                  completedAt: ev.event.completedAt,
                  durationMs: ev.event.durationMs,
                }
              : {}),
          };
        }
      }
      const baseChildren = childProgress && childProgress !== cur.childProgress && childProgress.lastSeq === 1
        ? []
        : cur.children ?? [];
      return replace(i, {
        ...cur,
        children: reduceTimeline(
          baseChildren,
          ev.event,
          ev.progressAt ?? observedAt,
          timelineSeqAllocator(baseChildren),
        ),
        ...(childProgress ? { childProgress } : {}),
      });
    }
    case "subagent_snapshot": {
      const i = idx(ev.parentId);
      if (i === -1) return items;
      const cur = items[i];
      if (cur.kind !== "tool") return items;
      const prior = cur.childProgress;
      if (prior?.taskId === ev.progress.taskId) {
        if (ev.progress.leaseGeneration < prior.leaseGeneration) return items;
        if (
          ev.progress.leaseGeneration === prior.leaseGeneration
          && ev.progress.lastSeq <= prior.lastSeq
        ) return items;
      }
      return replace(i, { ...cur, children: ev.children, childProgress: ev.progress });
    }
    case "compaction_start": {
      if (idx(ev.id) !== -1) return items;
      return [...items, { kind: "compaction_pending", id: ev.id, seq: allocateSeq(), ts: observedAt, summarizedCount: ev.summarizedCount, turnId: ev.turnId }];
    }
    case "compaction_end": {
      const i = idx(ev.id);
      if (i === -1 || items[i].kind !== "compaction_pending") return items;
      return items.filter((_, j) => j !== i);
    }
    case "compaction": {
      const pi = items.findIndex((it) => it.id === ev.id && it.kind === "compaction_pending");
      const mk = (seq: number): TimelineItem => ({
        kind: "compaction",
        id: ev.id,
        seq,
        ts: observedAt,
        compactionId: ev.compactionId,
        summarizedCount: ev.summarizedCount,
        tokensBefore: ev.tokensBefore,
        tokensAfter: ev.tokensAfter,
        turnId: ev.turnId,
      });
      if (pi !== -1) return replace(pi, mk(items[pi].seq));
      if (items.some((it) => it.id === ev.id && it.kind === "compaction")) return items;
      return [...items, mk(allocateSeq())];
    }
    case "recap": {
      if (items.some((it) => it.id === ev.id && it.kind === "recap")) return items;
      return [
        ...items,
        {
          kind: "recap",
          id: ev.id,
          seq: ev.seq,
          text: ev.text,
          ts: ev.ts,
          anchorSeq: ev.anchorSeq,
          contractVersion: ev.contractVersion,
          source: ev.source,
          generatorProvider: ev.generatorProvider,
          generatorModel: ev.generatorModel,
          turnProvider: ev.turnProvider,
          turnModel: ev.turnModel,
          sourceTurnId: ev.sourceTurnId,
        },
      ];
    }
    case "error":
      return [...items, { kind: "error", id: "e_" + allocateSeq(), seq: allocateSeq(), message: ev.message, ts: observedAt, errorKind: ev.errorKind, retryable: ev.retryable, turnId: ev.turnId }];
    default:
      return items;
  }
}

export interface PendingOptimistic {
  localId: string;
  text: string;
}

export function mergeReplayWithPending(replayItems: TimelineItem[], pending: PendingOptimistic[]): TimelineItem[] {
  if (pending.length === 0) return replayItems;
  const surviving = pending.filter(
    (p) => !replayItems.some((it) => it.kind === "user" && it.text === p.text),
  );
  if (surviving.length === 0) return replayItems;
  return [
    ...replayItems,
    ...surviving.map((p): TimelineItem => ({ kind: "user", id: p.localId, seq: Date.now(), text: p.text, ts: Date.now() })),
  ];
}
