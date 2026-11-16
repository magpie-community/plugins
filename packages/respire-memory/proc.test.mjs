import assert from "node:assert/strict";
import { test } from "node:test";
import { alive } from "./lock.mjs";

const err = (code) => () => {
  throw Object.assign(new Error(code), { code });
};
const deps = (stat, killImpl = () => {}) => ({
  platform: "linux",
  procRoot: "/fake-proc",
  readFile: () => {
    if (stat === undefined) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    return stat;
  },
  kill: killImpl,
});

test("alive keeps lock ownership semantics while rejecting zombies", () => {
  assert.equal(alive(0), true);
  assert.equal(alive(123, deps("123 (comm)) Z 1")), false);
  assert.equal(alive(123, deps("123 (comm)) X 1")), false);
  assert.equal(alive(123, deps("123 (comm) R 1")), true);
  assert.equal(alive(123, deps(undefined, err("EPERM"))), true);
  assert.equal(alive(123, deps("123 (comm)) Z 1", err("EPERM"))), false);
  assert.equal(alive(123, deps(undefined, err("ESRCH"))), false);

  const failure = Object.assign(new Error("EIO"), { code: "EIO" });
  assert.throws(() => alive(123, deps(undefined, () => { throw failure; })), (error) => error === failure);
});
