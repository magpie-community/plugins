import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readKeysFileLimits } from "../lib/caller-keys-core.mjs";

test("readKeysFileLimits 归一化 limit + moreLimits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "key-cabinet-limits-"));
  const path = join(dir, "caller-keys.json");
  try {
    await writeFile(path, JSON.stringify([
      {
        id: "k1",
        secret: "sk-magpie-key-fixture",
        limit: { period: "day", tokens: 123456, cost: 1.5, cacheReads: true },
        moreLimits: [
          { period: "week", tokens: 5000 },
          { period: "days", days: 3, since: "2026-11-01T00:00:00Z" },
        ],
      },
      { id: "k2" },
    ]));
    const limits = await readKeysFileLimits(path, "k1");
    assert.equal(limits.length, 3);
    assert.deepEqual(limits[0], {
      period: "day",
      tokens: 123456,
      cost: 1.5,
      cacheReads: true,
    });
    assert.equal(limits[1].period, "week");
    assert.equal(limits[1].tokens, 5000);
    assert.equal(limits[2].days, 3);
    assert.equal(limits[2].since, "2026-11-01T00:00:00Z");
    assert.deepEqual(await readKeysFileLimits(path, "k2"), []);
    assert.equal(await readKeysFileLimits(path, "missing"), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readKeysFileLimits 对不存在的文件返回 null", async () => {
  const dir = await mkdtemp(join(tmpdir(), "key-cabinet-limits-"));
  try {
    assert.equal(await readKeysFileLimits(join(dir, "nope.json"), "k1"), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readKeysFileLimits 忽略 null / 空字符串上限", async () => {
  const dir = await mkdtemp(join(tmpdir(), "key-cabinet-limits-"));
  const path = join(dir, "caller-keys.json");
  try {
    await writeFile(path, JSON.stringify([
      { id: "k1", limit: { period: "day", tokens: null, cost: "", cacheReads: false } },
    ]));
    const limits = await readKeysFileLimits(path, "k1");
    assert.deepEqual(limits, [{ period: "day" }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
