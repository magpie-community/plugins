import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dirname, "..");
const uiDir = join(dir, "ui");
const read = (file) => readFileSync(join(uiDir, file), "utf8");

const base = {
  period: "today",
  generatedAt: "2026-11-11T00:00:00.000Z",
  source: "synthetic gateway",
  summary: {
    accounts: 0,
    providers: 0,
    models: 0,
    calls: 0,
    errors: 0,
    unpriced: 0,
    input: 0,
    output: 0,
    tokens: 0,
    cache: 0,
    allTokens: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheUnknown: 0,
    cacheUnknownCalls: 0,
    cost: 0,
  },
  providers: [],
  accounts: [],
  warnings: [],
};

const tick = async () => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

// The real app.js runs here against a tiny DOM and a real fetch sequence.
// This exercises the initial load, a failed manual refresh and the quiet
// follow-up that clears the warning when the gateway recovers.
async function runRefreshFlow(lang) {
  const runtime = {};
  new Function("globalThis", read("i18n.js"))(runtime);
  new Function("globalThis", read("view.js"))(runtime);

  const meta = new Map([
    ["usage-tree-token", "test-token"],
    ["usage-tree-theme", "light"],
    ["usage-tree-lang", lang],
    ["usage-tree-tokens", "{}"],
    ["usage-tree-currency", "usd"],
    ["usage-tree-usd-cny", ""],
    ["usage-tree-chinese-units", "false"],
    ["usage-tree-settings", "0"],
  ]);

  function element(tag = "div") {
    const listeners = new Map();
    const classes = new Set();
    const attributes = new Map();
    return {
      tagName: String(tag).toUpperCase(),
      className: "",
      textContent: "",
      title: "",
      hidden: false,
      disabled: false,
      type: "",
      placeholder: "",
      innerHTML: "",
      children: [],
      style: { setProperty() {} },
      dataset: {},
      listeners,
      classList: {
        add(...items) { for (const item of items) classes.add(item); },
        remove(...items) { for (const item of items) classes.delete(item); },
        toggle(item, force) {
          const on = force === undefined ? !classes.has(item) : Boolean(force);
          if (on) classes.add(item);
          else classes.delete(item);
          return on;
        },
        contains(item) { return classes.has(item); },
      },
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = [...children]; },
      setAttribute(name, value) { attributes.set(name, String(value)); },
      getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      querySelectorAll() { return []; },
      closest() { return null; },
      click() {
        for (const fn of listeners.get("click") || []) fn({ target: this });
      },
    };
  }

  const elements = new Map();
  for (const id of [
    "summary", "accounts", "state-card", "warning", "refresh", "progress",
    "expand-all", "search", "period", "token-cache", "sort", "source-note", "updated",
  ]) elements.set(id, element());

  const document = {
    documentElement: { lang: "", dataset: {}, style: { setProperty() {} } },
    title: "",
    hidden: false,
    querySelector(selector) {
      const name = /meta\[name="([^"]+)"\]/.exec(selector)?.[1];
      return meta.has(name) ? { getAttribute: () => meta.get(name) } : null;
    },
    querySelectorAll() { return []; },
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    },
    createElement(tag) { return element(tag); },
    createTextNode(value) { return { textContent: String(value) }; },
  };
  const window = { addEventListener() {}, parent: {}, magpie: undefined };
  const location = { href: `http://127.0.0.1:3494/?lang=${lang}`, search: `?lang=${lang}` };

  let timerId = 0;
  const timers = new Map();
  const fakeSetTimeout = (fn, delay) => {
    const id = ++timerId;
    timers.set(id, { fn, delay });
    return id;
  };
  const fakeClearTimeout = (id) => { timers.delete(Number(id)); };
  const pagehide = [];
  const globalAddEventListener = (type, fn) => {
    if (type === "pagehide") pagehide.push(fn);
  };

  class FakeAbortController {
    signal = { aborted: false };
    abort() { this.signal.aborted = true; }
  }
  const FakeAbortSignal = {
    any(signals) { return signals[0]; },
    timeout() { return { aborted: false }; },
  };

  const stale = { ...base, stale: true, warnings: [] };
  const warnings = [{ code: "no-usage" }, { code: "model-details", count: 2 }];
  const failed = { ...base, stale: true, warnings };
  const replies = [
    { header: "ok", body: stale },
    { header: "failed", body: failed },
    { header: "failed", body: failed },
    { header: "ok", body: failed },
  ];
  const requests = [];
  let replyIndex = 0;
  const fakeFetch = async (url, options) => {
    requests.push({ url: String(url), options });
    const reply = replies[Math.min(replyIndex++, replies.length - 1)];
    return {
      ok: true,
      status: 200,
      headers: {
        get(name) {
          return name.toLowerCase() === "x-usage-tree-refresh" ? reply.header : null;
        },
      },
      json: async () => reply.body,
    };
  };

  new Function(
    "globalThis", "document", "window", "location", "fetch",
    "setTimeout", "clearTimeout", "addEventListener",
    "AbortController", "AbortSignal",
    read("app.js"),
  )(
    runtime, document, window, location, fakeFetch,
    fakeSetTimeout, fakeClearTimeout, globalAddEventListener,
    FakeAbortController, FakeAbortSignal,
  );

  await tick();
  const warning = elements.get("warning");
  const first = { hidden: warning.hidden, text: warning.textContent };
  elements.get("refresh").click();
  await tick();
  const afterFailure = { hidden: warning.hidden, text: warning.textContent };

  const quiet = [...timers.entries()]
    .filter(([, timer]) => String(timer.fn).includes("quiet: true"))
    .sort((a, b) => b[0] - a[0])[0];
  assert.ok(quiet, "a stale answer schedules a quiet follow-up");
  quiet[1].fn();
  await tick();
  const whileStillFailed = { hidden: warning.hidden, text: warning.textContent };
  const recovery = [...timers.entries()]
    .filter(([, timer]) => String(timer.fn).includes("quiet: true"))
    .sort((a, b) => b[0] - a[0])[0];
  assert.ok(recovery, "a failed quiet answer schedules another retry");
  recovery[1].fn();
  await tick();
  const afterRecovery = { hidden: warning.hidden, text: warning.textContent };
  for (const fn of pagehide) fn();
  return { first, afterFailure, whileStillFailed, afterRecovery, requests, warnings: runtime.UsageI18n.get(lang) };
}

