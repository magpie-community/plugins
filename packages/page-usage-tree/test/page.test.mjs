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
new Function("globalThis", read(uiDir, "i18n.js"))(scope);
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
    alias: "10月学生Plus",
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

test("plugin metadata speaks Chinese and English", () => {
  assert.equal(pkg.magpie.name, "账号用量 / Account usage");
  assert.equal(pkg.magpie.page.titles.zh, "账号用量");
  assert.match(pkg.magpie.summary.zh, /供应商 -> 账号 -> 模型/);
  assert.match(pkg.magpie.summary.en, /provider -> account -> model/);
  assert.match(pkg.description, /在 Magpie 窗口中/);
  assert.match(pkg.description, /A page in Magpie's window/);
  const readme = read(join(dir), "README.md");
  assert.match(readme, /## 中文说明/);
  assert.ok(readme.indexOf("## 中文说明") < readme.indexOf("## English"));
  for (const text of [pkg.description, pkg.magpie.page.titles.zh, pkg.magpie.summary.zh, readme]) {
    assert.doesNotMatch(text, /\uFFFD/);
  }
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

test("the launcher forwards currency and unit options", () => {
  const boot = read(pageDir, "boot.js");
  assert.match(boot, /query\.set\("currency", display\.currency\)/);
  assert.match(boot, /query\.set\("chineseUnits", display\.chineseUnits \? "1" : "0"\)/);
  assert.match(boot, /followDisplay\(options\)/);
  assert.equal(pkg.magpie.options.currency, "usd");
  assert.equal(pkg.magpie.options.chineseUnits, false);
  assert.equal(pkg.magpie.options.usdCny, 0);
});

test("the summary says accounts, calls, tokens and cost", () => {
  V.setChineseUnits(true);
  V.setLang("zh");
  const tiles = V.tiles(summary, "zh", "cny", 6.6696);
  assert.equal(tiles.length, 4);
  assert.equal(tiles[0].value, "2");
  assert.match(tiles[0].sub, /0 个供应商/);
  assert.equal(tiles[1].value, "120");
  assert.equal(tiles[1].bad, true);
  assert.equal(tiles[2].value, "240万");
  assert.match(tiles[3].value, /^¥/);
});

test("cache can be included or excluded from token totals", () => {
  V.setChineseUnits(true);
  V.setLang("zh");
  assert.equal(V.tokenTotal({ tokens: 150, cache: 50 }, true), 200);
  assert.equal(V.tokenTotal({ tokens: 150, cache: 50 }, false), 150);
  assert.equal(V.tokenTotal({ tokens: 150, allTokens: 220, cache: 50 }, true), 220);
  assert.equal(V.tiles(summary, "zh", "usd", 6.6696, true)[2].value, "240万");
  assert.equal(V.tiles(summary, "zh", "usd", 6.6696, false)[2].value, "150万");
});

test("an account shows the name the user gave it", () => {
  const rows = V.accounts(accounts, "tokens", "zh");
  assert.equal(rows[0].name, "10月学生Plus");
  assert.equal(rows[1].name, "bob");
  assert.equal(rows[0].share, "93%");
});

test("search matches account aliases and only keeps matching children", () => {
  const provider = {
    id: "codex",
    provider: "codex",
    providerName: "Codex",
    accounts,
  };
  assert.equal(V.accountMatches(accounts[0], "10月学生plus"), true);
  assert.equal(V.accountSelfMatches(accounts[0], "10月学生plus"), true);
  assert.equal(V.modelMatches(accounts[0].models[0], "gpt-6"), true);
  assert.deepEqual(
    V.visibleAccounts(provider, "gpt-6").map((account) => account.account),
    ["alice@example.com"],
  );
  assert.equal(V.visibleAccounts(provider, "codex").length, 2);
});

test("expand-all follows the accounts visible under the current search", () => {
  const source = read(uiDir, "app.js");
  assert.match(
    source,
    /const accounts = providers\.flatMap\(\(provider\) => V\.visibleAccounts\(provider, state\.query\)\)/,
  );
  assert.match(source, /function updateExpandLabel\(\)[\s\S]*?allExpanded\(\)/);
  assert.match(source, /function allExpanded\(\)[\s\S]*?V\.visibleAccounts\(provider, state\.query\)/);
  assert.match(source, /const shownAccounts = V\.visibleAccounts\(provider, state\.query\)/);
  assert.match(source, /countModels\(shownAccounts\)/);
});

test("a model's own host difference is a note, not a second row", () => {
  const rows = V.models(accounts[0], "zh", "cny", 6.6696);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].hosts, ["chatgpt.com 14"]);
});

test("an empty or incomplete tree sorts without throwing", () => {
  for (const sort of V.SORTS) {
    assert.deepEqual(V.sortProviders([], sort, true), []);
    assert.deepEqual(V.sortProviders(null, sort, false), []);
  }
  const rows = V.sortProviders(
    [
      { id: "missing-fields" },
      { id: "b", providerName: "B", calls: 2, cost: 1, tokens: 10 },
      { id: "a", providerName: "A", calls: 1, cost: 2, tokens: 20 },
    ],
    "cost",
    true,
  );
  assert.deepEqual(rows.map((row) => row.id), ["a", "b", "missing-fields"]);
});

test("numbers read short", () => {
  V.setChineseUnits(true);
  V.setLang("zh");
  assert.equal(V.count(999), "999");
  assert.equal(V.count(1500000), "150万");
  assert.equal(V.percent(0.8), "80%");
  assert.equal(V.percent(0.004), "0.40%");
});

test("an error rate is errors of the calls", () => {
  assert.equal(V.errorRate(3, 120), "2.5%");
  assert.equal(V.errorRate(1, 1), "100%");
  assert.equal(V.errorRate(0, 50), "");
  // no calls, no rate: 0% would read as a clean record it never had
  assert.equal(V.errorRate(2, 0), "");
});

test("english is english, chinese is chinese", () => {
  const words = scope.UsageI18n.get("en");
  V.setLang("en");
  V.setChineseUnits(false);
  assert.equal(V.count(1500000), "1.5M");
  assert.equal(words.title, "Account usage");
  assert.equal(words.detail, "Account details");
  assert.match(V.tiles(summary, "en", "usd", 6.6696)[2].sub, /^In /);
  assert.equal(V.shareWord("cost"), "Cost share");
  V.setLang("zh");
  assert.equal(V.shareWord("cost"), "费用占比");
  assert.match(V.tiles(summary, "zh", "usd", 6.6696)[2].sub, /^入 /);
});

test("english counts singular accounts, providers and models", () => {
  V.setLang("en");
  const words = scope.UsageI18n.get("en");
  assert.equal(words.accountsAndModels(1, 1), "1 account · 1 model");
  assert.equal(words.accountsAndModels(0, 2), "0 accounts · 2 models");
  assert.equal(words.modelsOnly(1), "1 model");
  assert.equal(words.providerModels(1, 1), "1 provider · 1 model");
  assert.equal(words.providerModels(3, 4), "3 providers · 4 models");
  assert.match(V.tiles({ ...summary, accounts: 1, models: 1, providers: 1 }, "en", "usd", 0)[0].sub,
    /^1 provider · 1 model$/);
});

test("the model table has one column per value and follows the cache switch", () => {
  const source = read(uiDir, "app.js");
  const start = source.indexOf("function modelList");
  const head = source.slice(start, source.indexOf("const query = state.query", start));
  assert.equal((head.match(/el\("span", "", /g) || []).length, 7);
  assert.match(
    head,
    /el\("span", "", state\.includeCache \? W\.modelTokensWithCache : W\.modelTokensWithoutCache\)/,
  );
  assert.doesNotMatch(head, /el\("span", "", "Token"\)/);
  assert.equal(scope.UsageI18n.get("zh").token, "Token");
  assert.equal(scope.UsageI18n.get("en").token, "Token");
});

test("model calls sit under the right-aligned calls header", () => {
  const source = read(uiDir, "app.js");
  assert.match(source, /\(model\.errors \? "bad " : ""\) \+ "calls-cell"/);
  const css = read(uiDir, "style.css");
  assert.match(css, /\.calls-cell,[\s\S]*?text-align: right;/);
});

test("the 900 px grid keeps every visible cell in its own column", () => {
  const css = read(uiDir, "style.css");
  const block = css.slice(css.indexOf("@media (max-width: 900px)"), css.indexOf("@media (max-width: 620px)"));
  assert.match(block, /\.provider-main \.errors-cell/);
  assert.match(block, /grid-template-columns: minmax\(150px, 1fr\) 92px 74px minmax\(80px, 0\.7fr\) 46px 74px;/);
});

test("the narrow summary wraps its token split instead of cutting it", () => {
  const css = read(uiDir, "style.css");
  const block = css.slice(css.indexOf("@media (max-width: 620px)"));
  assert.match(block, /\.summary-sub \{[\s\S]*?white-space: normal;/);
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

test("sorting uses the segmented control and updates its selected state", () => {
  const source = read(uiDir, "app.js");
  assert.match(source, /\$\("sort"\)\.addEventListener\("click"/);
  assert.match(source, /state\.sort = validSorts\.has\(value\) \? value : "tokens";[\s\S]*?renderPeriod\(\);[\s\S]*?renderAccounts\(\);/);
  assert.match(source, /button\.setAttribute\("aria-selected", String\(button\.dataset\.sort === state\.sort\)\)/);
});

test("the token-cache switch is native-looking, persistent and default-on", () => {
  const html = read(uiDir, "app.html");
  const source = read(uiDir, "app.js");
  assert.match(
    html,
    /<button class="cache-toggle" id="token-cache"[^>]*role="switch"[^>]*aria-checked="true"/,
  );
  assert.match(html, /data-i18n="includeCache"/);
  assert.match(source, /store\.get\("usage-tree\.include-cache"\) !== "0"/);
  assert.match(source, /store\.set\("usage-tree\.include-cache", state\.includeCache \? "1" : "0"\)/);
  assert.match(source, /V\.tokenTotal\(item, state\.includeCache\)/);
  assert.match(source, /summary\.cache[\s\S]*?provider\.cache[\s\S]*?account\.cache[\s\S]*?model\.cache/);
  const providerSort = source.slice(
    source.indexOf("function visibleProviders"),
    source.indexOf("function providersOf", source.indexOf("function visibleProviders")),
  );
  assert.match(providerSort, /V\.sortProviders\(list, state\.sort, state\.includeCache\)/);
  assert.doesNotMatch(providerSort, /b\.tokens - a\.tokens/);
});

test("the page follows magpie's language without a reload", () => {
  const source = read(uiDir, "app.js");
  assert.match(source, /function applyDisplay\(display\)/);
  assert.match(source, /W = globalThis\.UsageI18n\.get\(lang\)/);
  // Nothing is polled: the theme message carries the language.
  assert.doesNotMatch(source, /setInterval/);
  assert.match(source, /message\.event !== "theme"/);
  assert.match(source, /event\.source !== window\.parent/);
  assert.match(source, /applyThemeEvent\(message\.data\);/);
  assert.match(source, /wanted\.startsWith\("zh"\) \? "zh" : "en"/);
  assert.match(source, /getAttribute\("content"\) \|\| "en"/);
});

test("a retry can repaint and fingerprints cover displayed metrics", () => {
  const source = read(uiDir, "app.js");
  assert.match(source, /function renderError\(\) \{\s+state\.rendered = false;/);
  for (const field of [
    "summary.errors",
    "summary.unpriced",
    "summary.input",
    "summary.output",
    "account.lastAt",
    "model.errors",
  ]) {
    assert.match(source, new RegExp(field.replace(".", "\\.")), field);
  }
  assert.match(source, /const delay = attempt === 1 \? 1200 : attempt === 2 \? 2500 : 5000;/);
});

test("a failed follow-up keeps the period already on screen", () => {
  const source = read(uiDir, "app.js");
  assert.match(source, /state\.data\?\.period === requestedPeriod/);
  assert.match(source, /warning\.textContent = W\.refreshFailed/);
  assert.match(scope.UsageI18n.get("en").refreshFailed, /previous data/);
});

test("the launcher speaks English and Chinese, not Chinese only", () => {
  const html = read(pageDir, "index.html");
  const boot = read(pageDir, "boot.js");
  assert.match(html, /<html lang="en">/);
  assert.match(html, /Account usage/);
  assert.match(boot, /lang === "zh" \? "zh-CN" : "en"/);
  assert.match(boot, /words\[lang\]/);
});

test("the service keeps the settings endpoint guarded", () => {
  const source = readFileSync(join(dir, "lib", "server.mjs"), "utf8");
  assert.match(source, /url\.pathname === "\/api\/settings"/);
  assert.match(source, /json\(res, 200, displaySettings\(options\)\)/);
});
