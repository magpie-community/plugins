// AsyncQueue: push/close/[Symbol.asyncIterator], the prompt input stream for the Claude SDK.
export class AsyncQueue<T> implements AsyncIterable<T> {
  private buf: T[] = [];
  private waiters: ((v: IteratorResult<T>) => void)[] = [];
  private closed = false;
  private err: unknown = null;

  push(item: T): void {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value: item, done: false });
    else this.buf.push(item);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length) {
      const w = this.waiters.shift()!;
      w({ value: undefined as never, done: true });
    }
  }

  fail(err: unknown): void {
    if (this.closed) return;
    this.err = err;
    this.closed = true;
    while (this.waiters.length) {
      const w = this.waiters.shift()!;
      // Make waiters throw
      w({ value: undefined as never, done: true });
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buf.length) return Promise.resolve({ value: this.buf.shift()!, done: false });
        if (this.closed) {
          if (this.err) return Promise.reject(this.err);
          return Promise.resolve({ value: undefined as never, done: true });
        }
        if (this.err) return Promise.reject(this.err);
        return new Promise<IteratorResult<T>>((res, rej) => {
          this.waiters.push((r) => {
            if (this.err) {
              rej(this.err);
              return;
            }
            res(r);
          });
        });
      },
    };
  }
}
