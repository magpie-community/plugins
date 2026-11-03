import { magpieOk, runMagpie } from "./magpie-cli.mjs";
import { magpieConfigDir } from "./paths.mjs";

let listCache = { at: 0, keys: null, key: "" };
const LIST_TTL_MS = 4_000;
// Magpie 0.1.2541 的 `gateway-key list` 不支持 --json（会以 usage 错误退出）。
// 只探测一次，之后记住结果，避免每次缓存失效都白跑一个必然失败的进程。
let jsonListSupported = null;
// 缓存只对同一组 CLI / 配置目录有效：测试会在同一进程里换 MAGPIE_BIN 和
// MAGPIE_CONFIG_DIR，不能让上一组的结果漏到下一组。
let listCacheScope = "";

function listScope() {
  return (process.env.MAGPIE_BIN || "magpie") + "\0" + magpieConfigDir();
}

function extractSecret(text) {
  const m = String(text || "").match(/sk-magpie-key-[a-f0-9]+/i);
  return m ? m[0] : "";
}

function extractId(text) {
  // Prefer an explicit id=… / ID: … token; Magpie table ids are 24 hex chars.
  const labeled = String(text || "").match(/\b(?:id|ID)\s*[:=]\s*([a-f0-9]{16,32})\b/);
  if (labeled) return labeled[1];
  const hex = String(text || "").match(/\b([a-f0-9]{24})\b/);
  return hex ? hex[1] : "";
}

export function parseTable(stdout) {
  const lines = String(stdout || "")
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter(Boolean)
    // drop Magpie plugin host log lines mixed into CLI stdout
    .filter((l) => !/^\d{4}\/\d{2}\/\d{2}/.test(l))
    .filter((l) => !l.includes("[page-project-keys]"));
  if (lines.length < 2) return [];
  const header = lines[0];
  const cols = header.split(/\s{2,}/).map((c) => c.trim());
  const out = [];
  for (const line of lines.slice(1)) {
    const parts = line.split(/\s{2,}/).map((c) => c.trim());
    if (parts.length < 2) continue;
    const row = {};
    cols.forEach((c, i) => {
      row[c.toLowerCase().replace(/\s+/g, "_")] = parts[i] ?? "";
    });
    const id = row.id || parts[0];
    const name = row.name || parts[1];
    const state = (row.state || parts[2] || "").toLowerCase();
    out.push({
      id,
      name,
      // Magpie prints "disabled" for a key that is off (not "off").
      off: state === "disabled" || state.includes("off") || state.includes("停"),
      limit: row.limit || parts[4] || "",
      models: row.models || parts[5] || "",
      accounts: row.accounts || parts[6] || "",
      access: row.access || parts[7] || "",
      // 形如 sk-magpie-key-…de821f；用来判断本地明文是否已被 Magpie 轮换。
      masked: row.gateway_key || parts[3] || "",
      raw: row,
    });
  }
  return out;
}

function invalidateListCache() {
  listCache = { at: 0, keys: null, key: "" };
}

export async function listKeys({ fresh = false } = {}) {
  const scope = listScope();
  if (scope !== listCacheScope) {
    listCacheScope = scope;
    listCache = { at: 0, keys: null, key: "" };
    jsonListSupported = null;
  }
  if (!fresh && listCache.keys && listCache.key === scope && Date.now() - listCache.at < LIST_TTL_MS) {
    return listCache.keys;
  }
  if (jsonListSupported !== false) {
    const jsonTry = await runMagpie(["gateway-key", "list", "--json"]);
    if (jsonTry.code === 0) {
      try {
        const data = JSON.parse(jsonTry.stdout);
        const arr = Array.isArray(data) ? data : data.keys || data.Keys || [];
        const keys = arr.map((k) => ({
          id: String(k.id || k.ID || ""),
          name: String(k.name || k.Name || ""),
          off: Boolean(k.off || k.Off),
          limit: k.limit || k.Limit || null,
          models: k.models || k.Models || [],
          accounts: k.accounts || k.Accounts || [],
          access: k.readOnly || k.ReadOnly ? "read-only" : "full",
        })).filter((k) => k.id);
        jsonListSupported = true;
        listCache = { at: Date.now(), keys, key: scope };
        return keys;
      } catch {
        // 退出码 0 但内容不是 JSON：回退文本表格，并且不再尝试。
        jsonListSupported = false;
      }
    } else {
      jsonListSupported = false;
    }
  }
  const r = await magpieOk(["gateway-key", "list"]);
  const keys = parseTable(r.stdout);
  listCache = { at: Date.now(), keys, key: scope };
  return keys;
}

