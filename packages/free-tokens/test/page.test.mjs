import { test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
const pageDir = fileURLToPath(new URL("../page/", import.meta.url));
const app = fs.readFileSync(pageDir + "app.js", "utf8");
const html = fs.readFileSync(pageDir + "index.html", "utf8");
const pkg = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));

test("page never touches the network", () => {
  assert.ok(!/\bfetch\s*\(/.test(app), "app.js must not call fetch");
  assert.ok(!/XMLHttpRequest|WebSocket|EventSource/.test(app), "no network APIs");
  assert.ok(!/window\.open/.test(app), "no window.open (sandbox has no popups)");
});
test("page only reads declared permissions (none)", () => {
  assert.ok(!/magpie\.read\s*\(/.test(app), "page must not call magpie.read");
  assert.ok(!pkg.magpie.permissions || pkg.magpie.permissions.length === 0);
});
test("page uses classic scripts, not ES modules (sandbox origin null)", () => {
  assert.ok(!/type=["']module["']/.test(html), "index.html must not load module scripts");
  assert.match(html, /<script src="view\.js"/);
  assert.match(html, /<script src="app\.js"/);
  assert.ok(!/\bimport\s+[^;]*from\s+["']\.\//.test(app), "app.js must not use ESM import");
  assert.match(app, /window\.FTView/);
});
test("no inline event handlers (CSP)", () => {
  assert.ok(!/\son[a-z]+\s*=\s*["']/i.test(html), "index.html inline handlers");
  assert.ok(!/onerror\s*=\s*["']/.test(app), "inline onerror in app.js");
});
test("html has no missing scripts / dead _blank links / theme toggle", () => {
  assert.ok(!html.includes("mock-data.js"));
  assert.ok(!html.includes('target="_blank"'));
  assert.ok(!/id="themeBtn"/.test(html));
});
test("no mock content committed", () => {
  assert.ok(!/__MOCK__|mock-data/.test(app + html));
  assert.ok(!fs.existsSync(pageDir + "mock-data.js"));
  assert.ok(!fs.existsSync(fileURLToPath(new URL("../data/snapshot.json", import.meta.url))));
});
test("package declares page + NOTICE", () => {
  assert.equal(pkg.magpie.page.file, "page/index.html");
  assert.ok(pkg.files.includes("NOTICE"));
  if (String(pkg.name).startsWith("@magpie-community/")) assert.equal(pkg.repository.directory, "packages/free-tokens");
});

test("app.js delegates click decisions to view.actionOf", () => {
  assert.match(app, /actionOf\(btn\.dataset\)/);
});
