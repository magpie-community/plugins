import { randomUUID } from "node:crypto";
import { addKey, getKeyLimits, isKeyNotFound, listKeys, removeKey, rotateKey, setKeyLimit, setKeyModels, setKeyOff } from "./keys.mjs";
import { gatewayURL, listModels, resolveGateway } from "./gateway.mjs";
import { keyNameFor, loadStore, saveStore, slugify, withStoreLock } from "./store.mjs";
import { usageSummaryFallback } from "./usage.mjs";

// Serialize read-modify-write operations within this service, including the
// base URL refresh performed by listProjects. Rejections must not stall the queue.
// withStoreLock extends the same guarantee to other processes sharing this store.
let projectQueue = Promise.resolve();
function mutateProjects(operation) {
  const result = projectQueue.then(() => withStoreLock(operation));
  projectQueue = result.catch(() => {});
  return result;
}

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function notFoundInMagpie(keyId) {
  return badRequest(`Magpie 中已找不到这把 Key（${keyId}）；请删除这条本地记录后重新签发`);
}

const LIMIT_WINDOW = /^(?:day|week|month|[1-9]\d{0,3}(?:d|h))$/;

/** null / "off" 表示清除全部限额；否则必须至少有一个上限。 */
function parseLimitPatch(input) {
  if (input == null || input === "off") return null;
  if (typeof input !== "object" || Array.isArray(input)) throw badRequest("限额格式无效");
  const window = String(input.window || "").trim();
  if (!LIMIT_WINDOW.test(window)) {
    throw badRequest("限额窗口只支持 day / week / month / <N>d / <N>h");
  }
  let tokens = null;
  let cost = null;
  if (input.tokens != null && String(input.tokens).trim() !== "") {
    tokens = Number(input.tokens);
    if (!Number.isInteger(tokens) || tokens <= 0) throw badRequest("Tokens 上限需为正整数");
  }
  if (input.cost != null && String(input.cost).trim() !== "") {
    cost = Number(input.cost);
    if (!Number.isFinite(cost) || cost <= 0) throw badRequest("费用上限需为正数");
  }
  if (tokens == null && cost == null) {
    throw badRequest("至少填一个上限（Tokens 或费用）；要取消限额请点「清除限额」");
  }
  return { window, tokens, cost, cacheReads: Boolean(input.cacheReads) };
}

function publicProject(p, { includeSecret = false } = {}) {
  if (!p) return null;
  const out = {
    id: p.id,
    name: p.name,
    slug: p.slug,
    keyId: p.keyId,
    keyName: p.keyName,
    model: p.model || "",
    status: p.status || "on",
    // 限额以 Magpie 的 gateway-key list 为准（/api/meta 的 limits）；
    // 本地只保留旧版本写入的副本。
    limit: p.limit || "",
    baseUrl: p.baseUrl || gatewayURL(),
    createdAt: p.createdAt || null,
    updatedAt: p.updatedAt || null,
  };
  if (includeSecret) out.secret = p.secret || "";
  return out;
}

async function applyBaseUrl(store, url) {
  let dirty = false;
  for (const p of store.projects) {
    if (p.baseUrl !== url) {
      p.baseUrl = url;
      dirty = true;
    }
  }
  if (dirty) await saveStore(store);
  return url;
}

export async function listProjects() {
  // 探测网关放在锁外：另一个进程不该被一次网络超时挡住。
  const url = await resolveGateway();
  return mutateProjects(async () => {
    const store = await loadStore();
    await applyBaseUrl(store, url);
    return store.projects.map((p) => publicProject(p));
  });
}

export async function getProject(id, { includeSecret = false } = {}) {
  const store = await loadStore();
  const p = store.projects.find((x) => x.id === id);
  return publicProject(p, { includeSecret });
}

/** Limits as persisted in Magpie's caller-keys.json, for the editor's prefill. */
export async function projectLimits(id) {
  const store = await loadStore();
  const p = store.projects.find((x) => x.id === id);
  if (!p) throw badRequest("钥匙不存在");
  if (!p.keyId) return { limits: [] };
  try {
    return { limits: await getKeyLimits(p.keyId) };
  } catch (e) {
    return { limits: null, error: e.message };
  }
}

export function createProject(input) {
  const body = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  return mutateProjects(() => createProjectLocked(body));
}

