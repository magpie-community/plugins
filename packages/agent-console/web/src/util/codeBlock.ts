// Pure helpers for fenced-code HTML: highlight + line split + .cb chrome in one string,
// so React can paint the final height on the first commit (no post-paint decorate flicker).
import hljs from "highlight.js/lib/common";

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function sanitizeLang(lang: string | undefined | null): string {
  if (!lang) return "";
  const m = /[\w+#.-]+/.exec(lang.trim());
  return m?.[0] ?? "";
}

/** Fingerprint of a code block's source (kept for callers/tests; wrap state itself is keyed by the block's index
 *  in its message, which survives a streaming block growing — this key changes with every token) */
export function codeBlockKey(raw: string): string {
  return `${raw.length}:${raw.slice(0, 96)}`;
}

const OPEN_RE = /^<span\s+class="([^"]*)">/i;
const CLOSE_RE = /^<\/span>/i;

/**
 * Split highlight.js HTML into one HTML fragment per source line.
 * Spans that cross a newline are closed and re-opened on the next line (matches prior DOM walk).
 */
export function splitHljsHtmlLines(hl: string): string[] {
  const lines: string[] = [""];
  let i = 0;
  const stack: string[] = [];
  const openSpan = (cls: string) => `<span class="${cls}">`;

  while (i < hl.length) {
    if (hl.charCodeAt(i) === 10 /* \n */) {
      for (let k = stack.length - 1; k >= 0; k--) lines[lines.length - 1] += "</span>";
      lines.push("");
      for (const cls of stack) lines[lines.length - 1] += openSpan(cls);
      i += 1;
      continue;
    }
    if (hl[i] === "<") {
      const rest = hl.slice(i);
      const open = OPEN_RE.exec(rest);
      if (open) {
        stack.push(open[1]!);
        lines[lines.length - 1] += open[0];
        i += open[0].length;
        continue;
      }
      const close = CLOSE_RE.exec(rest);
      if (close) {
        stack.pop();
        lines[lines.length - 1] += close[0];
        i += close[0].length;
        continue;
      }
    }
    // text / entities / any other tag char — copy through until next < or \n
    let j = i + 1;
    while (j < hl.length && hl[j] !== "<" && hl.charCodeAt(j) !== 10) j++;
    lines[lines.length - 1] += hl.slice(i, j);
    i = j;
  }

  while (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

const SVG = (d: string) =>
  `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"></path></svg>`;

export const ICON_COPY = "M8 8h11v12H8zM5 16V4h11";
export const ICON_CHECK = "M5 13l4 4L19 7";
export const ICON_WRAP = "M4 6h16M4 12h13a3 3 0 0 1 0 6h-4m2-2-2 2 2 2M4 18h5";

export function svgIconHtml(d: string): string {
  return SVG(d);
}

export type CodeBlockLabels = { wrap: string; copy: string };

/** Build the final .cb HTML (header + optional numbered lines + highlighted body) in one pass */
export function buildCodeBlockHtml(raw: string, lang: string | undefined, index: number, labels: CodeBlockLabels, wrapped = false): string {
  const fence = sanitizeLang(lang);
  const bodyRaw = raw.replace(/\n$/, "");
  let hl: string;
  try {
    hl = fence && hljs.getLanguage(fence)
      ? hljs.highlight(bodyRaw, { language: fence }).value
      : escapeHtml(bodyRaw);
  } catch {
    hl = escapeHtml(bodyRaw);
  }
  const lines = splitHljsHtmlLines(hl);
  const numbered = lines.length > 1;
  const body = numbered
    ? lines.map((l) => `<span class="cb-l">${l}</span>`).join("")
    : (lines[0] ?? "");
  const langLabel = escapeHtml(fence || "text");
  const wrapTitle = escapeHtml(labels.wrap);
  const copyTitle = escapeHtml(labels.copy);
  const cls = `cb${numbered ? " numbered" : ""}${wrapped ? " wrap" : ""}`;
  return (
    `<div class="${cls}">` +
      `<div class="cb-head">` +
        `<span class="cb-lang">${langLabel}</span>` +
        `<span class="cb-acts">` +
          `<button type="button" class="cb-btn cb-wrap" title="${wrapTitle}" aria-label="${wrapTitle}" aria-pressed="${wrapped}">${SVG(ICON_WRAP)}</button>` +
          `<button type="button" class="cb-btn cb-copy" title="${copyTitle}" aria-label="${copyTitle}" data-i="${index}">${SVG(ICON_COPY)}</button>` +
        `</span>` +
      `</div>` +
      `<pre><code class="hljs${fence ? ` language-${fence}` : ""}">${body}</code></pre>` +
    `</div>`
  );
}
