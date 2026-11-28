import { describe, expect, it } from "vitest";
import { TERMINAL_FONT_FALLBACK, readTerminalFont, resolveTerminalFont } from "./font";

describe("resolveTerminalFont", () => {
  it("reads a --font-mono stack and the computed body font size", () => {
    expect(resolveTerminalFont({
      fontMono: '"JetBrains Mono", ui-monospace, monospace',
      bodyFontSize: "15px",
    })).toEqual({
      fontFamily: '"JetBrains Mono", ui-monospace, monospace',
      fontSize: 15,
    });
    expect(resolveTerminalFont({ fontMono: "Menlo, monospace", bodyFontSize: "13.5px" }).fontSize).toBe(13.5);
  });

  it("falls back to the monospace stack when --font-mono is empty", () => {
    for (const fontMono of ["", "   ", "\n"]) {
      const font = resolveTerminalFont({ fontMono, bodyFontSize: "14px" });
      expect(font.fontFamily).toBe(TERMINAL_FONT_FALLBACK);
      expect(font.fontFamily).toContain("Cascadia Mono");
      expect(font.fontFamily).toContain("monospace");
      expect(font.fontSize).toBe(14);
    }
  });

  it("falls back to 13 when the body font size is empty, invalid, or NaN", () => {
    for (const bodyFontSize of ["", "   ", "auto", "NaN", "px", "0px"]) {
      expect(resolveTerminalFont({ fontMono: "Menlo, monospace", bodyFontSize })).toEqual({
        fontFamily: "Menlo, monospace",
        fontSize: 13,
      });
    }
  });
});

describe("readTerminalFont", () => {
  it("reads --font-mono and the computed body font size", () => {
    const root = { id: "root" };
    const body = { id: "body" };
    const font = readTerminalFont({
      documentElement: root,
      body,
      getComputedStyle(el) {
        if (el === root) {
          return {
            fontSize: "13px",
            getPropertyValue: (name) => (name === "--font-mono" ? '  "SF Mono", Menlo, monospace  ' : ""),
          };
        }
        return { fontSize: "16px", getPropertyValue: () => "" };
      },
    });
    expect(font).toEqual({ fontFamily: '"SF Mono", Menlo, monospace', fontSize: 16 });
  });

  it("falls back when the computed values are empty or not a number", () => {
    const font = readTerminalFont({
      documentElement: {},
      body: {},
      getComputedStyle: () => ({ fontSize: "medium", getPropertyValue: () => "  " }),
    });
    expect(font).toEqual({ fontFamily: TERMINAL_FONT_FALLBACK, fontSize: 13 });
  });
});
