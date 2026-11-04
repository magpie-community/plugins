// 1.3 "添加到对话": quote normalising, the chip list, the text sent to the Agent, the bubble split and the popup position.
import { describe, it, expect } from "vitest";
import { quotesFromText, addQuote, normalizeQuote, quotesToText, splitQuotes, quoteLabel, placeQuotePop, MAX_QUOTES, MAX_QUOTE_CHARS, type Quote } from "./quotes.js";

describe("normalizeQuote", () => {
  it("drops CR, nbsp, trailing blanks and runs of empty lines", () => {
    expect(normalizeQuote("\n\na  \r\n\r\n\r\n\r\nb\u00a0c\t\n\n")).toBe("a\n\nb c");
  });
  it("keeps leading indentation (code)", () => {
    expect(normalizeQuote("  if (x) {\n    y();\n  }")).toBe("  if (x) {\n    y();\n  }");
  });
  it("caps very long selections", () => {
    const s = normalizeQuote("x".repeat(MAX_QUOTE_CHARS + 50));
    expect(s.length).toBe(MAX_QUOTE_CHARS + 1);
    expect(s.endsWith("…")).toBe(true);
  });
});

describe("addQuote", () => {
  it("adds, dedupes by text and source, ignores blanks, caps the list", () => {
    let l: Quote[] = [];
    l = addQuote(l, "hello");
    l = addQuote(l, "hello  ");
    expect(l).toHaveLength(1);
    l = addQuote(l, "hello", "src/a.ts");
    expect(l).toHaveLength(2);
    const same = addQuote(l, "   \n ");
    expect(same).toBe(l);
    for (let i = 0; i < 20; i++) l = addQuote(l, `q${i}`);
    expect(l).toHaveLength(MAX_QUOTES);
    expect(new Set(l.map((q) => q.id)).size).toBe(MAX_QUOTES);
  });
});

describe("quotesToText / splitQuotes", () => {
  const qs: Quote[] = [
    { id: "1", text: "第一段\n\n第二段" },
    { id: "2", text: "const x = 1;", src: "src/index.ts" },
  ];
  it("sends each quote as a > block, the source first, then the message", () => {
    expect(quotesToText(qs, "这是什么？")).toBe("> 第一段\n>\n> 第二段\n\n> [src/index.ts]\n> const x = 1;\n\n这是什么？");
  });
  it("quotes only (no typed text) and no quotes", () => {
    expect(quotesToText(qs.slice(0, 1), "  ")).toBe("> 第一段\n>\n> 第二段");
    expect(quotesToText([], "hi")).toBe("hi");
  });
  it("round-trips for the bubble", () => {
    const sp = splitQuotes(quotesToText(qs, "这是什么？\n\n第二行"));
    expect(sp.quotes).toEqual(["第一段\n\n第二段", "[src/index.ts]\nconst x = 1;"]);
    expect(sp.rest).toBe("这是什么？\n\n第二行");
  });
  it("a message that is only a quote, or a > later on, stays plain text", () => {
    expect(splitQuotes("> just a quote")).toEqual({ quotes: [], rest: "> just a quote" });
    expect(splitQuotes("hi\n\n> not leading")).toEqual({ quotes: [], rest: "hi\n\n> not leading" });
    expect(splitQuotes(">no space\n\nhi").quotes).toEqual([]);
  });
});

describe("quoteLabel", () => {
  it("first non-empty line, shortened", () => {
    expect(quoteLabel({ id: "a", text: "\n  hello   world \nnext" })).toBe("hello world");
    expect(quoteLabel({ id: "a", text: "x".repeat(40) }, 10)).toBe("xxxxxxxxx…");
  });
});

describe("placeQuotePop", () => {
  const area = { left: 0, right: 600, top: 50, bottom: 700 };
  const pop = { w: 110, h: 30 };
  it("above the selection, at its first line", () => {
    const p = placeQuotePop([{ left: 100, right: 400, top: 300, bottom: 320 }, { left: 20, right: 200, top: 320, bottom: 340 }], area, pop, 600);
    expect(p).toEqual({ left: 100, top: 300 - 6 - 30, side: "above" });
  });
  it("below when there is no room above; never over the selection", () => {
    const p = placeQuotePop([{ left: 100, right: 400, top: 60, bottom: 80 }], area, pop, 600)!;
    expect(p.side).toBe("below");
    expect(p.top).toBeGreaterThanOrEqual(80);
  });
  it("inside the visible area (above the composer) when the selection fills it", () => {
    const p = placeQuotePop([{ left: 10, right: 590, top: 40, bottom: 710 }], area, pop, 600)!;
    expect(p.side).toBe("inside");
    expect(p.top + pop.h).toBeLessThanOrEqual(area.bottom);
  });
  it("clamped inside a narrow window", () => {
    const p = placeQuotePop([{ left: 560, right: 598, top: 300, bottom: 320 }], area, pop, 600)!;
    expect(p.left + pop.w).toBeLessThanOrEqual(600 - 8);
    const q = placeQuotePop([{ left: -20, right: 50, top: 300, bottom: 320 }], area, pop, 600)!;
    expect(q.left).toBeGreaterThanOrEqual(8);
  });
  it("nothing when the selection is scrolled out of view", () => {
    expect(placeQuotePop([{ left: 10, right: 50, top: 0, bottom: 20 }], area, pop, 600)).toBeNull();
    expect(placeQuotePop([], area, pop, 600)).toBeNull();
  });
});

describe("quotesFromText (编辑 on a sent message)", () => {
  it("gives the chips back, with their source", () => {
    const qs: Quote[] = [{ id: "1", text: "a\n\nb" }, { id: "2", text: "x = 1", src: "src/a.ts" }];
    const back = quotesFromText(quotesToText(qs, "问题"));
    expect(back.rest).toBe("问题");
    expect(back.quotes.map((q) => [q.text, q.src])).toEqual([["a\n\nb", undefined], ["x = 1", "src/a.ts"]]);
  });
  it("plain messages come back unchanged", () => {
    expect(quotesFromText("> hi")).toEqual({ quotes: [], rest: "> hi" });
  });
});
