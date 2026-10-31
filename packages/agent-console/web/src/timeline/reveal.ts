// Steady reveal (§8.6): streamed text isn't pasted all at once; each frame catches up 1/8 of the remainder, at least 2 chars.
// Usage: const r = new Reveal(text => render(text)); r.push(fullText); r.flush() jumps to the end immediately.
export class Reveal {
  private target = "";
  private shown = "";
  private raf = 0;
  private running = false;

  constructor(private render: (text: string) => void, private minStep = 2, private frac = 8) {}

  push(target: string): void {
    this.target = target;
    if (this.shown.length > target.length) this.shown = target; // reset on complete event
    if (!this.running) {
      this.running = true;
      this.tick();
    }
  }

  private tick = (): void => {
    if (this.shown === this.target) {
      this.running = false;
      return;
    }
    const remain = this.target.length - this.shown.length;
    const step = Math.max(this.minStep, Math.ceil(remain / this.frac));
    this.shown = this.target.slice(0, this.shown.length + step);
    this.render(this.shown);
    this.raf = requestAnimationFrame(this.tick);
  };

  flush(): void {
    this.shown = this.target;
    this.render(this.shown);
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
  }

  stop(): void {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
  }
}
