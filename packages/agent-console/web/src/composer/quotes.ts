// 1.3 "添加到对话": text selected in the conversation or the right panel becomes a quote chip in the composer.
// The quotes go out in front of the message as Markdown block quotes (what every Agent reads as "the user is
// pointing at this"); the composer's own text stays plain and editable.
export type Quote = { id: string; text: string; src?: string };

export const MAX_QUOTES = 10;
export const MAX_QUOTE_CHARS = 4000;

/** Selected text as it should be quoted: no trailing blanks per line, at most one empty line in a row, capped */
export function normalizeQuote(raw: string): string {
  let s = raw.replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ");
  s = s.split("\n").map((l) => l.replace(/\s+$/u, "")).join("\n");
  s = s.replace(/\n{3,}/g, "\n\n").replace(/^\n+|\n+$/g, "");
  if (s.length > MAX_QUOTE_CHARS) s = s.slice(0, MAX_QUOTE_CHARS).replace(/\s+$/u, "") + "…";
  return s;
}

let seq = 0;
/** Adds a quote; the same text from the same place is not added twice; the list is capped. Returns the same list when nothing changed. */
export function addQuote(list: Quote[], text: string, src?: string): Quote[] {
  const t = normalizeQuote(text);
  if (!t.trim()) return list;
  if (list.some((q) => q.text === t && q.src === src)) return list;
  if (list.length >= MAX_QUOTES) return list;
  return [...list, { id: `q${Date.now().toString(36)}${(seq++).toString(36)}`, text: t, src }];
}

/** The text sent to the Agent: each quote as a "> " block (its source path first when it has one), then the message */
export function quotesToText(quotes: Quote[], msg: string): string {
  if (!quotes.length) return msg;
  const blocks = quotes.map((q) => {
    const lines = q.text.split("\n").map((l) => (l ? `> ${l}` : ">"));
    return (q.src ? [`> [${q.src}]`, ...lines] : lines).join("\n");
  });
  return [...blocks, msg].filter((x) => x.trim()).join("\n\n");
}

/** Chip text: the first line, shortened */
export function quoteLabel(q: Quote, max = 28): string {
  const first = q.text.split("\n").find((l) => l.trim()) ?? "";
  const one = first.trim().replace(/\s+/g, " ");
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
}

export type Box = { left: number; top: number; right: number; bottom: number };

/**
 * Where the "添加到对话" button goes: above the selection when there is room in the visible area, else below it,
 * else (the selection fills the view) at the bottom of the visible area; never outside the window horizontally.
 * sel = the selection's line boxes (client coordinates), area = the part of the scroller that is visible
 * (for the chat: above the composer), pop = the button's size.
 */
export function placeQuotePop(sel: Box[], area: Box, pop: { w: number; h: number }, vw: number, gap = 6): { left: number; top: number; side: "above" | "below" | "inside" } | null {
  const lines = sel.filter((r) => r.bottom > area.top && r.top < area.bottom && r.right > r.left);
  if (!lines.length) return null;
  const top = Math.min(...lines.map((r) => r.top));
  const bottom = Math.max(...lines.map((r) => r.bottom));
  const first = lines.reduce((a, b) => (b.top < a.top ? b : a));
  const last = lines.reduce((a, b) => (b.bottom > a.bottom || (b.bottom === a.bottom && b.right > a.right) ? b : a));
  const clampX = (x: number) => Math.max(8, Math.min(x, vw - pop.w - 8));
  if (top - gap - pop.h >= area.top) return { left: clampX(first.left), top: top - gap - pop.h, side: "above" };
  if (bottom + gap + pop.h <= area.bottom) return { left: clampX(last.right - pop.w), top: bottom + gap, side: "below" };
  return { left: clampX(last.right - pop.w), top: Math.max(area.top, area.bottom - pop.h - gap), side: "inside" };
}

/** The reverse for display: leading "> " blocks of a sent message (the quotes) and the rest */
export function splitQuotes(text: string): { quotes: string[]; rest: string } {
  const blocks = text.split(/\n{2,}/);
  const quotes: string[] = [];
  let i = 0;
  for (; i < blocks.length; i++) {
    const lines = blocks[i]!.split("\n");
    if (!lines.every((l) => l === ">" || l.startsWith("> "))) break;
    quotes.push(lines.map((l) => (l === ">" ? "" : l.slice(2))).join("\n"));
  }
  // A message that is nothing but a quote keeps it as text (the user typed "> …" on purpose)
  if (i === blocks.length) return { quotes: [], rest: text };
  return { quotes, rest: blocks.slice(i).join("\n\n") };
}

/** "编辑" on a sent message: its leading quotes back as chips (the "[path]" line back as the source), the rest as text */
export function quotesFromText(text: string): { quotes: Quote[]; rest: string } {
  const sp = splitQuotes(text);
  let quotes: Quote[] = [];
  for (const q of sp.quotes) {
    const m = /^\[([^\]\n]+)\]\n([\s\S]*)$/.exec(q);
    quotes = m ? addQuote(quotes, m[2]!, m[1]) : addQuote(quotes, q);
  }
  return { quotes, rest: sp.rest };
}
