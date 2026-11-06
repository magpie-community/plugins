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

/**
 * Whether a fenced code token from marked ended on its own closing fence (not at the end of the input).
 * `raw` is the token's raw source (marked has already taken off any blockquote / list indentation).
 * Mirrors marked's fence rule: opening ` {0,3}(`{3,}|~{3,})`, closing ` {0,3}<same fence>[~`]* *` on its own line.
 * An indented code block has no fence: it can always grow while the text streams, so it is never "closed".
 */
export function isClosedFence(raw: string, codeBlockStyle?: string): boolean {
  if (codeBlockStyle === "indented") return false;
  const lines = raw.replace(/\n+$/, "").split("\n");
  if (lines.length < 2) return false;
  const open = /^ {0,3}(`{3,}|~{3,})/.exec(lines[0]!);
  if (!open) return false;
  const fence = open[1]!;
  const last = lines[lines.length - 1]!;
  const m = /^ {0,3}([`~]+) *$/.exec(last);
  if (!m) return false;
  const run = m[1]!;
  // same fence (char and at least its length) first; marked lets any mix of ` / ~ follow it
  return run.startsWith(fence);
}

type AutoResult = { value: string; language: string };
const AUTO_CACHE_MAX = 128;
const autoCache = new Map<string, AutoResult>();

/** hljs.highlightAuto with a small LRU: a streaming message re-renders every frame, and a block that is
 *  already closed (or a settled message re-rendered) must not pay highlightAuto again. */
export function highlightAutoCached(code: string): AutoResult {
  const hit = autoCache.get(code);
  if (hit) {
    autoCache.delete(code);
    autoCache.set(code, hit);
    return hit;
  }
  let out: AutoResult;
  try {
    const res = hljs.highlightAuto(code);
    out = { value: res.value, language: res.language ?? "" };
  } catch {
    out = { value: escapeHtml(code), language: "" };
  }
  autoCache.set(code, out);
  if (autoCache.size > AUTO_CACHE_MAX) autoCache.delete(autoCache.keys().next().value!);
  return out;
}

/** test hook */
export function autoCacheSize(): number {
  return autoCache.size;
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

// The model's markdown is sanitized with DOMPurify's html profile only (no <svg>), so the code block chrome can't
// carry its icons through sanitize. The renderer writes these per-load random placeholders instead (plain text
// to DOMPurify), and restoreCodeBlockIcons swaps them for the static icons right after sanitize — still one pass.
function randomHex(): string {
  const b = new Uint8Array(12);
  globalThis.crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
const ICON_NONCE = randomHex();
export const WRAP_ICON_TOKEN = `__AC_CB_WRAP_${ICON_NONCE}__`;
export const COPY_ICON_TOKEN = `__AC_CB_COPY_${ICON_NONCE}__`;

/** Put the trusted icons into sanitized markdown HTML (replaces only the exact placeholders) */
export function restoreCodeBlockIcons(html: string): string {
  return html.split(WRAP_ICON_TOKEN).join(SVG(ICON_WRAP)).split(COPY_ICON_TOKEN).join(SVG(ICON_COPY));
}

export type CodeBlockLabels = { wrap: string; copy: string };

/**
 * Build the final .cb HTML (header + optional numbered lines + highlighted body) in one pass.
 * The buttons carry WRAP_ICON_TOKEN / COPY_ICON_TOKEN; restoreCodeBlockIcons turns them into icons after sanitize.
 * autoDetect: a block with no language label gets hljs.highlightAuto and the detected language as its label
 * (as 1.3.6 did). The renderer turns it off only for a still-open trailing fence of a streaming message, so the
 * label and colours can't flip while tokens arrive; it is on for closed blocks and settled messages.
 */
export function buildCodeBlockHtml(
  raw: string,
  lang: string | undefined,
  index: number,
  labels: CodeBlockLabels,
  wrapped = false,
  autoDetect = true,
): string {
  let fence = sanitizeLang(lang);
  const bodyRaw = raw.replace(/\n$/, "");
  let hl: string;
  try {
    if (fence && hljs.getLanguage(fence)) {
      hl = hljs.highlight(bodyRaw, { language: fence }).value;
    } else if (!fence && autoDetect && bodyRaw) {
      const auto = highlightAutoCached(bodyRaw);
      hl = auto.value;
      fence = sanitizeLang(auto.language);
    } else {
      hl = escapeHtml(bodyRaw);
    }
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
          `<button type="button" class="cb-btn cb-wrap" title="${wrapTitle}" aria-label="${wrapTitle}" aria-pressed="${wrapped}">${WRAP_ICON_TOKEN}</button>` +
          `<button type="button" class="cb-btn cb-copy" title="${copyTitle}" aria-label="${copyTitle}" data-i="${index}">${COPY_ICON_TOKEN}</button>` +
        `</span>` +
      `</div>` +
      `<pre><code class="hljs${fence ? ` language-${fence}` : ""}">${body}</code></pre>` +
    `</div>`
  );
}
