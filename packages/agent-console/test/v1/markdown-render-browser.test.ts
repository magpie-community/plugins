// renderMarkdown (web/src/util/renderMarkdown.ts) in real Chromium: DOMPurify needs a DOM, so the module is bundled
// with esbuild and run in a page. Pins the 1.3.7 review points: unlabelled fences are auto-detected again once
// closed / settled (an open fence of a streaming message stays "text"), the model's <svg> is dropped (html profile
// only), and the code block buttons still get their icons in the same pass.
import { describe, it, expect } from "vitest";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { chromium } from "playwright-core";
// @ts-expect-error mjs helper
import { findBrowser } from "../../scripts/browser-path.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const browserPath: string | null = findBrowser();

type Block = { lang: string; codeClass: string; hl: number; btnSvgs: number[]; dataI: string | null; pressed: string | null };
type Out = { blocks: Block[]; svgOutsideButtons: number; circles: number; onload: number; html: string; pwned: unknown };

describe.skipIf(!browserPath)("renderMarkdown in real Chromium (1.3.7 review)", () => {
  it("auto-detects closed / settled unlabelled fences, keeps an open streaming fence plain, strips model <svg>", async () => {
    const bundle = await esbuild.build({
      entryPoints: [join(root, "web/src/util/renderMarkdown.ts")],
      absWorkingDir: root,
      bundle: true,
      write: false,
      format: "iife",
      globalName: "AC_MD",
      platform: "browser",
      target: "es2020",
      define: { "process.env.NODE_ENV": '"production"' },
      logLevel: "silent",
    });
    const code = bundle.outputFiles[0]!.text;
    const launchArgs = process.platform === "linux" && process.getuid?.() === 0 ? ["--no-sandbox"] : [];
    const browser = await chromium.launch({ executablePath: browserPath!, headless: true, args: launchArgs });
    try {
      const page = await browser.newPage();
      await page.setContent("<!doctype html><html><body><div id=root></div></body></html>");
      await page.addScriptTag({ content: code });
      const render = (md: string, streaming: boolean, wrapped: number[] = []) =>
        page.evaluate(({ md, streaming, wrapped }) => {
          const w = window as unknown as { AC_MD: { renderMarkdown: (t: string, o: object) => { html: string } }; __pwned?: unknown };
          const { html } = w.AC_MD.renderMarkdown(md, { streaming, wrapped: new Set(wrapped) });
          const el = document.getElementById("root")!;
          el.innerHTML = html;
          const blocks = [...el.querySelectorAll(".cb")].map((cb) => ({
            lang: cb.querySelector(".cb-lang")?.textContent ?? "",
            codeClass: cb.querySelector("pre > code")?.className ?? "",
            hl: cb.querySelectorAll("pre [class^='hljs-']").length,
            btnSvgs: [...cb.querySelectorAll(".cb-btn")].map((b) => b.querySelectorAll(":scope > svg > path[d]").length),
            dataI: cb.querySelector(".cb-copy")?.getAttribute("data-i") ?? null,
            pressed: cb.querySelector(".cb-wrap")?.getAttribute("aria-pressed") ?? null,
          }));
          const svgOutsideButtons = [...el.querySelectorAll("svg")].filter((s) => !s.closest(".cb-btn")).length;
          return {
            blocks,
            svgOutsideButtons,
            circles: el.querySelectorAll("circle").length,
            onload: el.querySelectorAll("[onload]").length,
            html,
            pwned: w.__pwned,
          };
        }, { md, streaming, wrapped }) as Promise<Out>;

      const py = "def greet(name):\n    return f\"hi {name}\"\n\nclass A:\n    pass";
      const closed = "```\n" + py + "\n```\n";
      const open = "```\n" + py + "\n";

      // settled message: unlabelled fence → highlightAuto + detected label (as 1.3.6)
      let r = await render("intro\n\n" + closed + "\ndone", false);
      expect(r.blocks).toHaveLength(1);
      expect(r.blocks[0]!.lang).toBe("python");
      expect(r.blocks[0]!.codeClass).toBe("hljs language-python");
      expect(r.blocks[0]!.hl).toBeGreaterThan(0);

      // streaming, the fence is still open at the end: plain "text", no colours (no flip-flop while it grows)
      r = await render("intro\n\n" + open, true);
      expect(r.blocks[0]!.lang).toBe("text");
      expect(r.blocks[0]!.codeClass).toBe("hljs");
      expect(r.blocks[0]!.hl).toBe(0);
      // ...also every prefix of it while tokens arrive
      for (let n = 4; n <= open.length; n += 7) {
        const p = await render(open.slice(0, n), true);
        expect(p.blocks.length <= 1 && (p.blocks[0]?.lang ?? "text")).toBe("text");
      }

      // streaming, a closed fence followed by an open one: the closed one is detected, the open one waits
      r = await render(closed + "\nnext:\n\n" + open, true);
      expect(r.blocks.map((b) => b.lang)).toEqual(["python", "text"]);
      // the same text once it settles: both detected
      r = await render(closed + "\nnext:\n\n" + open, false);
      expect(r.blocks.map((b) => b.lang)).toEqual(["python", "python"]);
      // tildes close too
      r = await render("~~~~\n" + py + "\n~~~~\n", true);
      expect(r.blocks[0]!.lang).toBe("python");

      // an explicit language is used as written, streaming or not
      for (const streaming of [true, false]) {
        r = await render("```ts\nconst x: number = 1;\n", streaming);
        expect(r.blocks[0]!.lang).toBe("ts");
        expect(r.blocks[0]!.codeClass).toBe("hljs language-ts");
        expect(r.blocks[0]!.hl).toBeGreaterThan(0);
      }

      // the model's own <svg> is dropped; the code block buttons keep their icons; chrome attributes survive
      const evil =
        "look <svg><circle cx=\"5\" cy=\"5\" r=\"4\"/></svg> here\n\n" +
        "<svg onload=\"window.__pwned=1\"><circle cx=\"1\" cy=\"1\" r=\"1\"/></svg>\n\n" +
        "<img src=x onerror=\"window.__pwned=2\">\n\n" +
        "```ts\nlet a = 1;\nlet b = 2;\n```\n\n```\necho hi\n```\n";
      for (const streaming of [true, false]) {
        r = await render(evil, streaming, [1]);
        expect(r.svgOutsideButtons).toBe(0);
        expect(r.circles).toBe(0);
        expect(r.onload).toBe(0);
        expect(r.html).not.toMatch(/onerror|onload|__AC_CB_/);
        expect(r.blocks).toHaveLength(2);
        for (const b of r.blocks) expect(b.btnSvgs).toEqual([1, 1]);
        expect(r.blocks.map((b) => b.dataI)).toEqual(["0", "1"]);
        expect(r.blocks.map((b) => b.pressed)).toEqual(["false", "true"]);
      }
      await page.waitForTimeout(50);
      expect(await page.evaluate(() => (window as unknown as { __pwned?: unknown }).__pwned)).toBeUndefined();
    } finally {
      await browser.close();
    }
  });
});
