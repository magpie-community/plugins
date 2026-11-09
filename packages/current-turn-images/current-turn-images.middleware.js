import {filterRequest} from "./filter.js";

// Compatibility entry for standalone synchronous middleware installations.
export function onRequest(body, ctx) {
  const result = filterRequest(body, ctx.protocol);
  if (!result) return;
  console.log("[current-turn-images] " + JSON.stringify(result.stats));
  if (result.stats.removedImages > 0) return result.body;
}
