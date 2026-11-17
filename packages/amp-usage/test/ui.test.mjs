import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const scope = {};
new Function("globalThis", await read("../ui/words.js"))(scope);
const { words, error } = scope.AmpUsage;

test("every error code the service can send reads in each language", async () => {
  // The codes as the service writes them: fail("…"), errors.push("…") and
  // the server's { code: "…" }; plus the page's own two.
  const codes = new Set(["unreachable", "unexpected"]);
  for (const f of await readdir(new URL("../lib/", import.meta.url))) {
    const src = await read(`../lib/${f}`);
    for (const re of [
      /\bfail\(\s*"(\w+)"/g,
      /errors\.push\("(\w+)"\)/g,
      /\bcode: "(\w+)"/g,
    ])
      for (const m of src.matchAll(re)) codes.add(m[1]);
  }
  for (const c of [
    "ampFailed",
    "localDirMissing",
    "magpieRefused",
    "reconnect",
  ])
    assert.ok(codes.has(c), `the scan above no longer finds ${c}`);
  for (const lang of ["en", "zh"])
    for (const c of codes) {
      assert.equal(typeof words[lang].err[c], "string", `${lang}: ${c}`);
      assert.equal(error(words[lang], c), words[lang].err[c]);
    }
  assert.deepEqual(
    Object.keys(words.zh.err).sort(),
    Object.keys(words.en.err).sort(),
  );
});

test("an unknown code reads as the generic message, never as the code", () => {
  for (const lang of ["en", "zh"])
    assert.equal(
      error(words[lang], "fromANewerService"),
      words[lang].err.unexpected,
    );
});

// Opens the page on a bare stand-in for the browser, answers its status poll
// with a scan finished `ago` ms before. Timers are advanced explicitly.
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};
async function open(ago, fetchImpl) {
  const element = () => ({
    children: [],
    dataset: {},
    style: {},
    classList: { toggle() {} },
    append() {},
    replaceChildren(...children) {
      this.children = children;
    },
    setAttribute() {},
    addEventListener() {},
  });
  const elements = new Map();
  const called = [];
  const timers = new Map();
  let tick;
  const status = {
    phase: "idle",
    lastScan: new Date(Date.now() - ago).toISOString(),
    remaining: 0,
    usage: [],
    issues: {},
    errors: [],
  };
  const page = {
    document: {
      documentElement: element(),
      createElement: element,
      getElementById: (id) =>
        elements.get(id) || elements.set(id, element()).get(id),
      querySelectorAll: () => [],
      querySelector: () => ({ content: "token" }),
    },
    location: new URL("http://127.0.0.1:3497/?lang=en"),
    navigator: { language: "en" },
    matchMedia: () => ({ matches: false }),
    atob,
    localStorage: { getItem: () => null, setItem() {} },
    setInterval(fn) {
      tick = fn;
    },
    setTimeout(fn, ms) {
      timers.set(fn, ms);
      return fn;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    AbortController,
    AmpUsage: scope.AmpUsage,
    fetch: async (url, init) => {
      called.push(new URL(url).pathname);
      if (fetchImpl) return fetchImpl(url, init, status);
      return { ok: true, json: async () => status };
    },
  };
  new Function(...Object.keys(page), await read("../ui/app.js"))(
    ...Object.values(page),
  );
  await settle();
  return { called, elements, tick, timers };
}

test("with nothing kept, the open page refreshes once a scan is 5 minutes old", async () => {
  assert.deepEqual((await open(4 * 60_000)).called, ["/api/status"]);
  assert.deepEqual((await open(6 * 60_000)).called, [
    "/api/status",
    "/api/refresh",
  ]);
});

test("a stalled status request times out without overlapping polls and recovers", async () => {
  let first = true;
  const page = await open(0, async (url, { signal }, status) => {
    if (!first) return { ok: true, json: async () => status };
    first = false;
    return new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")));
    });
  });
  await page.tick();
  assert.deepEqual(page.called, ["/api/status"]);
  assert.equal(page.timers.size, 1);
  const [[timeout, ms]] = page.timers;
  assert.equal(ms, 10_000);
  timeout();
  await settle();
  assert.equal(page.elements.get("errors").hidden, false);
  assert.equal(page.timers.size, 0);
  await page.tick();
  assert.equal(page.elements.get("errors").hidden, true);
});

test("a successful status poll clears a transient refresh failure", async () => {
  let failRefresh = true;
  const page = await open(0, async (url, init, status) => {
    if (new URL(url).pathname.endsWith("refresh") && failRefresh)
      throw new Error("connection reset");
    return { ok: true, json: async () => status };
  });
  await page.elements.get("refresh").onclick();
  assert.equal(page.elements.get("errors").hidden, false);
  failRefresh = false;
  await page.tick();
  assert.equal(page.elements.get("errors").hidden, true);
  assert.equal(page.elements.get("refresh").disabled, false);
});

test("a late poll failure cannot overwrite a newer successful refresh", async () => {
  let rejectPoll;
  const page = await open(0, async (url, init, status) => {
    if (new URL(url).pathname.endsWith("status"))
      return new Promise((resolve, reject) => {
        rejectPoll = reject;
      });
    return { ok: true, json: async () => status };
  });
  await page.elements.get("refresh").onclick();
  rejectPoll(new Error("connection reset"));
  await settle();
  assert.equal(page.elements.get("errors").hidden, true);
});

test("the page loads its words before its script", async () => {
  const html = await read("../ui/index.html");
  assert.ok(html.indexOf('src="words.js"') < html.indexOf('src="app.js"'));
});
