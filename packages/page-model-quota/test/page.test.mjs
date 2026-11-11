import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dirname, "..");
const pageDir = join(dir, "page");
const read = (base, file) => readFileSync(join(base, file), "utf8");
const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));

test("the launcher reads nothing of magpie and reaches no network", () => {
  assert.deepEqual(pkg.magpie.permissions ?? [], []);
  const reads = new Set();
  for (const file of readdirSync(pageDir).filter((f) => f.endsWith(".js"))) {
    const source = read(pageDir, file);
    for (const match of source.matchAll(/magpie\.read\(\s*"([^"]+)"/g)) reads.add(match[1]);
    // 页面的 CSP 是 connect-src 'none'，magpie 也会拒绝这些调用。
    assert.doesNotMatch(source, /\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource|importScripts/);
  }
  assert.deepEqual([...reads], []);
});

test("the launcher navigates instead of probing", () => {
  const boot = read(pageDir, "boot.js");
  assert.match(boot, /window\.magpie\?\.service/);
  assert.match(boot, /location\.replace/);
  assert.doesNotMatch(boot, /\bfetch\(/);
});

test("plugin metadata speaks Chinese and English", () => {
  assert.equal(pkg.magpie.name, "Model Quota");
  assert.equal(pkg.magpie.page.titles.zh, "模型剩余额度");
  assert.equal(pkg.magpie.page.titles.en, "Model Quota");
  assert.match(pkg.magpie.summary.zh, /额度窗口/);
  assert.match(pkg.magpie.summary.en, /quota window/);
  assert.match(pkg.description, /A page in Magpie's window/);
  const readme = read(dir, "README.md");
  assert.match(readme, /magpie plugin add @magpie-community\/page-model-quota/);
  assert.match(readme, /## 中文说明/);
});

test("the declared port is the one the page falls back to", () => {
  const boot = read(pageDir, "boot.js");
  const declared = pkg.magpie.page.service.port;
  assert.equal(pkg.magpie.options.port, declared);
  assert.match(boot, new RegExp(`const DEFAULT_PORT = ${declared}`));
});
