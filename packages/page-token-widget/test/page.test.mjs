import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

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
    // The CSP of the page is connect-src 'none', and magpie refuses these
    // calls anyway.
    assert.doesNotMatch(source, /\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource|importScripts/);
  }
  assert.deepEqual([...reads], []);
});

test("the launcher navigates instead of probing", () => {
  const boot = read(pageDir, "boot.js");
  assert.match(boot, /window\.magpie\?\.service|magpie\.service/);
  assert.match(boot, /location\.replace/);
  assert.doesNotMatch(boot, /\bfetch\(/);
});

test("plugin metadata speaks Chinese and English", () => {
  assert.equal(pkg.magpie.name, "iPhone Quota Widget");
  assert.equal(pkg.magpie.page.titles.zh, "iPhone 额度组件");
  assert.equal(pkg.magpie.page.titles.en, "iPhone Quota Widget");
  assert.match(pkg.magpie.summary.zh, /额度/);
  assert.match(pkg.magpie.summary.en, /quota/);
  assert.match(pkg.description, /quota/i);
  assert.match(pkg.description, /额度/);
  const readme = read(dir, "README.md");
  assert.match(readme, /magpie plugin add @magpie-community\/page-token-widget/);
  assert.match(readme, /## 中文说明/);
});

test("the registry says the same thing as the package", () => {
  const registry = JSON.parse(readFileSync(join(dir, "..", "..", "registry.json"), "utf8"));
  const entry = registry.plugins.find((item) => item.package === pkg.name);
  assert.ok(entry, "the package is in the registry");
  assert.equal(entry.name, pkg.magpie.name);
  assert.deepEqual(entry.summary, pkg.magpie.summary);
  assert.equal(entry.kind, "page");
});

test("the declared port is the one the page falls back to", () => {
  const boot = read(pageDir, "boot.js");
  const declared = pkg.magpie.page.service.port;
  assert.equal(pkg.magpie.options.port, declared);
  assert.match(boot, new RegExp(`const DEFAULT_PORT = ${declared}`));
  const setup = read(join(dir, "scriptable"), "SetupUsageWidget.js");
  assert.match(setup, new RegExp(`const DEFAULT_PORT = ${declared};`));
});

test("the service answers as this package", async () => {
  const server = await import(pathToFileURL(join(dir, "lib", "server.mjs")).href);
  assert.equal(typeof server.startServer, "function");
  const source = read(join(dir, "lib"), "server.mjs");
  assert.match(source, /const PLUGIN = '@magpie-community\/page-token-widget';/);
});
