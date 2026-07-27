export class PtyInputQueue {
  private pending: Uint8Array[] = [];
  private flushScheduled = false;
  private closed = false;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly write: (data: Uint8Array) => void | Promise<void>) {}

  enqueue(data: Uint8Array): void {
    if (this.closed || data.length === 0) return;
    this.pending.push(new Uint8Array(data));
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      queueMicrotask(() => this.flush());
    }
  }

  dispose(): void {
    this.closed = true;
    this.pending = [];
    this.flushScheduled = false;
  }

  private flush(): void {
    this.flushScheduled = false;
    if (this.closed || this.pending.length === 0) return;
    const batch = concat(this.pending);
    this.pending = [];
    this.chain = this.chain
      .catch(() => {})
      .then(async () => {
        if (!this.closed) await this.write(batch);
      })
      .catch(() => {});
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0]!.slice();
  const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
