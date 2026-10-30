// tools/extract-frames.mjs
//
// Extracts the embedded MONSTER_FRAME_DATA pixel catalog from the local
// Apache-2.0 upstream TUI bundle (.upstream/dist/tui.js) into the checked-in
// static asset lib/monster-frames.json. The page only ever consumes the JSON;
// the upstream bundle stays untouched.
//
// Usage: bun tools/extract-frames.mjs

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const START_MARKER = "var MONSTER_FRAME_DATA = ";
const END_MARKER = "];\n\n// ../digital-pet-core/src/data/monster-frame-catalog.ts";
const SOURCE_LABEL = "jcendal/digital-pet 0.18.0 embedded TUI bundle";

/**
 * Extract the embedded monster frame catalog from the upstream TUI bundle.
 *
 * @param {{ upstreamBundlePath: string, outputPath: string }} options
 * @returns {{ sprites: number, frames: number }}
 */
export function extractMonsterFrames({ upstreamBundlePath, outputPath }) {
  const bundle = readFileSync(upstreamBundlePath, "utf8");

  const start = bundle.indexOf(START_MARKER);
  if (start === -1) {
    throw new Error(`MONSTER_FRAME_DATA start marker not found in ${upstreamBundlePath}`);
  }
  const literalStart = start + START_MARKER.length;
  if (bundle[literalStart] !== "[") {
    throw new Error("MONSTER_FRAME_DATA is not an array literal");
  }

  const end = bundle.indexOf(END_MARKER, literalStart);
  if (end === -1) {
    throw new Error(`MONSTER_FRAME_DATA end marker not found in ${upstreamBundlePath}`);
  }
  const literal = bundle.slice(literalStart, end + 1); // include the closing "]"

  // Parse the pure data array literal inside an empty sandbox. The literal
  // contains only strings/arrays, but vm keeps this from touching our scope.
  const data = vm.runInNewContext(literal, Object.create(null));
  if (!Array.isArray(data)) {
    throw new Error("MONSTER_FRAME_DATA did not parse to an array");
  }

  const sprites = {};
  const frameNames = [];
  let frameCount = 0;

  for (const entry of data) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new Error("MONSTER_FRAME_DATA entry must be a [sprite, frames] pair");
    }
    const [sprite, frameList] = entry;
    if (typeof sprite !== "string" || sprite.length === 0) {
      throw new Error("MONSTER_FRAME_DATA sprite id must be a non-empty string");
    }
    if (!Array.isArray(frameList)) {
      throw new Error(`frames for sprite "${sprite}" must be an array`);
    }
    if (Object.hasOwn(sprites, sprite)) {
      throw new Error(`duplicate sprite id "${sprite}" in MONSTER_FRAME_DATA`);
    }

    const spriteFrames = {};
    for (const frame of frameList) {
      if (!Array.isArray(frame) || frame.length !== 2) {
        throw new Error(`frame entry for sprite "${sprite}" must be a [name, content] pair`);
      }
      const [name, content] = frame;
      if (typeof name !== "string" || name.length === 0) {
        throw new Error(`frame name for sprite "${sprite}" must be a non-empty string`);
      }
      if (typeof content !== "string") {
        throw new Error(`frame content for "${sprite}/${name}" must be a string`);
      }
      if (Object.hasOwn(spriteFrames, name)) {
        throw new Error(`duplicate frame "${name}" for sprite "${sprite}"`);
      }
      spriteFrames[name] = content;
      if (!frameNames.includes(name)) frameNames.push(name);
      frameCount += 1;
    }
    sprites[sprite] = spriteFrames;
  }

  const output = { source: SOURCE_LABEL, frameNames, sprites };
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(output));

  const spriteCount = Object.keys(sprites).length;
  return { sprites: spriteCount, frames: frameCount };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === join(process.argv[1]);
if (isMain) {
  const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const upstreamBundlePath = join(repoRoot, ".upstream", "dist", "tui.js");
  const outputPath = join(repoRoot, "lib", "monster-frames.json");
  const { sprites, frames } = extractMonsterFrames({ upstreamBundlePath, outputPath });
  console.log(`${sprites} sprites / ${frames} frames -> ${outputPath}`);
}
