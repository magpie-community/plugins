import { describe, it, expect } from "vitest";
import { marked } from "marked";
import {
  autoCacheSize,
  buildCodeBlockHtml,
  COPY_ICON_TOKEN,
  WRAP_ICON_TOKEN,
  escapeHtml,
  highlightAutoCached,
  isClosedFence,
  restoreCodeBlockIcons,
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

  it("buildCodeBlockHtml bakes a wrapped block's .wrap and aria-pressed into the HTML", () => {
    const off = buildCodeBlockHtml("a\nb", "ts", 0, { wrap: "w", copy: "c" });
    expect(off).toMatch(/^<div class="cb numbered">/);
    expect(off).toContain('aria-pressed="false"');
    const on = buildCodeBlockHtml("a\nb", "ts", 0, { wrap: "w", copy: "c" }, true);
    expect(on).toMatch(/^<div class="cb numbered wrap">/);
    expect(on).toContain('class="cb-btn cb-wrap" title="w" aria-label="w" aria-pressed="true"');
  });

  it("buildCodeBlockHtml emits icon placeholders that restoreCodeBlockIcons turns into the trusted <svg> icons", () => {
    const html = buildCodeBlockHtml("x", "ts", 0, { wrap: "w", copy: "c" });
    expect(html).not.toContain("<svg");
    expect(html).toContain(WRAP_ICON_TOKEN);
    expect(html).toContain(COPY_ICON_TOKEN);
    expect(WRAP_ICON_TOKEN).toMatch(/^__AC_CB_WRAP_[0-9a-f]{24}__$/);
    expect(COPY_ICON_TOKEN).toMatch(/^__AC_CB_COPY_[0-9a-f]{24}__$/);
    const out = restoreCodeBlockIcons(html);
    expect(out).not.toContain(WRAP_ICON_TOKEN);
    expect(out).not.toContain(COPY_ICON_TOKEN);
    expect(out.match(/<svg /g)?.length).toBe(2);
    // a look-alike the model could type is left alone
    expect(restoreCodeBlockIcons("__AC_CB_WRAP_000000000000000000000000__")).toBe("__AC_CB_WRAP_000000000000000000000000__");
  });

  // ---- unlabelled fences (yetone review on 1.3.7): 1.3.6 auto-detected them; keep that ----
  const py = "def greet(name):\n    return f\"hi {name}\"\n\nclass A:\n    pass\n";

  it("an unlabelled block is auto-highlighted and labelled with the detected language", () => {
    const html = buildCodeBlockHtml(py, "", 0, { wrap: "w", copy: "c" });
    expect(html).toContain('class="cb-lang">python<');
    expect(html).toContain('class="hljs language-python"');
    expect(html).toMatch(/hljs-(keyword|title|string)/);
    // same as asking highlight.js directly (1.3.6's highlightElement → highlightAuto)
    expect(highlightAutoCached(py.replace(/\n$/, "")).language).toBe("python");
  });

  it("autoDetect=false (an open fence while streaming) stays plain \"text\"", () => {
    const html = buildCodeBlockHtml(py, "", 0, { wrap: "w", copy: "c" }, false, false);
    expect(html).toContain('class="cb-lang">text<');
    expect(html).toContain('<code class="hljs">');
    expect(html).not.toMatch(/hljs-(keyword|title|string)/);
  });

  it("an explicit language still uses it (no auto-detection), autoDetect or not", () => {
    for (const auto of [true, false]) {
      const html = buildCodeBlockHtml("const x: number = 1;", "ts", 0, { wrap: "w", copy: "c" }, false, auto);
      expect(html).toContain('class="cb-lang">ts<');
      expect(html).toContain('class="hljs language-ts"');
      expect(html).toContain("hljs-keyword");
    }
    // an unknown label is kept as the label and not auto-detected
    const unk = buildCodeBlockHtml(py, "notalang", 0, { wrap: "w", copy: "c" });
    expect(unk).toContain('class="cb-lang">notalang<');
    expect(unk).not.toMatch(/hljs-(keyword|title|string)/);
  });

  it("an empty unlabelled block is \"text\"", () => {
    expect(buildCodeBlockHtml("", "", 0, { wrap: "w", copy: "c" })).toContain('class="cb-lang">text<');
  });

  it("highlightAuto results are cached (bounded) so a re-render doesn't run it again", () => {
    const code = "SELECT id, name FROM users WHERE id = 1;";
    const a = highlightAutoCached(code);
    expect(highlightAutoCached(code)).toBe(a);
    for (let i = 0; i < 300; i++) highlightAutoCached(`x${i}`);
    expect(autoCacheSize()).toBeLessThanOrEqual(128);
    expect(highlightAutoCached(code)).not.toBe(a); // evicted, recomputed
  });

  it("isClosedFence matches marked's fence rule for backticks, tildes, indents, and EOF", () => {
    const fence = (md: string) => {
      const out: { raw: string; style?: string }[] = [];
      marked.walkTokens(marked.lexer(md), (tk) => {
        if (tk.type === "code") out.push({ raw: tk.raw, style: (tk as { codeBlockStyle?: string }).codeBlockStyle });
      });
      expect(out.length).toBe(1);
      return isClosedFence(out[0]!.raw, out[0]!.style);
    };
    // closed
    expect(fence("```\nfoo\n```")).toBe(true);
    expect(fence("```\nfoo\n```\nafter")).toBe(true);
    expect(fence("```\nfoo\n```\n\n")).toBe(true);
    expect(fence("~~~\nfoo\n~~~")).toBe(true);
    expect(fence("~~~~\nx\n~~~~~  \n\nz")).toBe(true);
    expect(fence("   ```\nx\n   ```")).toBe(true);
    expect(fence("````\nx\n`````")).toBe(true);
    expect(fence("```\n```")).toBe(true);
    expect(fence("> ```\n> a\n> ```")).toBe(true);
    expect(fence("- item\n\n  ```\n  a\n  ```")).toBe(true);
    // open (ran into the end of the text)
    expect(fence("```")).toBe(false);
    expect(fence("```\n")).toBe(false);
    expect(fence("```\nfoo")).toBe(false);
    expect(fence("```\nfoo\n")).toBe(false);
    expect(fence("```\nfoo\n``")).toBe(false);
    expect(fence("````\nfoo\n```")).toBe(false);
    expect(fence("~~~~\nx\n~~~\n")).toBe(false);
    expect(fence("~~~\nx\n```")).toBe(false);
    expect(fence("```\na\n````x")).toBe(false);
    expect(fence("```\na\n``` x")).toBe(false);
    // indented code has no fence: never "closed" while streaming
    expect(fence("    indented\n    code")).toBe(false);
  });
});