test("an older disk cache does not warn, and a quiet recovery clears a real warning", async () => {
  const zh = await runRefreshFlow("zh");
  assert.equal(zh.first.hidden, true);
  assert.equal(zh.first.text, "");
  assert.equal(zh.afterFailure.hidden, false);
  assert.match(zh.afterFailure.text, /；刷新失败/);
  assert.doesNotMatch(zh.afterFailure.text, /。；/);
  assert.match(zh.whileStillFailed.text, /刷新失败/);
  assert.equal(zh.afterRecovery.hidden, false);
  assert.match(zh.afterRecovery.text, /这个周期还没有用量/);
  assert.match(zh.afterRecovery.text, /2 个账号的模型明细/);
  assert.doesNotMatch(zh.afterRecovery.text, /刷新失败/);
  assert.equal(zh.requests.length, 4);
  assert.match(zh.requests[1].url, /fresh=1/);
  assert.doesNotMatch(zh.requests[2].url, /fresh=1/);
  assert.doesNotMatch(zh.requests[3].url, /fresh=1/);

  const en = await runRefreshFlow("en");
  assert.equal(en.first.hidden, true);
  assert.equal(en.first.text, "");
  assert.match(en.afterFailure.text, /Refresh failed/);
  assert.match(en.whileStillFailed.text, /Refresh failed/);
  assert.equal(en.afterRecovery.hidden, false);
  assert.match(en.afterRecovery.text, /No usage in this period yet/);
  assert.match(en.afterRecovery.text, /2 accounts are/);
  assert.doesNotMatch(en.afterRecovery.text, /Refresh failed/);
});