async function createProjectLocked({ name, slug, model }) {
  const store = await loadStore();
  const cleanName = String(name || "").trim();
  const cleanSlug = slugify(slug || cleanName);
  if (!cleanName) throw badRequest("钥匙名不能为空");
  if (!cleanSlug) throw badRequest("标识无效（请用英文/数字，如 support-bot）");
  if (store.projects.some((p) => p.slug === cleanSlug)) {
    throw badRequest("标识已存在");
  }

  const keyName = keyNameFor(cleanSlug);

  // Fast path: mint first. Only if Magpie rejects a duplicate name do we
  // spend a list round-trip (~4s with plugin host) to explain the collision.
  let created;
  try {
    created = await addKey(keyName);
  } catch (e) {
    const msg = e?.message || String(e);
    if (/already|exists|同名|已有|duplicate/i.test(msg)) {
      try {
        const existing = await listKeys({ fresh: true });
        const prior = existing.find((k) => k.name === keyName);
        if (prior) {
          throw badRequest(`Magpie 已有同名 Key：${keyName}（id ${prior.id}）。请先在 Magpie 删除或换标识。`);
        }
      } catch (inner) {
        if (/Magpie 已有同名/.test(inner?.message || "")) throw inner;
      }
    }
    throw e;
  }

  const modelId = model == null ? "" : String(model).trim();
  try {
    if (modelId) await setKeyModels(created.id, [modelId]);

    const now = new Date().toISOString();
    const project = {
      id: randomUUID(),
      name: cleanName,
      slug: cleanSlug,
      keyId: created.id,
      keyName,
      secret: created.secret,
      model: modelId,
      status: "on",
      limit: "",
      baseUrl: await resolveGateway(),
      createdAt: now,
      updatedAt: now,
    };
    store.projects.unshift(project);
    await saveStore(store);
    return publicProject(project, { includeSecret: true });
  } catch (error) {
    try {
      await removeKey(created.id);
    } catch (cleanupError) {
      throw new Error(`创建失败：${error.message}；清理 Magpie Key ${created.id} 失败：${cleanupError.message}，请在 Magpie 中检查并删除`);
    }
    throw error;
  }
}

export function updateProject(id, patch) {
  return mutateProjects(() => updateProjectLocked(id, patch));
}

async function updateProjectLocked(id, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw badRequest("更新内容格式无效");
  }
  const store = await loadStore();
  const p = store.projects.find((x) => x.id === id);
  if (!p) throw badRequest("钥匙不存在");

  // 先校验限额，避免 model/status 已写入 Magpie、limit 才报错导致状态只改一半。
  const limitSpec = "limit" in patch ? parseLimitPatch(patch.limit) : undefined;

  let magpieTouched = false;

  if (patch.name != null) {
    const n = String(patch.name).trim();
    if (!n) throw badRequest("钥匙名不能为空");
    p.name = n;
  }

  if (patch.model !== undefined) {
    const modelId = String(patch.model || "").trim();
    p.model = modelId;
    if (p.keyId) {
      try {
        if (modelId) {
          await setKeyModels(p.keyId, [modelId]);
        } else {
          // Explicit Auto: ask Magpie to open to all models.
          await magpieModelsAll(p.keyId);
        }
        magpieTouched = true;
      } catch (e) {
        if (isKeyNotFound(e)) throw notFoundInMagpie(p.keyId);
        throw e;
      }
    }
  }

  if (patch.status === "on" || patch.status === "off") {
    if (p.keyId) {
      // 不比较本地旧值：Magpie GUI 可能已经改过状态，这里以 patch 为准幂等同步一次。
      try {
        await setKeyOff(p.keyId, patch.status === "off");
        magpieTouched = true;
      } catch (e) {
        if (isKeyNotFound(e)) throw notFoundInMagpie(p.keyId);
        throw e;
      }
    }
    p.status = patch.status;
  }

  if ("limit" in patch) {
    const spec = limitSpec;
    if (p.keyId) {
      try {
        await setKeyLimit(p.keyId, spec);
        magpieTouched = true;
      } catch (e) {
        if (isKeyNotFound(e)) throw notFoundInMagpie(p.keyId);
        throw e;
      }
    }
    // 真实限额随后由 /api/meta 的 limits 覆盖；清掉旧版本留下的副本，避免元数据失败时显示过期值。
    p.limit = "";
  }

  p.updatedAt = new Date().toISOString();
  try {
    await saveStore(store);
  } catch (e) {
    const prefix = magpieTouched ? "Magpie 已更新，但本地保存失败：" : "本地保存失败：";
    throw new Error(`${prefix}${e.message}。请检查存储权限后重试`);
  }
  return publicProject(p);
}

async function magpieModelsAll(id) {
  const { magpieOk } = await import("./magpie-cli.mjs");
  await magpieOk(["gateway-key", "models", id, "all"]);
}

export function resetProjectKey(id) {
  return mutateProjects(() => resetProjectKeyLocked(id));
}

async function resetProjectKeyLocked(id) {
  const store = await loadStore();
  const p = store.projects.find((x) => x.id === id);
  if (!p) throw badRequest("钥匙不存在");
  if (!p.keyId) throw badRequest("这把钥匙没有关联的 Magpie Key");
  let rotated;
  try {
    rotated = await rotateKey(p.keyId);
  } catch (e) {
    if (isKeyNotFound(e)) throw notFoundInMagpie(p.keyId);
    throw e;
  }
  p.secret = rotated.secret;
  p.updatedAt = new Date().toISOString();
  if (p.model) {
    try {
      await setKeyModels(p.keyId, [p.model]);
    } catch {
      /* ignore */
    }
  }
  try {
    await saveStore(store);
  } catch (e) {
    throw new Error(`Magpie 已重置 Key，但本地保存失败：${e.message}。旧 Key 已被替换，请检查存储权限后再次重置`);
  }
  return publicProject(p, { includeSecret: true });
}

