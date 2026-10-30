// lib/pet.frames.mjs
//
// This package ships no sprite art. The page draws a deterministic procedural
// pixel blob per pet instead (see page/app.js drawFallback), so the frame
// catalog is intentionally empty. The helpers stay so the server can expose a
// stable `frames: {}` shape without reading any bundled asset.

/**
 * @returns {Map<string, Record<string, string>>}
 */
export function loadMonsterFrames() {
  return new Map();
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
