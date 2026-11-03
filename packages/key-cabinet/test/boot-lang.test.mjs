import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const source = await readFile(fileURLToPath(new URL("../page/boot.js", import.meta.url)), "utf8");

async function boot({ magpie } = {}) {
  let target = "";
  const window = {};
  if (magpie) window.magpie = magpie;
  const context = {
    window,
    location: {
      hostname: "127.0.0.1",
      replace(url) { target = url; },
    },
    document: { getElementById: () => null },
    URLSearchParams,
    encodeURIComponent,
    btoa,
    unescape,
    setTimeout: () => 0,
  };
  runInNewContext(source, context);
  // 等 async IIFE 走完 ready → options.get → location.replace。
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));
  return target;
}

test("boot.js 把 Magpie 的 lang 带进页面 URL", async () => {
  const target = await boot({
    magpie: {
      ready: Promise.resolve({ dark: true, lang: "en", tokens: { bg: "#fff" } }),
      options: { get: async () => ({ port: 3491 }) },
    },
  });
  assert.match(target, /^http:\/\/127\.0\.0\.1:3491\/\?/);
  const q = new URL(target).searchParams;
  assert.equal(q.get("theme"), "dark");
  assert.equal(q.get("lang"), "en");
  assert.deepEqual(JSON.parse(Buffer.from(q.get("tokens"), "base64").toString("utf8")), { bg: "#fff" });
});

test("boot.js 保留 Magpie 的中文语言", async () => {
  const target = await boot({
    magpie: {
      ready: Promise.resolve({ dark: false, lang: "zh", tokens: {} }),
      options: { get: async () => ({ port: 3491 }) },
    },
  });
  assert.equal(new URL(target).searchParams.get("lang"), "zh");
});

test("没有 Magpie 桥时仍能直连默认端口，且不带 lang", async () => {
  const target = await boot();
  assert.match(target, /^http:\/\/127\.0\.0\.1:3491\/\?/);
  assert.equal(new URL(target).searchParams.get("lang"), null);
});
