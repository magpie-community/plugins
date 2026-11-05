// Markdown rendering: marked + DOMPurify + highlight.js (languages on demand). 1.3: code blocks get a header with the
// language, copy and wrap buttons, and line numbers (a CSS counter on one block per line, so wrapped lines keep a gutter).
import { useMemo, useRef, useEffect } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import { linkifyLocal } from "../util/localLinks";
import { onChatLinkClick } from "../preview/open";
import { t } from "../i18n/index.js";

marked.setOptions({ gfm: true, breaks: true });

const purify = (html: string) =>
  DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });

export function renderMarkdown(text: string): string {
  return purify(marked.parse(text, { async: false }));
}

export function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const html = useMemo(() => renderMarkdown(text), [text]);

  // After rendering: highlight code blocks + copy button, then local addresses become Preview links (1.2).
  // Link clicks are handled by onChatLinkClick (system browser / Preview tab): target=_blank can't open anything in
  // Magpie's sandboxed frame, and a plain click would navigate the whole page away.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    for (const pre of el.querySelectorAll("pre")) {
      const code = pre.querySelector("code");
      if (!code || code.dataset.hl) continue;
      code.dataset.hl = "1";
      const raw = (code.textContent ?? "").replace(/\n$/, "");
      const fence = /(?:^|\s)language-([\w+#.-]+)/.exec(code.className)?.[1];
      try { hljs.highlightElement(code as HTMLElement); } catch {}
      const lang = fence ?? /(?:^|\s)language-([\w+#.-]+)/.exec(code.className)?.[1] ?? "";
      decorateCodeBlock(pre, code as HTMLElement, raw, lang);
    }
    // While streaming the text changes many times a second: link once it settles (and on every final render)
    if (!streaming) linkifyLocal(el, t("links.openPreviewTitle"));
  }, [html, streaming]);

  return (
    <div
      ref={ref}
      className={`md${streaming ? " streaming" : ""}`}
      onClick={onChatLinkClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

const SVG_NS = "http://www.w3.org/2000/svg";
function svgIcon(d: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  for (const [k, v] of Object.entries({ width: "13", height: "13", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.6", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(k, v);
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", d);
  svg.appendChild(path);
  return svg;
}
const ICON_COPY = "M8 8h11v12H8zM5 16V4h11";
const ICON_CHECK = "M5 13l4 4L19 7";
const ICON_WRAP = "M4 6h16M4 12h13a3 3 0 0 1 0 6h-4m2-2-2 2 2 2M4 18h5";

/** Highlighted code → one block per line (hljs spans that cross a line break are re-opened on the next line) */
export function splitCodeLines(code: HTMLElement): HTMLElement[] {
  const lines: HTMLElement[] = [];
  const newLine = () => { const l = document.createElement("span"); l.className = "cb-l"; lines.push(l); return l; };
  let cur = newLine();
  const walk = (node: Node, classes: string[]) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const parts = (node.textContent ?? "").split("\n");
      parts.forEach((part, i) => {
        if (i > 0) cur = newLine();
        if (!part) return;
        let host: HTMLElement = cur;
        for (const c of classes) { const sp = document.createElement("span"); sp.className = c; host.appendChild(sp); host = sp; }
        host.appendChild(document.createTextNode(part));
      });
      return;
    }
    if (node.nodeType === Node.ELEMENT_NODE) {
      const cls = (node as Element).getAttribute("class");
      for (const ch of [...node.childNodes]) walk(ch, cls ? [...classes, cls] : classes);
    }
  };
  for (const ch of [...code.childNodes]) walk(ch, []);
  // the trailing newline of a fenced block is not a line of its own
  while (lines.length > 1 && !lines[lines.length - 1]!.textContent) lines.pop();
  return lines;
}

/** Wrap a rendered <pre><code> in a code block: header (language · wrap · copy), numbered lines */
function decorateCodeBlock(pre: HTMLPreElement, code: HTMLElement, raw: string, lang: string): void {
  if (pre.parentElement?.classList.contains("cb")) return;
  const box = document.createElement("div");
  box.className = "cb";
  const head = document.createElement("div");
  head.className = "cb-head";
  const label = document.createElement("span");
  label.className = "cb-lang";
  label.textContent = lang || "text";
  const acts = document.createElement("span");
  acts.className = "cb-acts";
  const btn = (title: string, d: string, cls: string) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `cb-btn ${cls}`;
    b.title = title;
    b.setAttribute("aria-label", title);
    b.appendChild(svgIcon(d));
    return b;
  };
  const wrap = btn(t("timeline.codeWrap"), ICON_WRAP, "cb-wrap");
  wrap.setAttribute("aria-pressed", "false");
  wrap.onclick = () => {
    const on = !box.classList.contains("wrap");
    box.classList.toggle("wrap", on);
    wrap.setAttribute("aria-pressed", String(on));
  };
  const copy = btn(t("common.copy"), ICON_COPY, "cb-copy");
  copy.onclick = () => {
    void copyText(raw).then(() => {
      copy.replaceChildren(svgIcon(ICON_CHECK));
      copy.classList.add("done");
      setTimeout(() => { copy.replaceChildren(svgIcon(ICON_COPY)); copy.classList.remove("done"); }, 1200);
    });
  };
  acts.append(wrap, copy);
  head.append(label, acts);
  const lines = splitCodeLines(code);
  if (lines.length > 1) {
    code.replaceChildren(...lines);
    box.classList.add("numbered");
  }
  pre.replaceWith(box);
  box.append(head, pre);
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