export function deleteProject(id) {
  return mutateProjects(() => deleteProjectLocked(id));
}

async function deleteProjectLocked(id) {
  const store = await loadStore();
  const idx = store.projects.findIndex((x) => x.id === id);
  if (idx < 0) throw badRequest("钥匙不存在");
  const [p] = store.projects.splice(idx, 1);
  if (p.keyId) {
    try {
      await removeKey(p.keyId);
    } catch (e) {
      // Magpie 里已经没有了（GUI 删除、重建过 Magpie 配置等）：本地记录照样删掉。
      if (!isKeyNotFound(e)) {
        store.projects.splice(idx, 0, p);
        await saveStore(store);
        throw e;
      }
    }
  }
  try {
    await saveStore(store);
  } catch (e) {
    throw new Error(`Magpie Key 已删除，但本地保存失败：${e.message}。请检查存储权限后重试删除`);
  }
  return { ok: true, id };
}

export async function revealSecret(id) {
  const store = await loadStore();
  const p = store.projects.find((x) => x.id === id);
  if (!p) throw badRequest("钥匙不存在");
  if (!p.secret) throw badRequest("本地未保存该 Key 明文；请重置后重新复制");
  // 本地缓存可能早于 Magpie 侧的轮换/删除；先确认这把 Key 还在，再让页面提示。
  let exists = null;
  let rotated = null;
  try {
    const hit = (await listKeys()).find((k) => k.id === p.keyId);
    exists = Boolean(hit);
    if (hit?.masked) rotated = isRotated(hit.masked, p.secret);
  } catch {
    exists = null; // CLI 不可用时不阻塞查看，只是无法确认
  }
  return { id: p.id, secret: p.secret, exists, rotated };
}

/** Magpie 列表只显示 …+后 6 位；对不上就说明 Magpie 侧已经轮换过，本地明文过期。 */
function isRotated(masked, secret) {
  const m = String(masked || "").match(/([a-f0-9]{4,})$/i);
  if (!m) return null;
  return !String(secret || "").toLowerCase().endsWith(m[1].toLowerCase());
}

function limitText(value) {
  if (value == null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  const text = String(value).trim();
  if (!text || text === "-" || text === "—") return "无限额";
  return text;
}

export async function meta() {
  const gateway = await resolveGateway();
  let models = [];
  let modelsError = null;
  try {
    models = await listModels();
  } catch (e) {
    modelsError = e.message;
  }
  // 限额/启停以 Magpie 为准；读不到就让页面显示「—」，不再编一个「无日限额」。
  const limits = {};
  const states = {};
  const rotated = {};
  const store = await loadStore().catch(() => ({ projects: [] }));
  try {
    for (const key of await listKeys()) {
      limits[key.id] = limitText(key.limit);
      states[key.id] = { off: Boolean(key.off) };
      const saved = store.projects.find((p) => p.keyId === key.id);
      if (saved?.secret && key.masked) {
        const stale = isRotated(key.masked, saved.secret);
        if (stale !== null) rotated[key.id] = stale;
      }
    }
  } catch {
    /* CLI 不可用时仍可签发 */
  }
  return {
    gateway,
    models: [
      { id: "", label: "Auto", kind: "auto", note: "由 Magpie / 客户端决定" },
      ...models,
    ],
    modelsError,
    limits,
    states,
    rotated,
  };
}

export async function usageBundle(period = "today", opts = {}) {
  const store = await loadStore();
  const usage = await usageSummaryFallback(period, opts);
  const bySlug = {};
  for (const p of store.projects) {
    const hit =
      usage.byKey[p.keyId] ||
      usage.byKey[p.keyName] ||
      Object.values(usage.byKey).find(
        (u) => u.callerKeyId === p.keyId || u.callerKeyName === p.keyName
      ) ||
      null;
    bySlug[p.slug] = hit
      ? {
          tokens: hit.tokens,
          calls: hit.calls,
          errors: hit.errors,
          in: hit.in,
          out: hit.out,
          cost: hit.cost,
          sessions: hit.sessions || 0,
          cacheRead: hit.cacheRead || 0,
          cacheWrite: hit.cacheWrite || 0,
          cacheHitRate: hit.cacheHitRate,
          trend: hit.trend,
        }
      : {
          tokens: 0,
          calls: 0,
          errors: 0,
          in: 0,
          out: 0,
          cost: 0,
          sessions: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cacheHitRate: null,
          trend: null,
        };
  }
  const attributedCalls = Object.values(bySlug).reduce((n, u) => n + (u.calls || 0), 0);
  return {
    period: usage.period,
    totals: usage.totals,
    projects: bySlug,
    error: usage.error || null,
    pending: Boolean(usage.pending),
    cached: Boolean(usage.cached),
    stale: Boolean(usage.stale),
    note: usage.note || null,
    attributedCalls,
  };
}
