// Markdown rendering (marked + DOMPurify + highlight.js live in util/renderMarkdown.ts).
// 1.3.7: fenced code is built as the final .cb / header / numbered / highlighted HTML inside renderMarkdown,
// so React's commit paints the stable height in one shot (the old useEffect decorate ran after paint and
// flashed bare <pre> ↔ .cb on every streaming token). Copy / wrap use container event delegation; wrap
// state is keyed by the block's index in its message (a streaming block keeps its index while it grows; a
// source fingerprint changed with every token and dropped the toggle) and is baked into the HTML string.
import { useLayoutEffect, useMemo, useRef, type MouseEvent } from "react";
import { linkifyLocal } from "../util/localLinks";
import { onChatLinkClick } from "../preview/open";
import { t } from "../i18n/index.js";
import { ICON_CHECK, ICON_COPY, svgIconHtml } from "../util/codeBlock";
import { renderMarkdown } from "../util/renderMarkdown";

export { renderMarkdown, type RenderedMarkdown } from "../util/renderMarkdown";

export function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const rawsRef = useRef<string[]>([]);
  // One <Markdown> is one message: while it streams its code blocks only ever get appended, so block i stays block i
  const wrapIdx = useRef(new Set<number>());
  // wrapIdx is read at render time (a toggle mutates the DOM directly; the next text change bakes it into the HTML)
  // streaming: an unlabelled fence still open at the end stays "text" until it closes or the message settles
  const rendered = useMemo(() => renderMarkdown(text, { wrapped: wrapIdx.current, streaming }), [text, streaming]);
  rawsRef.current = rendered.raws;

  // Restore .wrap before paint so a streaming re-render never flashes the unwrapped width
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // No code block left in the text (reset / replaced): start from a clean wrap state
    if (rendered.raws.length === 0) wrapIdx.current.clear();
    // Safety net: the HTML already carries .wrap / aria-pressed for toggled blocks
    const boxes = el.querySelectorAll(".cb");
    boxes.forEach((box, i) => {
      const on = wrapIdx.current.has(i);
      if (box.classList.contains("wrap") !== on) box.classList.toggle("wrap", on);
      box.querySelector(".cb-wrap")?.setAttribute("aria-pressed", String(on));
    });
    // While streaming the text changes many times a second: link once it settles (and on every final render)
    if (!streaming) linkifyLocal(el, t("links.openPreviewTitle"));
  }, [rendered.html, streaming]);

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    onChatLinkClick(e);
    const btn = (e.target as HTMLElement | null)?.closest?.(".cb-btn") as HTMLElement | null;
    const root = ref.current;
    if (!btn || !root || !root.contains(btn)) return;
    e.preventDefault();
    const box = btn.closest(".cb");
    if (!box) return;
    if (btn.classList.contains("cb-wrap")) {
      const on = !box.classList.contains("wrap");
      box.classList.toggle("wrap", on);
      btn.setAttribute("aria-pressed", String(on));
      const idx = [...root.querySelectorAll(".cb")].indexOf(box);
      if (idx < 0) return;
      if (on) wrapIdx.current.add(idx);
      else wrapIdx.current.delete(idx);
      return;
    }
    if (btn.classList.contains("cb-copy")) {
      const idx = Number(btn.getAttribute("data-i") ?? "-1");
      const raw = rawsRef.current[idx] ?? "";
      void copyText(raw).then(() => {
        // Ignore if this button was replaced by a later stream frame
        if (!btn.isConnected) return;
        btn.innerHTML = svgIconHtml(ICON_CHECK);
        btn.classList.add("done");
        setTimeout(() => {
          if (!btn.isConnected) return;
          btn.innerHTML = svgIconHtml(ICON_COPY);
          btn.classList.remove("done");
        }, 1200);
      });
    }
  };

  return (
    <div
      ref={ref}
      className={`md${streaming ? " streaming" : ""}`}
      onClick={onClick}
      dangerouslySetInnerHTML={{ __html: rendered.html }}
    />
  );
}

// Clipboard: writeText → on failure fall back to a hidden textarea + execCommand (§8.2)
export async function copyText(t: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(t);
    return;
  } catch {}
  try {
    const ta = document.createElement("textarea");
    ta.value = t;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  } catch {}
}
