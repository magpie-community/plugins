// host 刷新逻辑（独立模块，便于单测；index.js 只导出 default，避免被 check.mjs 当插件调用）。
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { fetchFreeTokens } from "./aihot.js";
import { configDir, readLocal } from "./inventory.js";
import { buildPayload } from "./classify.js";

function defaultDataPath() { return process.env.FREE_TOKENS_DATA_PATH || fileURLToPath(new URL("../page/data.js", import.meta.url)); }
function writeAtomic(file, text) { const t = file + ".tmp"; fs.writeFileSync(t, text); fs.renameSync(t, file); }
// 上次读到的 AIHOT 数据，放在 data.js 旁边（随包目录走，不进 npm 包）
export function lastPath(dataPath) { return dataPath.replace(/[^/\\]*$/, "aihot-last.json"); }
function readLast(file) {
  try { const j = JSON.parse(fs.readFileSync(file, "utf8")); return j && j.ft && Array.isArray(j.ft.deals) && j.ft.deals.length && typeof j.fetchedAt === "string" ? j : null; }
  catch { return null; }
}

export async function refresh(input, opts = {}) {
  const dir = (opts.configDir || configDir)(input);
  const local = (opts.readLocal || readLocal)(dir);
  const getFt = opts.fetchFreeTokens || fetchFreeTokens;
  const path = opts.dataPath || defaultDataPath();
  const last = lastPath(path);
  let payload;
  try {
    const ft = await getFt();
    payload = buildPayload(ft, local);
    payload.meta.fetchedAt = payload.meta.generatedAt;
    try { writeAtomic(last, JSON.stringify({ fetchedAt: payload.meta.fetchedAt, ft })); } catch {}
  } catch (e) {
    console.error("[free-tokens] fetch failed:", e.message);
    const prev = readLast(last);
    if (!prev) {
      writeAtomic(path, "window.__FREE_TOKENS__ = { error: true, meta: { generatedAt: " + JSON.stringify(new Date().toISOString()) + " } };\n");
      return null;
    }
    // 读不到 AIHOT 时用上次读到的，档位按本机现状重新算
    payload = buildPayload(prev.ft, local);
    payload.meta.fetchedAt = prev.fetchedAt;
    payload.meta.stale = true;
  }
  writeAtomic(path, "window.__FREE_TOKENS__ = " + JSON.stringify(payload) + ";\n");
  console.error(`[free-tokens] data.js: ${payload.deals.length} deals · ${Object.keys(payload.demoState.installed).length} providers${payload.demoState.configKnown ? "" : " · config unknown"}${payload.meta.stale ? " · stale" : ""}`);
  return payload;
}
