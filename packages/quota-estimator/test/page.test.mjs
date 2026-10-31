import test from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const root = new URL("../", import.meta.url);

test("page-only package has no host entry, collector or generated resource", async () => {
  const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  assert.equal(pkg.main, undefined);
  assert.equal(pkg.exports, undefined);
  assert.equal(pkg.scripts.collect, undefined);
  assert.deepEqual(pkg.magpie.permissions, []);
  assert.deepEqual(pkg.files, ["estimate.mjs", "page/index.html", "page/app.js", "page/style.css", "README.md", "LICENSE"]);
  for (const path of ["index.mjs", "collector.mjs", "claude-native.mjs", "page/snapshot.js"]) {
    await assert.rejects(access(new URL(path, root)), { code: "ENOENT" });
  }
});

test("waiting page uses theme/language only, never reads data or fabricates estimates", async () => {
  const html = await readFile(new URL("page/index.html", root), "utf8");
  const code = await readFile(new URL("page/app.js", root), "utf8");
  const keys = [...html.matchAll(/data-t="([^"]+)"/g)].map(match => match[1]);
  const nodes = keys.map(key => ({ dataset: { t: key }, textContent: "" }));
  const cards = { setAttribute(name, value) { this[name] = value; } };
  const document = { title: "", querySelectorAll: () => nodes, getElementById: () => cards };
  const forbidden = () => { throw new Error("The waiting page may not read data, write options, poll or connect"); };
  let onTheme;
  const magpie = { ready: Promise.resolve({ lang: "en" }), onTheme(fn) { onTheme = fn; }, read: forbidden,
    options: { get: forbidden, set: forbidden } };
  await runInNewContext(code, { document, magpie, fetch: forbidden, XMLHttpRequest: forbidden, WebSocket: forbidden,
    EventSource: forbidden, setInterval: forbidden, setTimeout: forbidden, navigator: { sendBeacon: forbidden } }, { timeout: 1000 });
  assert.equal(cards["aria-busy"], "false");
  assert.match(nodes.find(node => node.dataset.t === "unavailable").textContent, /not available/);
  for (const [lang, title] of [["en", "Quota estimates"], ["zh", "额度预估"], ["zh-TW", "額度預估"],
    ["ja", "クォータの推定"], ["de", "Kontingentschätzung"], ["fr", "Quota estimates"]]) {
    onTheme({ lang });
    assert.equal(document.title, title);
    assert.ok(nodes.every(node => typeof node.textContent === "string" && node.textContent.length > 0));
  }
  assert.deepEqual([...html.matchAll(/<script src="([^"]+)"/g)].map(match => match[1]), ["_magpie/bridge.js", "app.js"]);
  assert.equal((html.match(/class="capacity unavailable">—/g) || []).length, 2);
  assert.ok(!html.includes("snapshot.js"));
});