/** Magpie mints sk-magpie-key-… itself and prints it on stdout. Custom --key cannot use that prefix. */
export async function addKey(name) {
  const r = await magpieOk(["gateway-key", "add", name]);
  invalidateListCache();
  const secret = extractSecret(r.stdout) || extractSecret(r.stderr);
  if (!secret) throw new Error("Key created but Magpie did not print the secret");

  // Prefer id from the same CLI output to avoid a second ~4s list round-trip.
  let id = extractId(r.stdout) || extractId(r.stderr);
  let hitName = name;
  if (!id) {
    const keys = await listKeys({ fresh: true });
    const hit = keys.find((k) => k.name === name);
    if (!hit) throw new Error("Key created but not found in list");
    id = hit.id;
    hitName = hit.name;
  }
  return { id, name: hitName, secret };
}

export async function rotateKey(id) {
  const r = await magpieOk(["gateway-key", "rotate", id]);
  invalidateListCache();
  const secret = extractSecret(r.stdout) || extractSecret(r.stderr);
  if (!secret) throw new Error("Key rotated but Magpie did not print the secret");
  return { id, secret };
}

export async function removeKey(id) {
  await magpieOk(["gateway-key", "remove", id]);
  invalidateListCache();
}

export async function setKeyModels(id, models) {
  // Magpie defaults new keys to all models — skip the extra CLI hop for Auto.
  if (!models || (Array.isArray(models) && models.length === 0) || models === "all") {
    return;
  }
  const list = Array.isArray(models) ? models : [models];
  await magpieOk(["gateway-key", "models", id, ...list]);
  invalidateListCache();
}

/**
 * Magpie CLI has no gateway-key off/on. GUI uses
 * POST /api/caller-keys/{off,on}-key (app-internal). Plugins flip the same
 * `off` field in ~/.config/magpie/caller-keys.json under Magpie's flock lock,
 * via Bun FFI (plugin host language) — no Python.
 */
export async function setKeyOff(id, off) {
  const { setCallerKeyOff } = await import("./caller-keys-store.mjs");
  await setCallerKeyOff(id, off);
  invalidateListCache();
}

/**
 * `gateway-key limit <id> day|week|month|<N>d|<N>h --tokens --cost --cache-reads`.
 *
 * Magpie 只允许两种写法：没有限额时直接写；已有 1 条时直接写会替换它；有 2 条
 * 以上时必须先 `remove <n>`，否则 CLI 直接报错。这里先删掉附加限额、保留主限额，
 * 再写目标窗口：任何一步失败时 Key 只会更严格，不会短暂变成「无任何限额」。
 * spec=null 才真正清空全部限额。
 */
export async function setKeyLimit(id, spec) {
  if (!spec) {
    await magpieOk(["gateway-key", "limit", id, "off"]);
    invalidateListCache();
    return null;
  }

  let count = null;
  try {
    const existing = await getKeyLimits(id);
    if (Array.isArray(existing)) count = existing.length;
  } catch {
    /* 读不到就盲删，remove 2 在只剩一条时会报错，正好停住。 */
  }
  if (count == null) {
    for (;;) {
      try {
        await magpieOk(["gateway-key", "limit", id, "remove", "2"]);
      } catch {
        break;
      }
    }
  } else {
    // remove 2 每次都删掉第 2 条，保留 primary；moreLimits 会依次前移。
    for (let n = count; n > 1; n--) {
      await magpieOk(["gateway-key", "limit", id, "remove", "2"]);
    }
  }

  const args = ["gateway-key", "limit", id, spec.window];
  if (spec.tokens != null) args.push("--tokens", String(spec.tokens));
  if (spec.cost != null) args.push("--cost", String(spec.cost));
  if (spec.cacheReads) args.push("--cache-reads");
  await magpieOk(args);
  invalidateListCache();
  return spec;
}

/** Best-effort read of a key's persisted limits (editing UI prefill). */
export async function getKeyLimits(id) {
  const { getCallerKeyLimits } = await import("./caller-keys-store.mjs");
  return getCallerKeyLimits(id);
}

/** Magpie 对不存在的 id 统一输出 `Key not found`（exit 1）。 */
export function isKeyNotFound(error) {
  const msg = error?.message || String(error || "");
  // 只认 Magpie 的 Key 级错误；不要把 "command not found" 之类也当成 Key 已删除。
  return /key not found/i.test(msg) || /找不到.*(key|钥匙)|(key|钥匙).*找不到/i.test(msg) || /不存在.*(key|钥匙)|(key|钥匙).*不存在/i.test(msg);
}
