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
  /** time of the last user scroll gesture (wheel, touch, scroll key, pointer on the scroller) */
  intentAt: number;
  /** a pointer is held on the scroller (dragging the scrollbar) */
  pointerDown: boolean;
}

export const newTracker = (): StickTracker => ({ stick: true, lastTop: 0, intentAt: -Infinity, pointerDown: false });

export const distanceFromBottom = (m: ScrollMetrics): number => m.scrollHeight - m.scrollTop - m.clientHeight;

/**
 * A `scroll` event happened: is the view still stuck to the bottom?
 * - near the bottom → stuck (whatever moved it there)
 * - stuck, and scrollTop did not go up, or went up without a user gesture (layout growth, the virtualizer
 *   correcting offsets, the container shrinking) → stays stuck; the caller snaps back to the bottom
 * - stuck, scrollTop went up during a user gesture → unstuck
 */
export function decideOnScroll(t: StickTracker, m: ScrollMetrics, now: number): boolean {
  const up = m.scrollTop < t.lastTop - 1;
  t.lastTop = m.scrollTop;
  if (distanceFromBottom(m) < STICK_PX) return (t.stick = true);
  if (!t.stick) return false;
  const userGesture = t.pointerDown || now - t.intentAt < INTENT_MS;
  if (up && userGesture) return (t.stick = false);
  return true;
}

/** Keys that scroll the conversation up when it has focus */
export const SCROLL_UP_KEYS = new Set(["ArrowUp", "PageUp", "Home"]);
