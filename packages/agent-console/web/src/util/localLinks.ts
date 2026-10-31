// Local addresses in chat text (1.2): localhost:3000, http://127.0.0.1:5173/x, 0.0.0.0:8080, [::1]:4000, app.localhost:3000.
// Pure functions (unit tested) plus a DOM pass for rendered Markdown. A bare host needs a port to count
// ("runs on localhost" stays text); trailing punctuation (English and Chinese) is left out; LAN addresses (192.168.x, 10.x)
// are not local and stay ordinary external links.
import { checkPreviewUrl } from "../../../daemon/src/preview/url.js";

export type LocalLink = { start: number; end: number; text: string; url: string };

const HOST = String.raw`(?:localhost|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1?\])`;
const RE = new RegExp(String.raw`(https?:\/\/)?${HOST}(:\d{1,5})?((?:[/?#][^\s<>"'\`）】」』，。；！？、]*)?)`, "gi");
const TRAIL = /[.,;:!?。，；：！？…'"’”]+$/;

export function findLocalLinks(text: string): LocalLink[] {
  const out: LocalLink[] = [];
  if (!text) return out;
  RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE.exec(text))) {
    let start = m.index;
    let raw = m[0];
    const scheme = m[1];
    const port = m[2];
    // Must not be part of a longer word / host / path (xlocalhost:1, foo/localhost:1, user@localhost:1)
    const before = start > 0 ? text[start - 1]! : "";
    if (before && /[\w.@/\\:-]/.test(before)) continue;
    if (!scheme && !port) continue;
    // Drop trailing punctuation, and a closing bracket that has no opening one inside the match
    let trimmed = raw.replace(TRAIL, "");
    while (/[)\]]$/.test(trimmed)) {
      const close = trimmed.endsWith(")") ? ")" : "]";
      const open = close === ")" ? "(" : "[";
      const opens = trimmed.split(open).length - 1;
      const closes = trimmed.split(close).length - 1;
      if (closes > opens) trimmed = trimmed.slice(0, -1).replace(TRAIL, "");
      else break;
    }
    raw = trimmed;
    const c = checkPreviewUrl(raw);
    if (!c.ok) continue;
    out.push({ start, end: start + raw.length, text: raw, url: c.target.href });
    RE.lastIndex = start + Math.max(1, raw.length);
  }
  return out;
}

/** Text → alternating plain strings and links (for React rendering without innerHTML) */
export function splitLocalLinks(text: string): (string | LocalLink)[] {
  const links = findLocalLinks(text);
  if (!links.length) return [text];
  const parts: (string | LocalLink)[] = [];
  let at = 0;
  for (const l of links) {
    if (l.start > at) parts.push(text.slice(at, l.start));
    parts.push(l);
    at = l.end;
  }
  if (at < text.length) parts.push(text.slice(at));
  return parts;
}

/** Is this href a local address the preview can open? → its normalized URL */
export function localHref(href: string | null | undefined): string | null {
  if (!href || !/^https?:\/\//i.test(href)) return null;
  const c = checkPreviewUrl(href);
  return c.ok ? c.target.href : null;
}

const SKIP = new Set(["A", "BUTTON", "SCRIPT", "STYLE", "TEXTAREA"]);

function textNodesUnder(root: Node): Text[] {
  const out: Text[] = [];
  const walk = (n: Node) => {
    if (n.nodeType === 3) { out.push(n as Text); return; }
    if (n.nodeType !== 1) return;
    if (SKIP.has((n as Element).tagName)) return;
    for (let c = n.firstChild; c; c = c.nextSibling) walk(c);
  };
  walk(root);
  return out;
}

function wrapLinks(root: Node, nodes: Text[]): void {
  const full = nodes.map((n) => n.data).join("");
  const links = findLocalLinks(full);
  if (!links.length) return;
  // offsets → (node, offset)
  const starts: number[] = [];
  let acc = 0;
  for (const n of nodes) { starts.push(acc); acc += n.data.length; }
  const locate = (pos: number, end: boolean): [Text, number] => {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const s = starts[i]!;
      if (end ? pos > s : pos >= s) return [nodes[i]!, pos - s];
    }
    return [nodes[0]!, 0];
  };
  const doc = root.ownerDocument ?? document;
  // Back to front so earlier offsets stay valid
  for (const l of [...links].reverse()) {
    const [sn, so] = locate(l.start, false);
    const [en, eo] = locate(l.end, true);
    const range = doc.createRange();
    range.setStart(sn, so);
    range.setEnd(en, eo);
    const a = doc.createElement("a");
    a.href = l.url;
    a.dataset.acLocal = l.url;
    a.className = "ac-local";
    a.appendChild(range.extractContents());
    range.insertNode(a);
  }
}

/** Rendered Markdown: mark local <a href> links, and turn bare local addresses into links (code blocks too, across hljs spans) */
export function linkifyLocal(root: HTMLElement, title?: string): void {
  for (const a of Array.from(root.querySelectorAll("a[href]"))) {
    const u = localHref(a.getAttribute("href"));
    if (u) { (a as HTMLElement).dataset.acLocal = u; a.classList.add("ac-local"); }
  }
  // Code blocks: one pass over the whole block (a URL may be split across highlight spans)
  for (const pre of Array.from(root.querySelectorAll("pre"))) {
    if ((pre as HTMLElement).dataset.acLinked) continue;
    (pre as HTMLElement).dataset.acLinked = "1";
    wrapLinks(pre, textNodesUnder(pre));
  }
  // Everything else: per text node
  for (const n of textNodesUnder(root)) {
    if (n.parentElement?.closest("pre")) continue;
    if (!n.parentNode) continue;
    wrapLinks(n.parentNode, [n]);
  }
  if (title) for (const a of Array.from(root.querySelectorAll("a.ac-local"))) (a as HTMLElement).title = title;
}
