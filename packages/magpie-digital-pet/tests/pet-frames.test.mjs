// tests/pet-frames.test.mjs
// Contract for the no-bundled-art frame loader: the package ships no sprite
// catalog, so the loader returns an empty Map and the page falls back to its
// procedural renderer.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  chooseFrame,
  getSpriteFrames,
  loadMonsterFrames,
} from "../lib/pet.frames.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const frames = loadMonsterFrames();
assert.equal(frames instanceof Map, true);
assert.equal(frames.size, 0);
assert.equal(getSpriteFrames(frames, "egg"), undefined);
assert.equal(chooseFrame(frames, "egg", ["walk_1", "walk_2"]), undefined);
assert.equal(existsSync(join(repoRoot, "lib", "monster-frames.json")), false);
assert.equal(existsSync(join(repoRoot, "tools", "extract-frames.mjs")), false);

console.log("all pet-frames tests passed");
