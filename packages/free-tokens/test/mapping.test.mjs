import { test } from "bun:test";
import assert from "node:assert/strict";
import { MAPPING } from "../src/mapping.js";

test("every mapping npm is a scoped package (never a bare short name)", () => {
  for (const [k, v] of Object.entries(MAPPING)) {
    assert.match(v.npm, /^@[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*$/i, `${k}: npm=${v.npm}`);
    assert.equal(v.cli, undefined, `${k}: cli field must be removed`);
    assert.ok(v.pid && v.name, `${k}: pid/name`);
  }
});
