// 1.3.6: stick-to-bottom decisions for the conversation scroller, kept DOM-free so they can be unit-tested.
//
// The chat is a virtual list: rows start at an estimated height and grow once measured (a long reply with
// code blocks is far taller than its 120px estimate), and a streaming reply grows without adding rows.
// Growth like that pushes scrollHeight away from scrollTop and fires `scroll` events of its own. It must
// never read as "the user scrolled up". Only a real upward move by the user leaves the bottom.

/** Within this many px of the bottom counts as "at the bottom" (re-sticks, clears the new-messages dot) */
export const STICK_PX = 60;
/** A wheel/touch/key/scrollbar gesture this recent (ms) explains an upward scrollTop change */
export const INTENT_MS = 600;

export interface ScrollMetrics { scrollTop: number; scrollHeight: number; clientHeight: number }

export interface StickTracker {
  stick: boolean;
  /** scrollTop seen at the previous scroll event / programmatic snap */
  lastTop: number;
  /** distance from the bottom seen at the previous scroll event / programmatic snap (1.3.8) */
  lastDist: number;
  /** time of the last user scroll gesture (wheel, touch, scroll key, pointer on the scroller) */
  intentAt: number;
  /** 1.3.8: which way that gesture went ("any" for touch / the scrollbar, whose direction isn't known up front) */
  intentDir: "up" | "down" | "any";
  /** a pointer is held on the scroller (dragging the scrollbar) */
  pointerDown: boolean;
}

export const newTracker = (): StickTracker => ({ stick: true, lastTop: 0, lastDist: 0, intentAt: -Infinity, intentDir: "any", pointerDown: false });

export const distanceFromBottom = (m: ScrollMetrics): number => m.scrollHeight - m.scrollTop - m.clientHeight;

/** Moves smaller than this (px) are rounding noise (fractional scrollTop on HiDPI screens), not a scroll */
const EPS = 0.5;

/**
 * A `scroll` event happened: is the view still stuck to the bottom?
 * - stuck, scrollTop went up during a user gesture that wasn't a downward one → unstuck at once, however close to
 *   the bottom it still is (1.3.8, issue #2: 1.3.7 re-stuck anything within 60px, so a slow wheel/trackpad scroll up
 *   was snapped back). A downward wheel/key gesture doesn't count: scrollTop clamping up while it runs (a streamed
 *   reply settling to its final, shorter height) is layout, not the user.
 * - stuck otherwise (layout growth, the virtualizer correcting offsets, the container shrinking) → stays stuck;
 *   the caller snaps back to the bottom
 * - unstuck → stays unstuck while content grows, rows are measured or the layout changes. It sticks again only
 *   when the view reaches the real bottom (≤ 1px), or the user scrolls down (the distance to the bottom shrinks
 *   during a gesture that wasn't an upward one) to within STICK_PX of it.
 */
export function decideOnScroll(t: StickTracker, m: ScrollMetrics, now: number): boolean {
  const dist = distanceFromBottom(m);
  const up = m.scrollTop < t.lastTop - EPS;
  const closer = dist < t.lastDist - EPS;
  t.lastTop = m.scrollTop;
  t.lastDist = dist;
  const userGesture = t.pointerDown || now - t.intentAt < INTENT_MS;
  const dir = t.pointerDown ? "any" : t.intentDir;
  if (t.stick) {
    if (up && userGesture && dir !== "down") return (t.stick = false);
    return true;
  }
  if (dist <= 1) return (t.stick = true);
  if (closer && userGesture && dir !== "up" && dist < STICK_PX) return (t.stick = true);
  return false;
}

/** Keys that scroll the conversation up when it has focus */
export const SCROLL_UP_KEYS = new Set(["ArrowUp", "PageUp", "Home"]);
/** Keys that scroll the conversation down when it has focus (1.3.8: a gesture that may re-stick near the bottom) */
export const SCROLL_DOWN_KEYS = new Set(["ArrowDown", "PageDown", "End"]);
