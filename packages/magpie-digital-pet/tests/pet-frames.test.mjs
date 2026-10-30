// tests/pet-frames.test.mjs
// Contract for the monster frame extraction tool and loader (Task 1).

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { extractMonsterFrames } from "../tools/extract-frames.mjs";
import {
  chooseFrame,
  defaultMonsterFramesPath,
  getSpriteFrames,
  loadMonsterFrames,
} from "../lib/pet.frames.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const upstreamBundlePath = join(repoRoot, ".upstream", "dist", "tui.js");

const tempDir = mkdtempSync(join(tmpdir(), "pet-frames-"));
const tempJson = join(tempDir, "monster-frames.json");

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}`);
    console.error(error);
  }
}

const result = extractMonsterFrames({ upstreamBundlePath, outputPath: tempJson });

test("extract reports the verified upstream counts", () => {
  assert.equal(result.sprites, 646);
  assert.equal(result.frames, 7227);
});

const frames = loadMonsterFrames(tempJson);

test("loader returns a Map with every sprite", () => {
  assert.equal(frames instanceof Map, true);
  assert.equal(frames.size, 646);
});

test("egg sprite has a non-empty walk_1 frame", () => {
  const egg = getSpriteFrames(frames, "egg");
  assert.ok(egg, "egg sprite must exist");
  assert.equal(egg.walk_1.length > 0, true);
});

test("getSpriteFrames returns undefined for unknown sprites", () => {
  assert.equal(getSpriteFrames(frames, "missing"), undefined);
});

test("chooseFrame returns undefined for unknown sprites", () => {
  assert.equal(chooseFrame(frames, "missing", ["walk_1", "walk_2"]), undefined);
});

test("chooseFrame honours the preference order", () => {
  // egg only ships walk_1/walk_2 upstream, which keeps this deterministic.
  const chosen = chooseFrame(frames, "egg", ["walk_2", "walk_1"]);
  assert.equal(chosen.name, "walk_2");
  assert.equal(chosen.content, getSpriteFrames(frames, "egg").walk_2);

  const fallback = chooseFrame(frames, "egg", ["nonexistent_pose", "walk_1"]);
  assert.equal(fallback.name, "walk_1");
});

test("chooseFrame returns undefined when no preferred name exists", () => {
  assert.equal(chooseFrame(frames, "egg", ["nope_1", "nope_2"]), undefined);
});

test("loader does not mutate frame strings", () => {
  const fileSource = JSON.parse(readFileSync(tempJson, "utf8"));
  const egg = getSpriteFrames(frames, "egg");
  assert.equal(egg.walk_1, fileSource.sprites.egg.walk_1);
});

test("defaultMonsterFramesPath points at the checked-in asset", () => {
  assert.equal(defaultMonsterFramesPath(), join(repoRoot, "lib", "monster-frames.json"));
});

test("extractor rejects a bundle missing the data markers", () => {
  const badBundle = join(tempDir, "bad.js");
  writeFileSync(badBundle, "var SOMETHING_ELSE = [];\n");
  assert.throws(
    () => extractMonsterFrames({ upstreamBundlePath: badBundle, outputPath: join(tempDir, "out.json") }),
    /MONSTER_FRAME_DATA/,
  );
});

test("extractor rejects malformed entries with a clear error", () => {
  const badBundle = join(tempDir, "bad-shape.js");
  writeFileSync(
    badBundle,
    'var MONSTER_FRAME_DATA = [\n  ["egg", [["walk_1", 42]]]\n];\n\n// ../digital-pet-core/src/data/monster-frame-catalog.ts\n',
  );
  assert.throws(
    () => extractMonsterFrames({ upstreamBundlePath: badBundle, outputPath: join(tempDir, "out2.json") }),
    /content .* must be a string/,
  );
});

rmSync(tempDir, { recursive: true, force: true });

if (failures > 0) {
  console.error(`${failures} test(s) failed`);
  process.exit(1);
}
console.log("all pet-frames tests passed");
