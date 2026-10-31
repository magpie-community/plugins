// Coalescer (after Paseo's agent-stream-coalescer):
// accumulate deltas per itemId; the first is pushed immediately (leading), the rest accumulated within the window are pushed once (trailing);
// flush that itemId before its complete event arrives.
export class Coalescer {
  private windowMs: number;
  private acc = new Map<string, { text: string; timer: NodeJS.Timeout | null }>();
  private onEmit: (itemId: string, text: string) => void;
  constructor(windowMs: number, onEmit: (itemId: string, text: string) => void) {
    this.windowMs = windowMs;
    this.onEmit = onEmit;
  }

  // Push a delta; the first goes out immediately, the rest are merged within the window and sent trailing
  push(itemId: string, text: string): void {
    const acc = this.acc.get(itemId);
    if (!acc) {
      // leading: send immediately
      this.onEmit(itemId, text);
      this.acc.set(itemId, { text: "", timer: setTimeout(() => this.flush(itemId), this.windowMs) });
      return;
    }
    acc.text += text;
  }

  // Must flush before the complete event arrives to keep ordering (deltas before the complete event)
  flush(itemId: string): void {
    const acc = this.acc.get(itemId);
    if (!acc) return;
    if (acc.timer) {
      clearTimeout(acc.timer);
      acc.timer = null;
    }
    if (acc.text.length > 0) this.onEmit(itemId, acc.text);
    this.acc.delete(itemId);
  }

  // Call before an itemId's complete event arrives: flush the deltas not yet sent
  flushItem(itemId: string): void {
    this.flush(itemId);
  }

  dispose(): void {
    for (const id of [...this.acc.keys()]) this.flush(id);
  }
}
