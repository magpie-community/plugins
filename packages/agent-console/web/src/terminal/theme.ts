import type { ITheme } from "@xterm/xterm";

/** Matches data-theme / the system light-dark setting; doesn't use --fg directly (a transparent background + black canvas would smear together) */
export function isDarkUiTheme(): boolean {
  const t = document.documentElement.dataset.theme;
  if (t === "dark") return true;
  if (t === "light") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Windows Terminal style; PowerShell's blue/yellow prompts stay legible in both light and dark */
export function xtermTheme(): ITheme {
  if (isDarkUiTheme()) {
    return {
      background: "#0c0c0c",
      foreground: "#cccccc",
      cursor: "#cccccc",
      cursorAccent: "#0c0c0c",
      selectionBackground: "#264f78",
      selectionForeground: "#ffffff",
      black: "#0c0c0c",
      red: "#f14c4c",
      green: "#23d18b",
      yellow: "#f5f543",
      blue: "#3b8eea",
      magenta: "#d670d6",
      cyan: "#29b8db",
      white: "#cccccc",
      brightBlack: "#666666",
      brightRed: "#f14c4c",
      brightGreen: "#23d18b",
      brightYellow: "#f5f543",
      brightBlue: "#3b8eea",
      brightMagenta: "#d670d6",
      brightCyan: "#29b8db",
      brightWhite: "#ffffff",
    };
  }
  return {
    background: "#ffffff",
    foreground: "#1e1e1e",
    cursor: "#1e1e1e",
    cursorAccent: "#ffffff",
    selectionBackground: "#add6ff",
    selectionForeground: "#1e1e1e",
    black: "#000000",
    red: "#cd3131",
    green: "#00bc00",
    yellow: "#949800",
    blue: "#0451a5",
    magenta: "#bc05bc",
    cyan: "#0598bc",
    white: "#555555",
    brightBlack: "#666666",
    brightRed: "#cd3131",
    brightGreen: "#14ce14",
    brightYellow: "#b5ba00",
    brightBlue: "#0451a5",
    brightMagenta: "#bc05bc",
    brightCyan: "#0598bc",
    brightWhite: "#a5a5a5",
  };
}
