// The Background menu's own picture can be removed (netube99 on X): a badge
// at the picture's top-right corner, shown on hover with a mouse, on focus
// from the keyboard, and always on a touch screen. Removing it drops the
// picture from the saved options and a card drawn on it goes back to teal,
// with the menu left open. The menu stays on the page where the toolbar
// wraps. Drives the real page in Chromium and WebKit, in
// every language, against a stub bridge.
// Run: NODE_PATH=<playwright's node_modules> node bg-delete.gui.mjs
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const { chromium, webkit } = require("playwright")
const page_dir = join(import.meta.dirname, "page")
// a picture of the reader's own: one of the page's thumbnails, as data:
const PIX = readFileSync(join(page_dir, "bg", "thumbs.js"), "utf8").match(/data:image\/jpeg;base64,[A-Za-z0-9+/=]+/)[0]
const bridge = (lang) => `
window.__sets = [];
const saved = { bg: "custom", image: ${JSON.stringify(PIX)}, pad: 40, blur: 0, dim: 0 };
window.magpie = {
  ready: Promise.resolve({ lang: ${JSON.stringify(lang)}, dark: false }),
  onTheme() {},
  read: async () => ({ date: "2026-11-09", today: "2026-11-09", calls: 1, errors: 0, input: 10, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 1, unpriced: 0, cacheUnknown: 0, agents: [], days: [{ date: "2026-11-09", calls: 1, tokens: 20, cost: 1 }], icons: {}, currency: "usd", rate: 7 }),
  options: { get: async () => saved, set: async (o) => { window.__sets.push(o); } },
  image: { copy: async () => {}, save: async () => ({}) },
};`;
const words = { en: "Remove your picture", zh: "删除这张图片", "zh-TW": "刪除這張圖片", ja: "この画像を削除", de: "Eigenes Bild entfernen" };
await (async () => {
  let bad = 0;
  const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) bad++; };
  for (const [name, type] of [["chromium", chromium], ["webkit", webkit]]) {
    const browser = await type.launch();
    // 900 and 420 wrap the toolbar, so the Background button sits at the left
    for (const width of [1200, 900, 420]) for (const lang of Object.keys(words)) for (const touch of [false, true]) {
      const ctx = await browser.newContext({ viewport: { width, height: 800 }, hasTouch: touch, isMobile: touch && name === "chromium" });
      const p = await ctx.newPage();
      const errs = [];
      p.on("pageerror", (e) => errs.push(String(e)));
      await p.route("**/*", (r) => {
        const u = new URL(r.request().url());
        if (u.pathname.endsWith("/_magpie/bridge.js")) return r.fulfill({ contentType: "text/javascript", body: bridge(lang) });
        const f = join(page_dir, u.pathname.replace(/^\/day\//, ""));
        if (!existsSync(f)) return r.fulfill({ status: 404, body: "" });
        const ct = f.endsWith(".js") ? "text/javascript" : f.endsWith(".css") ? "text/css" : "text/html";
        r.fulfill({ contentType: ct, body: readFileSync(f) });
      });
      await p.goto("http://day.test/day/index.html");
      await p.click("#bg");
      await p.waitForSelector("#bg-del");
      const tag = `${name} ${width} ${lang} ${touch ? "touch" : "mouse"}`;
      const pb = await p.locator("#bg-pop").boundingBox();
      ok(pb.x >= 0 && pb.x + pb.width <= width, `${tag}: menu within the page (${Math.round(pb.x)}..${Math.round(pb.x + pb.width)})`);
      const del = p.locator("#bg-del");
      ok((await del.getAttribute("aria-label")) === words[lang], `${tag}: badge named ${words[lang]}`);
      ok((await p.locator('.sw[data-bg="custom"]').getAttribute("aria-checked")) === "true", `${tag}: custom picked`);
      const op = async () => Number(await del.evaluate((e) => getComputedStyle(e).opacity));
      if (!touch) {
        await p.mouse.move(5, 5);
        await p.waitForTimeout(300);
        ok((await op()) === 0, `${tag}: badge hidden without hover`);
        await p.hover('.sw[data-bg="custom"]', { timeout: 3000 });
        await p.waitForTimeout(300);
        ok((await op()) === 1, `${tag}: badge shown on hover`);
        // focus path: Tab onto the picture's swatch shows the badge
        await p.mouse.move(5, 5);
        await p.focus('.sw[data-bg="custom"]');
        await p.waitForTimeout(300);
        ok((await op()) === 1, `${tag}: badge shown on focus`);
        // badge sits at the swatch's top-right corner
        const sb = await p.locator('.sw[data-bg="custom"]').boundingBox();
        const db = await del.boundingBox();
        ok(Math.abs(db.x + db.width - (sb.x + sb.width + 6)) < 1.5 && Math.abs(db.y - (sb.y - 6)) < 1.5, `${tag}: badge at the top-right corner`);
        await p.hover('.sw[data-bg="custom"]');
        await p.click("#bg-del");
      } else {
        await p.waitForTimeout(300);
        ok((await op()) === 1, `${tag}: badge always shown without hover`);
        await p.tap("#bg-del");
      }
      await p.waitForFunction(() => !document.querySelector('.sw[data-bg="custom"]'));
      ok(!(await p.locator("#bg-pop").evaluate((e) => e.hidden || e.classList.contains("closing"))), `${tag}: menu stays open`);
      ok((await p.locator('.sw[data-bg="teal"]').getAttribute("aria-checked")) === "true", `${tag}: falls back to teal`);
      if (!touch) ok(await p.evaluate(() => document.activeElement?.id === "bg-add"), `${tag}: focus on the add button`);
      await p.waitForFunction(() => window.__sets.length > 0, null, { timeout: 4000 });
      const set = await p.evaluate(() => window.__sets.at(-1));
      ok(set.image === "" && set.bg === "teal" && set.pad === 40, `${tag}: saved options lose the picture (${JSON.stringify(set)})`);
      ok(errs.length === 0, `${tag}: no page errors ${errs.join(";")}`);
      await ctx.close();
    }
    await browser.close();
  }
  console.log(bad ? `${bad} failed` : "all ok");
  process.exit(bad ? 1 : 0);
})();
