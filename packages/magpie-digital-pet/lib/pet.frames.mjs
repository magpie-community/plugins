// lib/pet.frames.mjs
//
// Loads the checked-in pixel frame catalog (lib/monster-frames.json, produced
// by tools/extract-frames.mjs from the Apache-2.0 upstream bundle) and exposes
// small pure helpers to pick frames for a sprite. Frame strings are returned
// exactly as stored; nothing here mutates them.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Absolute path of the checked-in generated asset.
 * @returns {string}
 */
export function defaultMonsterFramesPath() {
  return join(dirname(fileURLToPath(import.meta.url)), "monster-frames.json");
}

/**
 * Load the catalog JSON into a Map of sprite id -> { frameName: content }.
 *
 * @param {string} [filePath]
 * @returns {Map<string, Record<string, string>>}
 */
export function loadMonsterFrames(filePath = defaultMonsterFramesPath()) {
  const parsed = JSON.parse(readFileSync(filePath, "utf8"));
  if (!parsed || typeof parsed !== "object" || !parsed.sprites || typeof parsed.sprites !== "object") {
    throw new Error(`invalid monster frames file: ${filePath}`);
  }
  return new Map(Object.entries(parsed.sprites));
}

/**
 * @param {Map<string, Record<string, string>>} frames
 * @param {string} sprite
 * @returns {Record<string, string> | undefined}
 */
export function getSpriteFrames(frames, sprite) {
  return frames.get(sprite);
}

/**
 * Pick the first available frame for a sprite, honouring preference order.
 *
 * @param {Map<string, Record<string, string>>} frames
 * @param {string} sprite
 * @param {string[]} preferredNames
 * @returns {{ name: string, content: string } | undefined}
 */
export function chooseFrame(frames, sprite, preferredNames) {
  const spriteFrames = frames.get(sprite);
  if (!spriteFrames) return undefined;
  for (const name of preferredNames) {
    const content = spriteFrames[name];
    if (typeof content === "string" && content.length > 0) {
      return { name, content };
    }
  }
  return undefined;
}
