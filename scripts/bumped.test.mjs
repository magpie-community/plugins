import { expect, test } from "bun:test"
import { unbumped } from "./bumped.mjs"

const versions = { "packages/a": ["0.1.0", "0.1.0"], "packages/b": ["0.1.0", "0.1.1"], "packages/new": [null, "0.1.0"], "packages/gone": ["0.1.0", null] }
const versionAt = (dir, at) => (versions[dir] ?? [null, null])[at === "base" ? 0 : 1]
const packed = () => ["index.mjs", "opencode2.mjs", "package.json", "README.md"]

test("a shipped file changed under the same version is named (plugins#1131)", () => {
  expect(unbumped(["packages/a/index.mjs", "packages/a/opencode2.mjs"], versionAt, packed)).toEqual(["packages/a@0.1.0: index.mjs, opencode2.mjs"])
})

test("a bumped, new or removed package passes", () => {
  expect(unbumped(["packages/b/index.mjs", "packages/new/index.mjs", "packages/gone/index.mjs"], versionAt, packed)).toEqual([])
})

test("README.md, tests and files outside packages need no bump", () => {
  expect(unbumped(["packages/a/README.md", "packages/a/index.test.mjs", "scripts/check.mjs", "registry.json"], versionAt, packed)).toEqual([])
})
