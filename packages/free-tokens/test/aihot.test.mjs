import { test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { fetchFreeTokens, SOURCE } from "../src/aihot.js";

const REAL = fs.readFileSync(fileURLToPath(new URL("./fixtures/free-tokens.md", import.meta.url)), "utf8");
// AIHOT 2026-11-28 对 free-tokens.data 的原话
const REFUSED = '{"error":"use_open_interfaces","message":"网页和网页自用的数据不给程序批量读取，请改用开放入口"}';

test("reads AIHOT's open entry (the .md) with the honest UA", async () => {
  let seen = null;
  const fake = async (url, init) => { seen = { url, init }; return { ok: true, status: 200, text: async () => REAL }; };
  const d = await fetchFreeTokens(fake);
  assert.equal(d.deals.length, 19);
  assert.equal(seen.url, "https://aihot.news/free-tokens.md");
  assert.equal(SOURCE, seen.url);
  assert.equal(seen.init.headers["User-Agent"], "magpie-free-tokens/0.1 (+local-desktop-plugin)");
  assert.ok(!/Mozilla|Chrome|Safari/.test(seen.init.headers["User-Agent"]), "never a browser's UA");
  assert.match(seen.init.headers.Accept, /text\/markdown/);
});
test("403 use_open_interfaces throws with AIHOT's reason", async () => {
  const fake = async () => ({ ok: false, status: 403, statusText: "Forbidden", text: async () => REFUSED });
  await assert.rejects(() => fetchFreeTokens(fake), /AIHOT 403 Forbidden use_open_interfaces/);
});
test("non-ok without a JSON body throws", async () => {
  const fake = async () => ({ ok: false, status: 500, text: async () => "<html>oops</html>" });
  await assert.rejects(() => fetchFreeTokens(fake), /^Error: AIHOT 500$/);
});
test("200 with an empty or cut body throws", async () => {
  await assert.rejects(() => fetchFreeTokens(async () => ({ ok: true, status: 200, text: async () => "" })), /内容异常/);
  await assert.rejects(() => fetchFreeTokens(async () => ({ ok: true, status: 200, text: async () => REAL.slice(0, 6000) })), /不完整/);
});
