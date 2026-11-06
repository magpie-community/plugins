// 1.3 "添加到对话": select text in the conversation (replies, your own messages, code, tool output) or in the right
// panel (file preview, diff) and a small button offers to add it to the composer as a quote.
// - Only inside [data-quote-root] areas; never for selections in inputs, the composer, buttons or across two areas.
// - Hidden while the mouse is still dragging (no flicker), shown on release; it never takes the selection away
//   (mousedown on it is cancelled), so Ctrl+C keeps working and the button stays while the pointer travels to it.
// - Placed above the selection, or below it when there is no room, inside the visible part of the scroller
//   (above the composer), never off-screen at narrow widths. Follows scrolling; Esc or an empty selection hides it.
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icons";
import { t } from "../i18n/index.js";
import { placeQuotePop, type Box } from "../composer/quotes";

type Pick = { text: string; src?: string; left: number; top: number };

const POP_W_FALLBACK = 118, POP_H = 30;
const EDITABLE = "input, textarea, select, [contenteditable=''], [contenteditable='true'], button, .cp-card, .qs-pop, [data-quote-off]";

function elOf(n: Node | null): Element | null {
  return !n ? null : n.nodeType === 1 ? (n as Element) : n.parentElement;
}

/** The selection to quote, or null (outside a quote area, inside an input, spanning two areas, blank) */
export function quotableSelection(sel: Selection | null): { range: Range; text: string; root: Element; src?: string } | null {
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const text = sel.toString();
  if (!text.trim()) return null;
  const a = elOf(sel.anchorNode), f = elOf(sel.focusNode);
  if (!a || !f) return null;
  const root = a.closest("[data-quote-root]");
  if (!root || root !== f.closest("[data-quote-root]")) return null;
  if (a.closest(EDITABLE) || f.closest(EDITABLE)) return null;
  const range = sel.getRangeAt(0);
  const srcEl = elOf(range.commonAncestorContainer)?.closest("[data-quote-src]");
  const src = srcEl?.getAttribute("data-quote-src") || undefined;
  return { range, text, root, src };
}

function visibleArea(root: Element): Box {
  // The scroller the area lives in; for the chat, stop above the composer
  let sc: Element | null = root;
  while (sc && sc !== document.body) {
    const o = getComputedStyle(sc).overflowY;
    if (o === "auto" || o === "scroll") break;
    sc = sc.parentElement;
  }
  const r = (sc && sc !== document.body ? sc : document.documentElement).getBoundingClientRect();
  let bottom = Math.min(r.bottom, window.innerHeight);
  const cp = document.querySelector(".composer");
  if (root.getAttribute("data-quote-root") === "chat" && cp) bottom = Math.min(bottom, cp.getBoundingClientRect().top);
  return { left: r.left, right: r.right, top: Math.max(r.top, 0) + 4, bottom: bottom - 4 };
}

/** memo: no props, Chat's streaming re-renders don't reach it */
export const QuoteSelect = memo(function QuoteSelect() {
  const [pick, setPick] = useState<Pick | null>(null);
  const dragging = useRef(false);
  const popRef = useRef<HTMLButtonElement>(null);
  const raf = useRef(0);

  const update = useCallback(() => {
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => {
      if (dragging.current) return;
      const q = quotableSelection(window.getSelection());
      if (!q) { setPick(null); return; }
      const w = popRef.current?.offsetWidth || POP_W_FALLBACK;
      const boxes = [...q.range.getClientRects()].map((r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom }));
      const at = placeQuotePop(boxes, visibleArea(q.root), { w, h: POP_H }, window.innerWidth);
      if (!at) { setPick(null); return; }
      setPick({ text: q.text, src: q.src, left: at.left, top: at.top });
    });
  }, []);

  useEffect(() => {
    const down = (e: PointerEvent) => {
      if ((e.target as Element | null)?.closest?.(".qs-pop")) return;
      if (e.button !== 0) return;
      dragging.current = true;
      setPick(null);
    };
    const up = () => {
      if (!dragging.current) return;
      dragging.current = false;
      update();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setPick(null); return; }
      update();
    };
    const onSel = () => update();
    const onScroll = () => update();
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("pointerup", up, true);
    document.addEventListener("keyup", key, true);
    document.addEventListener("selectionchange", onSel);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("pointerup", up, true);
      document.removeEventListener("keyup", key, true);
      document.removeEventListener("selectionchange", onSel);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
      cancelAnimationFrame(raf.current);
    };
  }, [update]);

  if (!pick) return null;
  const add = () => {
    window.dispatchEvent(new CustomEvent("ac-add-quote", { detail: { text: pick.text, src: pick.src } }));
    window.getSelection()?.removeAllRanges();
    setPick(null);
  };
  return createPortal(
    <button
      ref={popRef}
      type="button"
      className="qs-pop"
      style={{ left: pick.left, top: pick.top }}
      title={t("quote.addHint")}
      // Keep the selection (and so Ctrl+C) while clicking
      onMouseDown={(e) => e.preventDefault()}
      onPointerDown={(e) => e.preventDefault()}
      onClick={add}
    >
      <Icon name="chat" size={13} />
      <span>{t("quote.add")}</span>
    </button>,
    document.body,
  );
});
