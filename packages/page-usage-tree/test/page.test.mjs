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
  cacheRead: 900000,
  cacheWrite: 0,
  cacheUnknown: 0,
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
  for (const file of readdirSync(uiDir).filter((f) => f.endsWith(".js"))) {
    const source = read(uiDir, file);
    assert.doesNotMatch(source, /\.read\(\s*"usage:day"|\bread\(\s*"usage:day"/);
  }
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
  assert.doesNotMatch(boot, /usage:day|magpie\?\.read\(/);
  assert.match(boot, /query\.set\("currency", display\.currency\)/);
  assert.match(boot, /query\.set\("chineseUnits", display\.chineseUnits \? "1" : "0"\)/);
  assert.match(boot, /followDisplay\(options\)/);
  assert.match(boot, /query\.set\("settings", "1"\)/);
  assert.equal(pkg.magpie.options.currency, "usd");
  assert.equal(pkg.magpie.options.chineseUnits, false);
  assert.equal(pkg.magpie.options.usdCny, 0);
});

test("the launcher does not invent official display settings from a theme-only hello", () => {
  const source = read(pageDir, "boot.js");
  const start = source.indexOf("  let officialDisplay = false;");
  const end = source.indexOf("  function followLanguage", start);
  const helpers = source.slice(start, end);
  const run = new Function("display", `${helpers}; return followDisplay;`);
  const display = { currency: "cny", chineseUnits: true, usdCny: 7.2 };
  const followDisplay = run(display);
  followDisplay({ dark: true, lang: "zh" }, true);
  assert.deepEqual(display, { currency: "cny", chineseUnits: true, usdCny: 7.2 });
  followDisplay({ currency: "cny", chineseUnits: false, usdCny: 7.3 }, true);
  assert.deepEqual(display, { currency: "cny", chineseUnits: false, usdCny: 7.3 });
  followDisplay({ currency: "usd", chineseUnits: true, usdCny: 8 }, false);
  assert.deepEqual(display, { currency: "cny", chineseUnits: false, usdCny: 7.3 });
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

test("cache hit text follows Magpie's own cache-aware denominator", () => {
  assert.equal(V.cacheHitRate({ input: 120, cacheRead: 180, cacheWrite: 20 }), 0.5625);
  assert.equal(V.cacheHitRate({ input: 200, cacheRead: 0, cacheWrite: 0, cacheUnknown: 200 }), null);
  assert.equal(V.cacheHitRate({ input: 200, cacheRead: 0, cacheWrite: 0 }), null);
  assert.equal(V.cacheHitRate({ input: 200, cacheRead: 0 }), null);
  assert.equal(V.cacheHitRate({ input: 0, cacheRead: 0 }), null);
  assert.equal(V.cacheHitText(summary, "zh"), "缓存命中率 43%");
  assert.equal(V.cacheHitText(summary, "en"), "Cache hit 43%");
  assert.equal(
    V.cacheHitText({ input: 200, cacheRead: 0, cacheWrite: 0, cacheUnknown: 200, cacheUnknownCalls: 1 }, "zh"),
    "1 次未统计缓存",
  );
  assert.equal(
    V.cacheHitText({ input: 120, cacheRead: 180, cacheWrite: 20, cacheUnknownCalls: 2 }, "zh"),
    "缓存命中率 56% · 2 次未统计缓存",
  );
  assert.equal(
    V.cacheHitText({ input: 120, cacheRead: 180, cacheWrite: 20, cacheUnknownCalls: 2 }, "en"),
    "Cache hit 56% · 2 cache-uncounted calls",
  );
  assert.equal(V.cacheHitText({ input: 0, cacheRead: 0, cacheWrite: 0 }, "en"), "");
  assert.equal(V.cacheHitSuffix({ input: 0, cacheRead: 0 }, "en"), "");
  assert.match(V.tiles(summary, "zh", "usd", 0)[2].sub, / · 缓存命中率 43%$/);
  assert.match(V.tiles(summary, "en", "usd", 0)[2].sub, / · Cache hit 43%$/);
});

test("cache hit percentages use Magpie's rounding", () => {
  assert.equal(V.hitPercent(0), "0%");
  assert.equal(V.hitPercent(1), "100%");
  assert.equal(V.hitPercent(0.43), "43%");
  assert.equal(V.hitPercent(0.996), "99.6%");
  assert.equal(V.hitPercent(0.99999), "99.99%");
  assert.equal(V.hitPercent(1e-7), "0.01%");
  assert.equal(V.hitPercent(0.056), "6%");
  assert.equal(V.hitPercent(0.001), "0.1%");
  assert.equal(V.hitPercent(0.0001), "0.01%");
  assert.equal(
    V.cacheHitText({ input: 4, cacheRead: 996, cacheWrite: 0 }, "zh"),
    "缓存命中率 99.6%",
  );
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
  assert.match(read(uiDir, "app.js"), /V\.cacheHitSuffix\(model, lang\)/);
});

test("the cache hit detail wraps at intermediate and phone widths", () => {
  const css = read(uiDir, "style.css");
  const base = css.slice(0, css.indexOf("@media (max-width: 900px)"));
  const narrow = css.slice(css.indexOf("@media (max-width: 700px)"));
  assert.match(base, /\.summary-sub \{[\s\S]*?overflow-wrap: anywhere;[\s\S]*?white-space: normal;/);
  assert.match(base, /\.model-split \{[\s\S]*?overflow-wrap: anywhere;[\s\S]*?white-space: normal;/);
  assert.match(narrow, /\.model-row \.model-split \{[\s\S]*?display: block;/);
  assert.doesNotMatch(narrow, /grid-column: 1 \/ -1;/);
  assert.doesNotMatch(narrow, /\.model-row \.model-provider,\s*\.model-row \.model-split,/);
});

test("model calls sit under the right-aligned calls header", () => {
  const source = read(uiDir, "app.js");
  assert.match(source, /\(model\.errors \? "bad " : ""\) \+ "calls-cell"/);
  const css = read(uiDir, "style.css");
  assert.match(css, /\.calls-cell,[\s\S]*?text-align: right;/);
});

test("the 900 px grid keeps every visible cell in its own column", () => {
  const css = read(uiDir, "style.css");
  const block = css.slice(css.indexOf("@media (max-width: 900px)"), css.indexOf("@media (max-width: 700px)"));
  const columns = "minmax\\(150px, 1fr\\) 60px 74px minmax\\(80px, 0\\.7fr\\) 44px 74px 20px";
  assert.match(block, new RegExp(`\\.account-main \\{\\s+grid-template-columns: ${columns};`));
  assert.match(block, new RegExp(`\\.provider-main \\{\\s+grid-template-columns: ${columns};`));
  assert.match(
    block,
    /\.model-head,\s*\.model-row \{\s+grid-template-columns: minmax\(150px, 1fr\) 92px 74px minmax\(80px, 0\.7fr\) 46px 74px;/,
  );
  assert.match(block, /\.provider-main \.errors-cell/);
});

test("the narrow summary wraps its token split instead of cutting it", () => {
  const css = read(uiDir, "style.css");
  const block = css.slice(css.indexOf("@media (max-width: 700px)"));
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
  assert.match(source, /item\.cache,\s*item\.allTokens,/);
  const providerSort = source.slice(
    source.indexOf("function visibleProviders"),
    source.indexOf("function providersOf", source.indexOf("function visibleProviders")),
  );
  assert.match(providerSort, /V\.sortProviders\(list, state\.sort, state\.includeCache\)/);
  assert.doesNotMatch(providerSort, /b\.tokens - a\.tokens/);
});

test("the page follows magpie's language without a reload", () => {
  const source = read(uiDir, "app.js");
  assert.match(source, /function applyDisplay\(display, source = "options"\)/);
  assert.match(source, /W = globalThis\.UsageI18n\.get\(lang\)/);
  // Nothing is polled: the theme message carries the language.
  assert.doesNotMatch(source, /setInterval/);
  assert.match(source, /message\.event !== "theme"/);
  assert.match(source, /event\.source !== window\.parent/);
  assert.match(source, /applyThemeEvent\(message\.data\);/);
  assert.match(source, /wanted\.startsWith\("zh"\) \? "zh" : "en"/);
  assert.match(source, /getAttribute\("content"\) \|\| "en"/);
});

test("official display preferences win over plugin options when the bridge provides them", () => {
  const source = read(uiDir, "app.js");
  assert.match(source, /let officialDisplay = false;/);
  assert.match(source, /const hasOfficialDisplay =[\s\S]*?display\.currency === "cny"/);
  assert.match(source, /if \(hasOfficialDisplay\) applyDisplay\(display, "magpie"\)/);
  assert.match(source, /if \(officialDisplay\) return;/);
  assert.match(source, /else if \(officialDisplay && source !== "magpie"\) \{\s*return false;\s*\}/);
  assert.match(source, /Number\(display\.fx\?\.rate\)/);
  const boot = read(pageDir, "boot.js");
  assert.match(boot, /function hasOfficialDisplay\(value\)/);
  assert.match(boot, /followDisplay\(current, true\)/);
  assert.match(boot, /followDisplay\(next, true\)/);
  assert.match(boot, /followDisplay\(options\);/);
});

test("warnings can explain incomplete model details in both languages", () => {
  const source = read(uiDir, "app.js");
  assert.match(source, /item\.code === "model-details"[\s\S]*?W\.modelDetails/);
  assert.match(scope.UsageI18n.get("zh").modelDetails(2), /2 个账号的模型明细/);
  assert.match(scope.UsageI18n.get("en").modelDetails(1), /1 account is/);
  assert.match(scope.UsageI18n.get("en").modelDetails(2), /2 accounts are/);
});

test("plugin options are re-read on callbacks, never polled", () => {
  const source = read(uiDir, "app.js");
  assert.match(source, /onVisibility\?\.\(\(visible\) =>/);
  assert.doesNotMatch(source, /usage:day|bridge\.read\(/);
  assert.match(source, /await bridge\.options\.get\(\)/);
  assert.match(source, /if \(!options \|\| typeof options !== "object"\) return;/);
  assert.match(source, /if \(options\.currency === "cny" \|\| options\.currency === "usd"\)/);
  assert.match(source, /meta\("settings"\) === "1"/);
  assert.match(source, /message\.event !== "theme"[\s\S]*?syncDisplaySettings\(window\.magpie\)/);
  assert.doesNotMatch(source, /setInterval|setTimeout\(\s*\(\)\s*=>\s*void syncDisplaySettings/);
  assert.match(read(pageDir, "boot.js"), /query\.set\("settings", "1"\)/);
});

test("slow usage reads get more than one gateway request to finish", () => {
  const source = read(uiDir, "app.js");
  assert.match(source, /const REQUEST_TIMEOUT_MS = 30_000;/);
  assert.match(source, /const SERVICE_TIMEOUT_MS = REQUEST_TIMEOUT_MS \+ 1_000;/);
  assert.match(source, /AbortSignal\.timeout\(REQUEST_TIMEOUT_MS\)/);
  assert.match(source, /\}, SERVICE_TIMEOUT_MS\);/);
  assert.match(source, /error\?\.name === "TimeoutError"[\s\S]*?state\.error = W\.serviceTimeout/);
  assert.match(source, /addEventListener\("pagehide", \(\) => clearTimeout\(serviceTimer\)/);
});

test("only the newest settings read can repaint display settings", () => {
  const source = read(uiDir, "app.js");
  assert.match(source, /let displaySettingsRequest = 0;/);
  assert.match(source, /const requestId = \+\+displaySettingsRequest;/);
  assert.match(source, /await bridge\.options\.get\(\);\s*if \(requestId !== displaySettingsRequest\) return;/);
});

test("a newer load owns the refresh UI after an older request settles", () => {
  const source = read(uiDir, "app.js");
  assert.match(source, /function isCurrentLoad\(requestId, requestedPeriod\)/);
  assert.match(source, /requestId === state\.requestId && requestedPeriod === state\.period/);
  assert.match(source, /if \(state\.controller === controller\) state\.controller = null;/);
  assert.match(source, /if \(!isCurrentLoad\(requestId, requestedPeriod\)\) return;/);
});

test("a retry can repaint and fingerprints cover displayed metrics", () => {
  const source = read(uiDir, "app.js");
  assert.match(source, /function renderError\(\) \{\s+state\.rendered = false;/);
  for (const field of [
    "item.calls",
    "item.errors",
    "item.unpriced",
    "item.input",
    "item.output",
    "item.tokens",
    "item.cache",
    "item.allTokens",
    "item.cacheRead",
    "item.cacheWrite",
    "item.cacheUnknown",
    "item.cacheUnknownCalls",
    "account.lastAt",
    "model.hostNotes",
  ]) {
    assert.match(source, new RegExp(field.replace(".", "\\.")), field);
  }
  assert.match(source, /const delay = attempt === 1 \? 1200 : attempt === 2 \? 2500 : 5000;/);
});

test("a quiet refresh repaints when only the cache hit composition changes", () => {
  const source = read(uiDir, "app.js");
  const start = source.indexOf("function fingerprint(data) {");
  const open = source.indexOf("{", start);
  let depth = 0;
  let end = -1;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) {
      end = index + 1;
      break;
    }
  }
  assert.ok(end > start, "fingerprint body was found");
  const fingerprint = new Function(`${source.slice(start, end)}; return fingerprint;`)();
  const sample = () => {
    const stats = {
      period: "today",
      calls: 1,
      input: 200,
      output: 10,
      tokens: 210,
      cache: 200,
      allTokens: 410,
      cacheRead: 200,
      cacheWrite: 0,
      cacheUnknown: 0,
      cacheUnknownCalls: 0,
      cost: 1,
    };
    return {
      period: "today",
      summary: { ...stats, accounts: 1, providers: 1, models: 1 },
      providers: [{
        id: "p",
        providerName: "P",
        ...stats,
        accounts: [{
          id: "a",
          account: "a",
          alias: "",
          providerName: "P",
          ...stats,
          lastAt: "",
          models: [{
            id: "m",
            model: "m",
            provider: "p",
            providerName: "P",
            ...stats,
            hostNotes: [],
          }],
        }],
      }],
    };
  };

  const before = fingerprint(sample());
  for (const path of [
    ["summary"],
    ["providers", 0],
    ["providers", 0, "accounts", 0],
    ["providers", 0, "accounts", 0, "models", 0],
  ]) {
    const changed = sample();
    let item = changed;
    for (const key of path) item = item[key];
    item.cacheRead = 150;
    item.cacheWrite = 50;
    item.cacheUnknownCalls = 1;
    assert.notEqual(fingerprint(changed), before, `fingerprint changed at ${path.join(".")}`);
  }
  const legacy = () => ({
    period: "today",
    summary: sample().summary,
    accounts: [{
      ...sample().providers[0].accounts[0],
      cacheRead: 200,
      cacheWrite: 0,
      cacheUnknown: 0,
      cacheUnknownCalls: 0,
    }],
  });
  const changedLegacy = legacy();
  changedLegacy.accounts[0].cacheRead = 150;
  changedLegacy.accounts[0].cacheWrite = 50;
  assert.notEqual(fingerprint(legacy()), fingerprint(changedLegacy));
});

test("a failed follow-up keeps the period already on screen", () => {
  const source = read(uiDir, "app.js");
  assert.match(source, /state\.data\?\.period === requestedPeriod/);
  assert.match(source, /let refreshFailed = false;/);
  assert.match(source, /function showRefreshWarning\(\)/);
  assert.match(source, /function clearRefreshWarning\(\)/);
  assert.match(source, /showRefreshWarning\(\);/);
  assert.match(source, /renderWarnings\(state\.data\?\.warnings \|\| \[\]\)/);
  assert.match(source, /renderWarnings\(body\.warnings \|\| \[\]\)/);
  assert.match(source, /x-usage-tree-refresh/);
  assert.match(source, /if \(!options\.quiet\) clearRefreshWarning\(\)/);
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
