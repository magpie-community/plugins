import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dirname, "..");
const pageDir = join(dir, "page");
const uiDir = join(dir, "ui");
const read = (base, file) => readFileSync(join(base, file), "utf8");
const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));

// view.js is a classic script, as the page loads it.
const scope = {};
new Function("globalThis", read(uiDir, "view.js"))(scope);
const V = scope.UsageView;

const summary = {
  period: "7d",
  accounts: 2,
  models: 3,
  calls: 120,
  errors: 3,
  input: 1200000,
  output: 300000,
  cache: 900000,
  tokens: 1500000,
  cost: 42.5,
  unpriced: 2,
};

const accounts = [
  {
    id: "codex\u001falice@example.com",
    account: "alice@example.com",
    alias: "10月越南Plus",
    provider: "codex",
    providerName: "Codex",
    calls: 100,
    errors: 3,
    tokens: 1400000,
    cost: 40,
    unpriced: 2,
    share: 0.8,
    bar: 1,
    models: [
      {
        id: "m1",
        model: "gpt-6-luna",
        providerName: "Codex",
        calls: 100,
        errors: 3,
        tokens: 1400000,
        cost: 40,
        unpriced: 2,
        share: 1,
        bar: 1,
        hostNotes: [{ account: "chatgpt.com", calls: 14 }],
      },
    ],
  },
  {
    id: "raccoon\u001fbob",
    account: "bob",
    alias: "",
    provider: "raccoon",
    providerName: "Raccoon",
    calls: 20,
    errors: 0,
    tokens: 100000,
    cost: 2.5,
    unpriced: 0,
    share: 0.2,
    bar: 0.15,
    models: [],
  },
];

test("the page reads nothing of magpie and reaches no network", () => {
  assert.deepEqual(pkg.magpie.permissions ?? [], []);
  const reads = new Set();
  for (const file of readdirSync(pageDir).filter((f) => f.endsWith(".js"))) {
    const source = read(pageDir, file);
    for (const match of source.matchAll(/magpie\.read\(\s*"([^"]+)"/g)) reads.add(match[1]);
    // magpie's policy refuses these anyway; the page must not try.
    assert.doesNotMatch(
      source,
      /\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource|importScripts/,
    );
  }
  assert.deepEqual([...reads], []);
});

test("is a page magpie serves: its files in page/, scripts as files", () => {
  assert.equal(pkg.magpie.page.file, "page/index.html");
  assert.equal(pkg.magpie.page.icon, "page/icon.svg");
  const html = read(pageDir, "index.html");
  assert.match(html, /<script src="_magpie\/bridge\.js"><\/script>/);
  for (const match of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
    assert.match(match[1], /\ssrc="/);
    assert.equal(match[2].trim(), "");
  }
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    if (match[1].startsWith("_magpie/")) continue;
    assert.doesNotMatch(match[1], /^(?:[a-z]+:|\/|\.\.)/i);
    assert.ok(readdirSync(pageDir).includes(match[1]), `${match[1]} is in page/`);
  }
});

test("the launcher only navigates to the local service", () => {
  const boot = read(pageDir, "boot.js");
  assert.match(boot, /location\.replace\(/);
  // it must not probe the service first: the page's CSP is connect-src 'none'
  assert.doesNotMatch(boot, /\bfetch\(/);
  assert.match(boot, /window\.magpie\?\.service/);
});

test("the summary says accounts, calls, tokens and cost", () => {
  const tiles = V.tiles(summary, "zh", "cny", 6.6696);
  assert.equal(tiles.length, 4);
  assert.equal(tiles[0].value, "2");
  assert.equal(tiles[1].value, "120");
  assert.equal(tiles[1].bad, true);
  assert.equal(tiles[2].value, "150万");
  assert.match(tiles[3].value, /^≈¥/);
});

test("an account shows the name the user gave it", () => {
  const rows = V.accounts(accounts, "tokens", "zh");
  assert.equal(rows[0].name, "10月越南Plus");
  assert.equal(rows[1].name, "bob");
  assert.equal(rows[0].share, "80%");
});

test("a model's own host difference is a note, not a second row", () => {
  const rows = V.models(accounts[0], "zh", "cny", 6.6696);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].hosts, ["chatgpt.com 14"]);
});

test("numbers read short", () => {
  assert.equal(V.count(999), "999");
  assert.equal(V.count(1500000), "150万");
  assert.equal(V.percent(0.8), "80%");
  assert.equal(V.percent(0.004), "0.40%");
});

test("no function of the page calls itself", () => {
  // A function that calls itself runs until the stack is gone: the page
  // would show "Maximum call stack size exceeded" instead of its rows.
  const source = read(uiDir, "app.js");
  const bodies = source.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{([\s\S]*?)\n  \}/g);
  const offenders = [];
  for (const [, name, body] of bodies) {
    // a call of itself, not a call of the same name on something else
    const calls = [...body.matchAll(new RegExp(`(?<![.\\w$])${name}\\s*\\(`, "g"))];
    if (!calls.length) continue;
    // a call that waits for a timer is a retry, not a loop
    const deferred = calls.every((call) => {
      const before = body.slice(0, call.index);
      return /setTimeout\s*\(/.test(before.split("\n").slice(-4).join("\n"));
    });
    if (!deferred) offenders.push(name);
  }
  assert.deepEqual(offenders, []);
});
