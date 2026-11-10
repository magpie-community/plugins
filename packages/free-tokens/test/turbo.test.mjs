import { test } from "bun:test";
import assert from "node:assert/strict";
import { decodeTurboStream } from "../src/turbo.js";

const valid = JSON.stringify([{ _1: 2 }, "free-tokens", { _3: 4 }, "data", { _5: 6 }, "deals", []]);
const missing = JSON.stringify([{ _1: 2 }, "free-tokens", {}]);
const negRef = JSON.stringify([{ _1: 2 }, "x", -5]);

test("decodes valid flatten into ft.data", () => {
  assert.deepEqual(decodeTurboStream(valid), { deals: [] });
});
test("bad JSON throws", () => assert.throws(() => decodeTurboStream("{oops"), /不是合法 JSON/));
test("non-array throws", () => assert.throws(() => decodeTurboStream("{}"), /结构异常/));
test("missing deals throws", () => assert.throws(() => decodeTurboStream(missing), /数据缺失/));
test("negative ref resolves to null then missing throws (covers ref<0)", () => assert.throws(() => decodeTurboStream(negRef), /数据缺失/));

test("plain key object branch (covers out[k]) and scalar element", () => {
  const plainKey = JSON.stringify([{ a: 1 }, "zz"]);
  assert.throws(() => decodeTurboStream(plainKey), /数据缺失/);
  const scalar = JSON.stringify([{ _1: 2 }, "free-tokens", { _3: 4 }, "data", { _5: 6 }, "deals", ["s"]]);
  assert.deepEqual(decodeTurboStream(scalar), { deals: ["s"] });
});
