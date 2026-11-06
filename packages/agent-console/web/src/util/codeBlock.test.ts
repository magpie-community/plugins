import { describe, it, expect } from "vitest";
import {
  buildCodeBlockHtml,
  codeBlockKey,
  escapeHtml,
  sanitizeLang,
  splitHljsHtmlLines,
} from "./codeBlock";

describe("codeBlock helpers (1.3.7 single-pass markdown)", () => {
  it("escapeHtml encodes markup characters", () => {
    expect(escapeHtml(`<img onerror="alert(1)"> & "`)).toBe(
      "&lt;img onerror=&quot;alert(1)&quot;&gt; &amp; &quot;",
    );
  });

  it("sanitizeLang keeps safe language ids only", () => {
    expect(sanitizeLang("ts")).toBe("ts");
    expect(sanitizeLang("c++")).toBe("c++");
    expect(sanitizeLang("js;alert(1)")).toBe("js");
    expect(sanitizeLang("")).toBe("");
    expect(sanitizeLang(undefined)).toBe("");
  });

  it("splitHljsHtmlLines re-opens spans across newlines", () => {
    const hl = `<span class="hljs-keyword">const</span> x;\n<span class="hljs-title function_">fn</span>()`;
    expect(splitHljsHtmlLines(hl)).toEqual([
      `<span class="hljs-keyword">const</span> x;`,
      `<span class="hljs-title function_">fn</span>()`,
    ]);
    // span that wraps a newline
    const cross = `<span class="hljs-string">"a\nb"</span>`;
    expect(splitHljsHtmlLines(cross)).toEqual([
      `<span class="hljs-string">"a</span>`,
      `<span class="hljs-string">b"</span>`,
    ]);
  });

  it("buildCodeBlockHtml emits .cb chrome with numbered lines and no bare script", () => {
    const html = buildCodeBlockHtml("const x = 1;\nconsole.log(x);", "js", 3, {
      wrap: "Wrap lines",
      copy: "Copy",
    });
    expect(html).toContain('class="cb numbered"');
    expect(html).toContain('class="cb-lang">js<');
    expect(html).toContain('data-i="3"');
    expect(html).toContain('class="cb-l"');
    expect(html).toContain("hljs-keyword");
    expect(html).not.toContain("<script");
    expect(html).toContain("<button type=\"button\" class=\"cb-btn cb-wrap\"");
    expect(html).toContain("<button type=\"button\" class=\"cb-btn cb-copy\"");
  });

  it("buildCodeBlockHtml escapes unknown-language body text", () => {
    const html = buildCodeBlockHtml(`<img onerror=alert(1)>\n<script>x</script>`, "notalang", 0, {
      wrap: "w",
      copy: "c",
    });
    expect(html).toContain("&lt;img onerror=alert(1)&gt;");
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(html).not.toMatch(/<img\s/i);
    expect(html).not.toMatch(/<script>/i);
  });

  it("codeBlockKey is stable for the same source", () => {
    expect(codeBlockKey("abc")).toBe(codeBlockKey("abc"));
    expect(codeBlockKey("abc")).not.toBe(codeBlockKey("abcd"));
  });

  it("buildCodeBlockHtml bakes a wrapped block's .wrap and aria-pressed into the HTML", () => {
    const off = buildCodeBlockHtml("a\nb", "ts", 0, { wrap: "w", copy: "c" });
    expect(off).toMatch(/^<div class="cb numbered">/);
    expect(off).toContain('aria-pressed="false"');
    const on = buildCodeBlockHtml("a\nb", "ts", 0, { wrap: "w", copy: "c" }, true);
    expect(on).toMatch(/^<div class="cb numbered wrap">/);
    expect(on).toContain('class="cb-btn cb-wrap" title="w" aria-label="w" aria-pressed="true"');
  });
});
