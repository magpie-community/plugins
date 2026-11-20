/** Same stack the terminal used before it followed --font-mono. Used only when that variable is empty. */
export const TERMINAL_FONT_FALLBACK =
  '"Cascadia Mono", "Cascadia Code", Consolas, "SF Mono", Menlo, Monaco, "DejaVu Sans Mono", "Ubuntu Mono", ' +
  '"Microsoft YaHei UI", "PingFang SC", "Noto Sans Mono CJK SC", monospace';

export type TerminalFont = { fontFamily: string; fontSize: number };

export type TerminalFontReading = {
  fontMono: string;
  bodyFontSize: string;
};

type ComputedFontStyle = {
  getPropertyValue(name: string): string;
  fontSize: string;
};

export type TerminalFontSource = {
  documentElement: object;
  body: object;
  getComputedStyle(el: object): ComputedFontStyle;
};

/** --font-mono (trimmed) and the body's computed font size, with the old stack and 13px when either is empty or not a number. */
export function resolveTerminalFont(reading: TerminalFontReading): TerminalFont {
  const fontFamily = reading.fontMono.trim() || TERMINAL_FONT_FALLBACK;
  return { fontFamily, fontSize: parseFloat(reading.bodyFontSize) || 13 };
}

/** Read --font-mono from the document element and the computed font size from body. */
export function readTerminalFont(source?: TerminalFontSource): TerminalFont {
  const root = source?.documentElement ?? document.documentElement;
  const body = source?.body ?? document.body;
  const styleOf = source?.getComputedStyle ?? ((el: object) => getComputedStyle(el as Element));
  return resolveTerminalFont({
    fontMono: styleOf(root).getPropertyValue("--font-mono"),
    bodyFontSize: styleOf(body).fontSize,
  });
}
