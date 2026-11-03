/**
 * Explicit Quota Snapshot Loader for Bun (`magpie.hooks` & `/v1/systemone`)
 *
 * By default, performs zero disk reads and never walks parent directories or probes
 * Magpie's internal configuration directory.
 * Only reads from:
 * 1. Explicit `options.quotas` in-memory object/array (returned immediately)
 * 2. Explicit `options.quotasPath` / `options.quotaFile` / `options.magpieConfigDir` when explicitly configured by the user
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const CACHE_TTL_MS = 5000;

let cachedPath = "";
let cachedMtimeMs = 0;
let cachedReadAt = 0;
let cachedQuotas = null;

/**
 * Resolve an explicitly configured quotas file path if provided in `options`.
 * Never walks parent directories or probes `$HOME` / `$XDG_CONFIG_HOME`.
 */
export function resolveMagpieQuotasFile(options = {}) {
  const explicitFile = options.quotasPath || options.quotaFile;
  if (typeof explicitFile === "string" && explicitFile.trim()) {
    return explicitFile.trim();
  }

  const explicitDir = options.magpieConfigDir;
  if (typeof explicitDir === "string" && explicitDir.trim()) {
    const dir = explicitDir.trim();
    const candidate = join(dir, "quotas.json");
    if (existsSync(candidate)) return candidate;
    const nested = join(dir, "magpie", "quotas.json");
    if (existsSync(nested)) return nested;
    return candidate;
  }

  return "";
}

/**
 * Load live subscription quotas from `options.quotas` or an explicitly configured `options.quotasPath` / `options.quotaFile`.
 */
export function loadLiveQuotas(options = {}, nowMs = Date.now()) {
  if (options.quotas && typeof options.quotas === "object") {
    return options.quotas;
  }
  if (options.disableQuotas === true) {
    return null;
  }

  const qPath = resolveMagpieQuotasFile(options);
  if (!qPath) return null;

  if (
    cachedQuotas &&
    cachedPath === qPath &&
    nowMs - cachedReadAt < CACHE_TTL_MS
  ) {
    return cachedQuotas;
  }

  try {
    if (!existsSync(qPath)) return null;
    const st = statSync(qPath);
    if (cachedQuotas && cachedPath === qPath && st.mtimeMs === cachedMtimeMs) {
      cachedReadAt = nowMs;
      return cachedQuotas;
    }
    const rawText = readFileSync(qPath, "utf8");
    const parsed = JSON.parse(rawText);
    if (parsed && typeof parsed === "object") {
      cachedPath = qPath;
      cachedMtimeMs = st.mtimeMs;
      cachedReadAt = nowMs;
      cachedQuotas = parsed;
      return parsed;
    }
  } catch {
    // Non-fatal if quotas file is unavailable or being written concurrently
  }

  return null;
}

export function clearQuotasCache() {
  cachedPath = "";
  cachedMtimeMs = 0;
  cachedReadAt = 0;
  cachedQuotas = null;
}
