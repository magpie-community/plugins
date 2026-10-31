// Markdown rendering: marked + DOMPurify + highlight.js (languages on demand, code blocks with a copy button).
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
      if (code && !code.dataset.hl) {
        code.dataset.hl = "1";
        try { hljs.highlightElement(code as HTMLElement); } catch {}
      }
      if (!pre.querySelector(".cb-copy")) {
        const btn = document.createElement("button");
        btn.className = "cb-copy";
        btn.type = "button";
        btn.textContent = t("common.copy");
        btn.onclick = () => {
          const txt = code?.textContent ?? "";
          void copyText(txt).then(() => { btn.textContent = t("common.copied"); setTimeout(() => (btn.textContent = t("common.copy")), 1200); });
        };
        pre.appendChild(btn);
      }
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
