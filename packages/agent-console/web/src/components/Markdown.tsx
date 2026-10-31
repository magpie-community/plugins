// Markdown rendering: marked + DOMPurify + highlight.js (languages on demand, code blocks with a copy button).
import { useMemo, useRef, useEffect } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";

marked.setOptions({ gfm: true, breaks: true });

const purify = (html: string) =>
  DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, ADD_ATTR: ["target", "rel"] });

export function renderMarkdown(text: string): string {
  return purify(marked.parse(text, { async: false }));
}

export function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const html = useMemo(() => renderMarkdown(text), [text]);

  // After rendering: highlight code blocks + copy button; external links target=_blank
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    for (const a of el.querySelectorAll("a[href^='http']")) {
      (a as HTMLAnchorElement).target = "_blank";
      (a as HTMLAnchorElement).rel = "noopener";
    }
    for (const pre of el.querySelectorAll("pre")) {
      const code = pre.querySelector("code");
      if (code && !code.dataset.hl) {
        code.dataset.hl = "1";
        try { hljs.highlightElement(code as HTMLElement); } catch {}
      }
      if (!pre.querySelector(".cb-copy")) {
        const btn = document.createElement("button");
        btn.className = "cb-copy";
        btn.textContent = "复制";
        btn.onclick = () => {
          const t = code?.textContent ?? "";
          void copyText(t).then(() => { btn.textContent = "已复制"; setTimeout(() => (btn.textContent = "复制"), 1200); });
        };
        pre.appendChild(btn);
      }
    }
  }, [html]);

  return (
    <div
      ref={ref}
      className={`md${streaming ? " streaming" : ""}`}
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
