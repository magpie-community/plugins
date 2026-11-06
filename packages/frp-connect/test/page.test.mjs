// The page: its words in every language it ships, and a page that asks
// magpie for nothing over the network — its only calls are the bridge and
// its own control API. No browser here: the files are read.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { LANGS, word } from "../page/i18n.js";

const page = path.resolve(import.meta.dirname, "../page");
const read = (f) => fs.readFileSync(path.join(page, f), "utf8");
const html = read("index.html");
const app = read("app.js");
const css = read("style.css");

test("en and zh at least, and the page's title in each", () => {
  for (const lang of ["en", "zh"]) assert.ok(LANGS.includes(lang), `${lang} is shipped`);
  for (const lang of LANGS) {
    for (const k of ["start", "stop", "save", "authToken", "tunnelNote"]) {
      assert.ok(word(lang, k), `${lang} says ${k}`);
    }
  }
  assert.equal(word("zh", "start"), "启动");
  assert.equal(word("zh-TW", "start"), "启动", "a tag's language is its first part");
  assert.equal(word("de", "start"), "Start", "anything else reads English");
});

test("every word the page asks for is in the page's own table", () => {
  const asked = new Set();
  for (const m of html.matchAll(/data-t="([^"]+)"/g)) asked.add(m[1]);
  for (const m of app.matchAll(/\bt\("([a-zA-Z]+)"\)/g)) asked.add(m[1]);
  for (const m of app.matchAll(/t\(shown \? "([a-z]+)" : "([a-z]+)"\)/g)) asked.add(m[1]).add(m[2]);
  // a word that is the same in a language is still a word (pid is pid)
  for (const lang of LANGS) for (const k of asked) assert.ok(word(lang, k), `${lang} has no ${k}`);
});

test("the page makes no network use of its own", () => {
  // no picture, font, import or script from anywhere but its own folder
  for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const url = m[1];
    assert.ok(!/^(?:[a-z]+:)?\/\//i.test(url), `no absolute URL: ${url}`);
    assert.ok(!/^(data|blob):/i.test(url), `no inline origin: ${url}`);
  }
  assert.ok(!/https?:\/\//.test(css), "no remote font or picture in the stylesheet");
  assert.ok(!/\bimport\s*\(|\bimport\s+[\w{*]/.test(app), "no import from anywhere");
  // the page's own calls: the bridge, and its part on this computer
  const urls = [...app.matchAll(/fetch\(([^)]*)/g)].map((m) => m[1]);
  assert.ok(urls.length > 0, "the page calls its part");
  for (const u of urls) assert.match(u, /url|\/api\//, `only its part is asked: ${u}`);
  assert.match(app, /magpie\.service/, "a browser's window is reached through magpie");
  // and the page is declared to load nothing of its own
  const pkg = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../package.json"), "utf8"));
  assert.equal(pkg.magpie.page.file, "page/index.html");
  assert.match(pkg.magpie.page.service.port.toString(), /^\d+$/);
});

test("no platform select where a switch fits, and the token is a password", () => {
  // the mode and frpc's source are rows of buttons, not selects
  const modes = html.match(/data-mode="([a-z]+)"/g) || [];
  assert.deepEqual(modes.map((m) => m.replace(/data-mode="|"/g, "")), ["form", "toml"]);
  const binaries = html.match(/data-binary="([a-z]+)"/g) || [];
  assert.deepEqual(binaries.map((m) => m.replace(/data-binary="|"/g, "")), ["download", "local"]);
  assert.match(html, /id="authToken" type="password"/);
  assert.match(html, /id="reveal"/);
  assert.ok(!/<select\b/i.test(html), "no native <select> in the page");
  assert.ok(!/<select\b|createElement\(["']select["']\)/i.test(app), "no native select built by the page");
  // the log panel shows frpc's log and nothing else: never a field's value
  const logLines = app.split("\n").filter((l) => /\blog\.textContent\s*=/.test(l));
  assert.ok(logLines.length > 0, "the log panel is drawn");
  for (const line of logLines) assert.match(line, /s\.log|t\("noLog"\)/, `only frpc's log: ${line.trim()}`);
  assert.ok(!/authToken[^\n]*log/.test(app), "the token never reaches the log panel");
});

test("the page never writes a command into the options", () => {
  assert.ok(!/requestAction|nonce/.test(app), "no action is a field of the options");
  assert.ok(!/requestAction/.test(read("i18n.js")));
});

test("the tokens the page saves are the ones the plugin reads", async () => {
  // the form's field names are the options' own (lib/options.mjs)
  const { options } = await import("../lib/options.mjs");
  const cfg = options({});
  for (const key of Object.keys(cfg)) {
    // the control API's port is the host's, not the form's
    if (["proxies", "servicePort"].includes(key)) continue;
    assert.ok(app.includes(`${key}:`), `the form knows ${key}`);
  }
});
