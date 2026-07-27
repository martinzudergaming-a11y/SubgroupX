export class WorkspaceWriteLease {
  private tail: Promise<void> = Promise.resolve();
  private queued = 0;

  get pending(): number {
    return this.queued;
  }

  async run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw abortError();

    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    let released = false;
    const finish = () => {
      if (released) return;
      released = true;
      this.queued--;
      release();
    };
    const previous = this.tail;
    this.tail = mine;
    this.queued++;

    let cancelled = false;
    let removeAbort: (() => void) | undefined;
    const aborted = signal
      ? new Promise<never>((_resolve, reject) => {
          const onAbort = () => {
            cancelled = true;
            reject(abortError());
          };
          signal.addEventListener("abort", onAbort, { once: true });
          removeAbort = () => signal.removeEventListener("abort", onAbort);
        })
      : null;

    try {
      if (aborted) await Promise.race([previous, aborted]);
      else await previous;
    } catch (error) {
      void previous.then(finish, finish);
      throw error;
    } finally {
      removeAbort?.();
    }

    if (cancelled || signal?.aborted) {
      finish();
      throw abortError();
    }

    try {
      return await operation();
    } finally {
      finish();
    }
  }
}

function abortError(): Error {
  const error = new Error("workspace write was cancelled");
  error.name = "AbortError";
  return error;
}
