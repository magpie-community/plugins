// Conversation column width and chat text size (1.2 settings). Both are CSS variables on <html>:
//   --col      the column the timeline and the composer share (720px by default)
//   --chat-fs  chat text size; tokens.css derives code (1px smaller), headings and line heights from it
export type ContentWidth = "narrow" | "default" | "wide" | "full";
export const CONTENT_WIDTHS: ContentWidth[] = ["narrow", "default", "wide", "full"];
export const WIDTH_PX: Record<Exclude<ContentWidth, "full">, number> = { narrow: 640, default: 720, wide: 880 };
export const CHAT_FONT_MIN = 12;
export const CHAT_FONT_MAX = 18;
export const CHAT_FONT_DEFAULT = 13;

export function normalizeContentWidth(v: unknown): ContentWidth {
  return v === "narrow" || v === "wide" || v === "full" ? v : "default";
}

/** CSS value of --col for a width setting */
export function colValue(v: unknown): string {
  const w = normalizeContentWidth(v);
  return w === "full" ? "100%" : `${WIDTH_PX[w]}px`;
}

export function normalizeChatFont(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return CHAT_FONT_DEFAULT;
  return Math.min(CHAT_FONT_MAX, Math.max(CHAT_FONT_MIN, Math.round(n)));
}

export function applyChatLayout(s: { contentWidth?: unknown; chatFontSize?: unknown }): void {
  const root = document.documentElement;
  root.style.setProperty("--col", colValue(s.contentWidth));
  root.style.setProperty("--chat-fs", `${normalizeChatFont(s.chatFontSize)}px`);
  root.dataset.contentWidth = normalizeContentWidth(s.contentWidth);
}
