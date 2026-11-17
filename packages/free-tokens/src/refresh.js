// host 刷新逻辑（独立模块，便于单测；index.js 只导出 default，避免被 check.mjs 当插件调用）。
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { fetchFreeTokens } from "./aihot.js";
import { configDir, readLocal } from "./inventory.js";
import { buildPayload } from "./classify.js";

function defaultDataPath() { return process.env.FREE_TOKENS_DATA_PATH || fileURLToPath(new URL("../page/data.js", import.meta.url)); }
function writeAtomic(file, text) { const t = file + ".tmp"; fs.writeFileSync(t, text); fs.renameSync(t, file); }

export async function refresh(input, opts = {}) {
  const dir = (opts.configDir || configDir)(input);
  const local = (opts.readLocal || readLocal)(dir);
  const getFt = opts.fetchFreeTokens || fetchFreeTokens;
  const path = opts.dataPath || defaultDataPath();
  let payload;
  try {
    payload = buildPayload(await getFt(), local);
  } catch (e) {
    writeAtomic(path, "window.__FREE_TOKENS__ = { error: true, meta: { generatedAt: " + JSON.stringify(new Date().toISOString()) + " } };\n");
    console.error("[free-tokens] fetch failed:", e.message);
    return null;
  }
  writeAtomic(path, "window.__FREE_TOKENS__ = " + JSON.stringify(payload) + ";\n");
  console.error(`[free-tokens] data.js: ${payload.deals.length} deals · ${Object.keys(payload.demoState.installed).length} providers${payload.demoState.configKnown ? "" : " · config unknown"}`);
  return payload;
}
