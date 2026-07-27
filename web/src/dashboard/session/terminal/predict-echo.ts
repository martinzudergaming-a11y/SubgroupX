export interface ReconcileResult {
  consumed: number;
  flush: boolean;
}

export class PredictionEngine {
  private pending: string[] = [];
  private anchorTs = 0;
  private readonly maxPending: number;
  private readonly maxAgeMs: number;

  constructor(opts: { maxPending?: number; maxAgeMs?: number } = {}) {
    this.maxPending = opts.maxPending ?? 64;
    this.maxAgeMs = opts.maxAgeMs ?? 1000;
  }

  get pendingChars(): readonly string[] {
    return this.pending;
  }
  get count(): number {
    return this.pending.length;
  }
  get isEmpty(): boolean {
    return this.pending.length === 0;
  }

  predict(ch: string, now: number): boolean {
    if (this.pending.length >= this.maxPending) return false;
    if (this.pending.length === 0) this.anchorTs = now;
    this.pending.push(ch);
    return true;
  }

  backspace(): boolean {
    if (this.pending.length === 0) return false;
    this.pending.pop();
    if (this.pending.length === 0) this.anchorTs = 0;
    return true;
  }

  reconcile(bytes: Uint8Array): ReconcileResult {
    let consumed = 0;
    for (let i = 0; i < bytes.length && this.pending.length > 0; i++) {
      const b = bytes[i];
      const printable = b >= 0x20 && b < 0x7f;
      if (printable && String.fromCharCode(b) === this.pending[0]) {
        this.pending.shift();
        consumed++;
      } else {
        this.pending = [];
        this.anchorTs = 0;
        return { consumed, flush: true };
      }
    }
    if (this.pending.length === 0) this.anchorTs = 0;
    return { consumed, flush: false };
  }

  expire(now: number): boolean {
    if (this.pending.length > 0 && now - this.anchorTs > this.maxAgeMs) {
      this.pending = [];
      this.anchorTs = 0;
      return true;
    }
    return false;
  }

  flush(): boolean {
    const had = this.pending.length > 0;
    this.pending = [];
    this.anchorTs = 0;
    return had;
  }
}

export function isPredictableChar(data: string): boolean {
  return data.length === 1 && data.charCodeAt(0) >= 0x20 && data.charCodeAt(0) < 0x7f;
}

export function looksLikeSecretPrompt(lineText: string): boolean {
  return /(password|passphrase|passwd|secret|token|api[ _-]?key|\[sudo\] password)\s*.{0,40}:\s*$/i.test(lineText);
}
