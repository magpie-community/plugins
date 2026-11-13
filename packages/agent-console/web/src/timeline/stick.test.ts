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
    // scrolled back down (a gesture) to within 60px of the bottom → stuck again
    t.intentAt = 2090;
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

describe("near the bottom, the user's direction wins (1.3.8, issue #2)", () => {
  // the view is snapped to the bottom of a 4000px conversation in an 800px scroller
  const atBottom = () => {
    const t = newTracker();
    decideOnScroll(t, m(3200, 4000), 0);
    return t;
  };

  it("a slow upward scroll 20px from the bottom unsticks and stays unstuck", () => {
    const t = atBottom();
    let now = 1000;
    // trackpad: 1–5px steps, each with a fresh wheel gesture
    for (const top of [3199, 3195, 3190, 3185, 3180]) {
      t.intentAt = now;
      expect(decideOnScroll(t, m(top, 4000), now + 5)).toBe(false);
      now += 16;
    }
    expect(t.stick).toBe(false);
    // the gesture ends; the view stays 20px above the bottom
    expect(decideOnScroll(t, m(3180, 4000), now + INTENT_MS + 50)).toBe(false);
  });

  it("a sub-pixel first step still counts as leaving (fractional scrollTop)", () => {
    const t = atBottom();
    t.intentAt = 1000;
    expect(decideOnScroll(t, m(3199.25, 4000), 1005)).toBe(false);
  });

  it("streaming growth (scrollHeight grows, scrollTop unchanged) never re-sticks an unstuck view", () => {
    const t = atBottom();
    t.intentAt = 1000;
    expect(decideOnScroll(t, m(3180, 4000), 1010)).toBe(false); // 20px up
    // tokens arrive while the wheel gesture is still fresh and long after it
    let now = 1020;
    for (let h = 4004; h < 4600; h += 23) {
      expect(decideOnScroll(t, m(3180, h), now)).toBe(false);
      now += 40;
    }
    expect(t.stick).toBe(false);
  });

  it("virtual-list measurement shifting scrollTop down by the same amount (anchor kept) doesn't re-stick", () => {
    const t = atBottom();
    t.intentAt = 1000;
    expect(decideOnScroll(t, m(3180, 4000), 1010)).toBe(false); // 20px from the bottom
    // a row above the viewport is measured 40px taller: scrollTop and scrollHeight both +40, distance stays 20,
    // and this happens while the user's wheel gesture is still fresh
    expect(decideOnScroll(t, m(3220, 4040), 1100)).toBe(false);
    // the container shrinking (composer grew) only moves the bottom away
    expect(decideOnScroll(t, m(3220, 4040, 700), 1150)).toBe(false);
  });

  it("scrolling back down into the 60px zone re-sticks; reaching the real bottom re-sticks even without a gesture", () => {
    const t = atBottom();
    t.intentAt = 1000;
    expect(decideOnScroll(t, m(3000, 4000), 1010)).toBe(false); // 200px up
    // wheel down: 200 → 100 → 40 from the bottom
    t.intentAt = 3000;
    expect(decideOnScroll(t, m(3100, 4000), 3010)).toBe(false);
    expect(decideOnScroll(t, m(3160, 4000), 3030)).toBe(true);

    const u = atBottom();
    u.intentAt = 1000;
    expect(decideOnScroll(u, m(3100, 4000), 1010)).toBe(false);
    // the view lands on the real bottom some other way (e.g. a scrollbar click that ended long ago)
    expect(decideOnScroll(u, m(3199.5, 4000), 9000)).toBe(true);
  });

  it("an upward gesture inside the 60px zone after re-sticking unsticks again", () => {
    const t = atBottom();
    t.intentAt = 1000;
    expect(decideOnScroll(t, m(3150, 4000), 1010)).toBe(false);
    t.intentAt = 2000;
    expect(decideOnScroll(t, m(3200, 4000), 2010)).toBe(true);
    t.intentAt = 3000;
    expect(decideOnScroll(t, m(3190, 4000), 3010)).toBe(false);
  });

  it("the gesture's direction: a downward wheel doesn't unstick on an upward clamp, an upward one doesn't re-stick on a downward shift", () => {
    const t = atBottom();
    // wheel down at the bottom, and the streamed reply settles 30px shorter: scrollTop clamps up 30px
    t.intentAt = 1000; t.intentDir = "down";
    expect(decideOnScroll(t, m(3170, 3970), 1010)).toBe(true);
    // a real wheel up does unstick
    t.intentAt = 1100; t.intentDir = "up";
    expect(decideOnScroll(t, m(3150, 3970), 1110)).toBe(false);
    // still wheeling up, the view moves 10px closer to the bottom (the container grew): stays unstuck
    expect(decideOnScroll(t, m(3150, 3970, 810), 1150)).toBe(false);
    // the scrollbar (pointer held) counts either way
    t.pointerDown = true;
    expect(decideOnScroll(t, m(3165, 3970, 800), 5000)).toBe(true);
  });
});
