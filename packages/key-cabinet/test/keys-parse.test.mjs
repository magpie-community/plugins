import test from "node:test";
import assert from "node:assert/strict";
import { parseTable } from "../lib/keys.mjs";

// 与 Magpie 0.1.2597 `gateway-key list` 的真实表头一致；停用状态是 "disabled"。
const TABLE = [
  "ID                        NAME                STATE     GATEWAY KEY                LIMIT  MODELS  ACCOUNTS  ACCESS",
  "a5e7364678b7e0b033161a3a  project:dev         enabled   sk-magpie-key-…de821f      -      all     all       full",
  "b5e7364678b7e0b033161a3b  project:qa-off      disabled  sk-magpie-key-…aa11bb      -      all     all       full",
].join("\n");

test("parseTable maps the real gateway-key list columns", () => {
  const keys = parseTable(TABLE);
  assert.equal(keys.length, 2);
  assert.equal(keys[0].id, "a5e7364678b7e0b033161a3a");
  assert.equal(keys[0].name, "project:dev");
  assert.equal(keys[0].off, false);
  assert.equal(keys[0].limit, "-");
  assert.equal(keys[0].models, "all");
  assert.equal(keys[0].access, "full");
  assert.equal(keys[0].masked, "sk-magpie-key-…de821f");
});

test("parseTable reads Magpie's \"disabled\" state as off", () => {
  const keys = parseTable(TABLE);
  assert.equal(keys[1].off, true);
});

test("parseTable ignores plugin-host log lines", () => {
  const noisy = [
    "2026/11/01 21:56:09 plugin: [page-project-keys] listening on http://127.0.0.1:3491",
    TABLE,
  ].join("\n");
  assert.equal(parseTable(noisy).length, 2);
});
