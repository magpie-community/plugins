import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readCloud, readLocal } from "../lib/sources.mjs";
const usage = {
  model: "gpt-test",
  timestamp: "2026-01-01T00:00:00Z",
  inputTokens: 10,
  outputTokens: 1,
};
async function dir(t) {
  const d = await mkdtemp(join(tmpdir(), "amp-source-"));
  t.after(() => rm(d, { recursive: true, force: true }));
  return d;
}
test("cloud exports include archived threads, project private fields away, and reuse unchanged cache", async (t) => {
  const dataDir = await dir(t),
    calls = [];
  const run = async (args) => {
    calls.push(args);
    if (args[1] === "list")
      return [{ id: "T-cloud", updated: usage.timestamp }];
    return {
      id: "T-cloud",
      title: "private",
      messages: [
        {
          role: "assistant",
          messageId: 1,
          content: [{ text: "private" }],
          usage,
        },
      ],
    };
  };
  const first = await readCloud({ dataDir, run });
  assert.equal(first.exported, 1);
  assert.ok(calls[0].includes("--include-archived"));
  const text = await readFile(join(dataDir, "cloud/T-cloud.json"), "utf8");
  assert.ok(!text.includes("private"));
  assert.equal((await readCloud({ dataDir, run })).exported, 0);
});
test("failed exports do not advance checkpoints", async (t) => {
  const dataDir = await dir(t);
  let fail = true;
  const run = async (args) => {
    if (args[1] === "list")
      return [{ id: "T-cloud", updated: usage.timestamp }];
    if (fail) throw new Error("Offline");
    return { id: "T-cloud", messages: [] };
  };
  assert.equal((await readCloud({ dataDir, run })).errors.length, 1);
  fail = false;
  assert.equal((await readCloud({ dataDir, run })).exported, 1);
});
test("bounded exports resume on the next run", async (t) => {
  const dataDir = await dir(t);
  const run = async (args) =>
    args[1] === "list"
      ? [
          { id: "T-one", updated: usage.timestamp },
          { id: "T-two", updated: usage.timestamp },
        ]
      : { id: args[2], messages: [] };
  assert.equal((await readCloud({ dataDir, run, maxExports: 1 })).remaining, 1);
  assert.equal((await readCloud({ dataDir, run, maxExports: 1 })).remaining, 0);
});
test("missing local source is visible", async (t) => {
  assert.equal(
    (await readLocal([join(await dir(t), "missing")])).errors.length,
    1,
  );
});
