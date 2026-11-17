import { test } from "bun:test";
import assert from "node:assert/strict";
import { fetchFreeTokens } from "../src/aihot.js";

const flat = JSON.stringify([{ _1: 2 }, "free-tokens", { _3: 4 }, "data", { _5: 6 }, "deals", []]);

test("fetch ok decodes body and sends honest UA", async () => {
  let seen = null;
  const fake = async (url, init) => { seen = { url, init }; return { ok: true, status: 200, text: async () => flat }; };
  const d = await fetchFreeTokens(fake);
  assert.deepEqual(d, { deals: [] });
  assert.match(seen.url, /aihot\.news\/free-tokens\.data/);
  assert.match(seen.init.headers["User-Agent"], /magpie-free-tokens/);
  assert.equal(seen.init.headers.Accept, "text/plain");
});
test("non-ok throws", async () => {
  const fake = async () => ({ ok: false, status: 500, statusText: "Server Error" });
  await assert.rejects(() => fetchFreeTokens(fake), /AIHOT 500/);
});
