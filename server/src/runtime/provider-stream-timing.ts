export interface ProviderStreamTimingSnapshot {
  httpStatus: number | null;
  requestToHeadersMs: number | null;
  requestToFirstUpdateMs: number | null;
  requestToFirstDeltaMs: number | null;
  headersToFirstDeltaMs: number | null;
  lastContentEndToAdapterSettledMs: number | null;
  adapterDurationMs: number | null;
  updateCount: number;
  deltaCount: number;
  contentEndCount: number;
  lastContentEndKind: string | null;
}

function elapsed(from: number | null, to: number | null): number | null {
  if (from === null || to === null) return null;
  return Math.max(0, Math.round(to - from));
}

export class ProviderStreamTiming {
  private roundStartedAt: number | null = null;
  private requestStartedAt: number | null = null;
  private headersAt: number | null = null;
  private httpStatus: number | null = null;
  private firstUpdateAt: number | null = null;
  private firstDeltaAt: number | null = null;
  private lastContentEndAt: number | null = null;
  private updateCount = 0;
  private deltaCount = 0;
  private contentEndCount = 0;
  private lastContentEndKind: string | null = null;

  beginRound(at: number): void {
    this.roundStartedAt = at;
    this.requestStartedAt = null;
    this.headersAt = null;
    this.httpStatus = null;
    this.firstUpdateAt = null;
    this.firstDeltaAt = null;
    this.lastContentEndAt = null;
    this.updateCount = 0;
    this.deltaCount = 0;
    this.contentEndCount = 0;
    this.lastContentEndKind = null;
  }

  markRequestStarted(at: number): void {
    this.requestStartedAt = at;
  }

  markHeaders(at: number, status?: number): void {
    this.headersAt = at;
    this.httpStatus = typeof status === "number" && Number.isFinite(status) ? status : null;
  }

  observeUpdate(type: string, at: number): void {
    this.updateCount++;
    this.firstUpdateAt ??= at;
    if (type.endsWith("_delta")) {
      this.deltaCount++;
      this.firstDeltaAt ??= at;
    }
    if (type === "thinking_end" || type === "text_end" || type === "toolcall_end") {
      this.contentEndCount++;
      this.lastContentEndAt = at;
      this.lastContentEndKind = type;
    }
  }

  settle(at: number): ProviderStreamTimingSnapshot {
    return {
      httpStatus: this.httpStatus,
      requestToHeadersMs: elapsed(this.requestStartedAt, this.headersAt),
      requestToFirstUpdateMs: elapsed(this.requestStartedAt, this.firstUpdateAt),
      requestToFirstDeltaMs: elapsed(this.requestStartedAt, this.firstDeltaAt),
      headersToFirstDeltaMs: elapsed(this.headersAt, this.firstDeltaAt),
      lastContentEndToAdapterSettledMs: elapsed(this.lastContentEndAt, at),
      adapterDurationMs: elapsed(this.requestStartedAt ?? this.roundStartedAt, at),
      updateCount: this.updateCount,
      deltaCount: this.deltaCount,
      contentEndCount: this.contentEndCount,
      lastContentEndKind: this.lastContentEndKind,
    };
  }
}
