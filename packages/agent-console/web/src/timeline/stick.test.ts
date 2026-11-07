import { describe, it, expect } from "vitest";
import { decideOnScroll, newTracker, INTENT_MS } from "./stick";

const m = (scrollTop: number, scrollHeight: number, clientHeight = 800) => ({ scrollTop, scrollHeight, clientHeight });

describe("stick-to-bottom decisions (1.3.6)", () => {
  it("layout growth after measuring (scrollHeight jumps, scrollTop unchanged) keeps the view stuck", () => {
    const t = newTracker();
    // opened: snapped to the estimated bottom (rows at 120px estimates)
    expect(decideOnScroll(t, m(1200, 2000), 1000)).toBe(true);
    // the long last reply is measured: content grows by 1500px, no user gesture
    expect(decideOnScroll(t, m(1200, 3500), 1016)).toBe(true);
    expect(t.stick).toBe(true);
  });

  it("streaming growth and container shrinking never unstick", () => {
    const t = newTracker();
    decideOnScroll(t, m(1000, 1800), 0);
    for (let h = 1900; h < 6000; h += 137) expect(decideOnScroll(t, m(1000, h), 10)).toBe(true);
    expect(decideOnScroll(t, m(1000, 1800, 500), 20)).toBe(true); // composer grew / window shrank
  });

  it("programmatic upward correction without a gesture (virtualizer shrinking an over-estimated row) stays stuck", () => {
    const t = newTracker();
    decideOnScroll(t, m(3000, 3800), 0);
    expect(decideOnScroll(t, m(2700, 3800), 50)).toBe(true);
  });

  it("an upward user gesture unsticks at once, even while content keeps growing", () => {
    const t = newTracker();
    decideOnScroll(t, m(3000, 3800), 0);
    t.intentAt = 100; // wheel up
    expect(decideOnScroll(t, m(2800, 4200), 110)).toBe(false);
    // growth afterwards doesn't re-stick it
    expect(decideOnScroll(t, m(2800, 5200), 2000)).toBe(false);
    // back within 60px of the bottom → stuck again
    expect(decideOnScroll(t, m(5200 - 800 - 30, 5200), 2100)).toBe(true);
  });

  it("dragging the scrollbar up (pointer held) unsticks; an old gesture does not", () => {
    const t = newTracker();
    decideOnScroll(t, m(3000, 3800), 0);
    t.intentAt = 0;
    expect(decideOnScroll(t, m(2500, 3800), INTENT_MS + 10)).toBe(true);
    t.pointerDown = true;
    expect(decideOnScroll(t, m(2000, 3800), INTENT_MS + 20)).toBe(false);
  });
});
