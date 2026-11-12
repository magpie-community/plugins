import { randomUUID } from "node:crypto";
import { CATALOG, WEB, PROFILES, fault, safeEndpoint } from "./catalog.mjs";
import { Store, validatePolicy } from "./store.mjs";
import { LocalVault } from "./vault.mjs";
import { runCredential } from "./credentials.mjs";
import { sourcePages } from "./adapter.mjs";
import { standaloneBackend } from "./standalone.mjs";

export function readableSource(source) {
  const result = { ...source };
  for (const field of ["text", "content", "snippet", "description"]) {
    if (typeof result[field] !== "string") continue;
    const sample = result[field].slice(0, 4000);
    const bad = (sample.match(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/g) || []).length;
    // Some upstream pages return binary/compressed bytes as text. Keep the
    // source URL, but don't send unreadable bytes to the page or the Agent.
    if (bad > 3 && bad / Math.max(sample.length, 1) > .02) {
      result[field] = ""; result.text_unavailable = "来源正文编码异常，请打开原文核验";
    }
  }
  return result;
}

export class Center {
  constructor({ store = new Store(), backend = standaloneBackend,
    credential = runCredential, vault = new LocalVault(store) } = {}) {
    this.store = store; this.backend = backend; this.credential = credential;
    this.cached = null; this.loading = null; this.active = 0; this.credentialQueue = Promise.resolve();
    this.vault = vault;
    this.quotaRequests = new Map();
  }
  quotaIdentity(c, key) { return JSON.stringify([c.baseUrl, key.ref]); }
  quotaSnapshot() {
    const saved = this.store.read("quotas.json", {}), policy = this.store.policy(), result = {};
    for (const [id, c] of Object.entries(policy.channels)) {
      result[id] = {};
      for (const key of c.keys) {
        const entry = saved[key.id];
        if (entry?.identity === this.quotaIdentity(c, key)) {
          const { identity, ...value } = entry;
          result[id][key.id] = { ...value, cachedStale: Date.now() - Date.parse(value.queriedAt || 0) > 300000 };
        }
      }
    }
    return result;
  }
  async queryQuota({ channel, keyId } = {}) {
    if (!["tavily", "firecrawl"].includes(channel)) return { status: "unsupported" };
    const c = this.store.policy().channels[channel], key = c.keys.find(k => k.id === keyId);
    if (!key?.enabled) throw fault("请选择已保存并启用的密钥");
    const identity = this.quotaIdentity(c, key), requestID = channel + identity;
    if (this.quotaRequests.has(requestID)) return this.quotaRequests.get(requestID);
    const prior = this.store.read("quotas.json", {})[key.id];
    if (prior?.identity === identity && Date.now() - Date.parse(prior.checkedAt) < 15000) {
      const { identity, ...value } = prior; return value;
    }
    const task = (async () => {
      const controller = new AbortController();
      const raw = await this.credentialCall(channel, key, { operation: "quota" }, c.baseUrl, AbortSignal.timeout(18000), controller);
      const value = Object.fromEntries(["status", "code", "httpStatus", "scope", "unit", "remaining", "used", "limit", "syncedKeys", "totalKeys", "errorKeys", "sourceUpdatedAt", "stale", "estimate", "keyUsed", "keyLimit", "keyRemaining", "queriedAt"].filter(k => Object.hasOwn(raw, k)).map(k => [k, raw[k]]));
      value.checkedAt = new Date().toISOString();
      await this.store.lock(() => {
        const current = this.store.policy().channels[channel];
        if (!current.keys.some(k => k.id === key.id && this.quotaIdentity(current, k) === identity)) return;
        const all = this.store.read("quotas.json", {});
        all[key.id] = { ...value, identity }; this.store.write("quotas.json", all);
      });
      return value;
    })().finally(() => this.quotaRequests.delete(requestID));
    this.quotaRequests.set(requestID, task); return task;
  }
  async discoverModels() {
    const c = this.store.policy().channels.grok;
    const key = c.keys.find(k => k.enabled);
    if (!key) throw fault("请先保存并启用一个 Grok Key");
    const cancel = new AbortController(), signal = AbortSignal.timeout(20000);
    const result = await this.credentialCall("grok", key, { operation: "models" }, c.baseUrl, signal, cancel);
    const models = (result.available_models || []).filter(m => typeof m === "string" && /^[\w./:@+-]{1,100}$/.test(m));
    const snapshot = { identity: JSON.stringify([c.baseUrl, key.ref]), available_models: models, at: new Date().toISOString() };
    this.store.write("models.json", snapshot);
    return snapshot;
  }
  commitCredentials(policy, encrypted) {
    const clean = validatePolicy(policy);
    return this.store.lock(() => {
      const old = this.store.policy();
      if (old.revision !== clean.revision) throw fault("设置已更新，请刷新后重试", "CONFLICT", 409);
      this.vault.persist(encrypted);
      this.store.write("policy.previous.json", old);
      clean.revision++;
      this.store.write("policy.json", clean);
      this.vault.prune(clean);
      return clean;
    });
  }
  async saveChannel(input) {
    const { channel, revision, baseUrl, strategy, keys } = input || {};
    if (!CATALOG[channel] || !Array.isArray(keys) || keys.length > 20) throw fault("渠道配置无效");
    const p = this.store.policy();
    if (p.revision !== revision) throw fault("设置已更新，请刷新后重试", "CONFLICT", 409);
    const old = p.channels[channel], nextKeys = [], encrypted = [], seen = new Set();
    for (const key of keys) {
      if (!key || typeof key.label !== "string" || !key.label.trim() || key.label.length > 60 || typeof key.enabled !== "boolean") throw fault("密钥标签或开关无效");
      const prior = old.keys.find(k => k.id === key.id);
      if (key.id) {
        if (seen.has(key.id)) throw fault("密钥重复");
        seen.add(key.id);
      }
      let next;
      if (typeof key.value === "string" && key.value.trim()) {
        const e = await this.vault.protect(channel, key.value); encrypted.push(e);
        next = { id: e.id, ref: `local://${e.id}` };
      } else if (prior) next = { id: prior.id, ref: prior.ref };
      else throw fault("新密钥不能为空");
      nextKeys.push({ ...next, label: key.label.trim(), enabled: key.enabled });
    }
    p.channels[channel] = { ...old, baseUrl, strategy, keys: nextKeys, credentialMode: "local", endpointSource: "custom" };
    if (channel === "grok" && input.models !== undefined) {
      p.models = input.models;
      if (input.defaultProfile !== undefined) p.defaultProfile = input.defaultProfile;
    }
    return this.commitCredentials(p, encrypted);
  }
  async savePolicy(value) {
    const old = this.store.policy();
    for (const [id, c] of Object.entries(value?.channels || {})) {
      for (const key of c.keys || []) {
        if (key.ref?.startsWith("local://") && !old.channels[id]?.keys.some(k => k.ref === key.ref && k.id === key.id))
          throw fault("请通过渠道密钥编辑器保存密钥");
      }
      if (c.baseUrl && !c.keys?.length && CATALOG[id]?.keyEnv &&
          c.credentialMode !== "local" &&
          safeEndpoint(c.baseUrl))
        throw fault(`${CATALOG[id].name} 的新地址需要专用凭据`);
    }
    return this.store.save(value);
  }
  async credentialCall(channel, key, args, baseUrl, signal, cancel) {
    if (!key || key.ref?.startsWith("local://")) {
      signal.throwIfAborted();
      const encrypted = key ? this.vault.cipher(channel, key) : undefined;
      return this.credential(channel, key, args, baseUrl, signal, encrypted);
    }
    // One unlock at a time. Queued channels never launch after a refusal.
    const previous = this.credentialQueue;
    let release;
    this.credentialQueue = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      if (signal.aborted) throw fault("调用已取消", "CANCELLED", 499);
      const encrypted = key?.ref?.startsWith("local://") ? this.vault.cipher(channel, key) : undefined;
      return await this.credential(channel, key, args, baseUrl, signal, encrypted);
    } catch (error) {
      if (error.code === "UNLOCK_REFUSED") cancel.abort();
      throw error;
    } finally { release(); }
  }
  async capability(fresh = false) {
    if (!fresh && this.cached && Date.now() - this.cached.at < 180_000) return this.cached.value;
    if (!this.loading) {
      this.loading = this.backend.capabilities().then(value => {
        this.cached = { at: Date.now(), value }; return value;
      }).finally(() => { this.loading = null; });
    }
    return this.loading;
  }
  async publicCapabilities(fresh = false) {
    const policy = this.store.policy();
    let raw;
    try { raw = await this.capability(fresh); }
    catch { raw = { channels: {}, grok: {} }; }
    let models = raw.grok || {};
    const grok = policy.channels.grok;
    if (grok.credentialMode === "local" || grok.keys.length) {
      const key = grok.keys.find(k => k.enabled), saved = this.store.read("models.json", null);
      const matches = key && saved?.identity === JSON.stringify([grok.baseUrl, key.ref]);
      models = { available_models: matches ? saved.available_models : [], model_list_status: matches ? "advertised" : "refresh_required", discovered_at: matches ? saved.at : null };
    }
    return {
      channels: Object.fromEntries(policy.order.map(id => {
        const c = policy.channels[id], upstream = raw.channels?.[id];
        const publicChannel = ["you", "github", "arxiv", "crossref"].includes(id);
        const configured = c.keys.length || c.credentialMode === "local" && CATALOG[id].keyEnv && !publicChannel ? c.keys.some(k => k.enabled)
          : id === "searxng" && c.baseUrl ? true : Boolean(upstream?.configured);
        return [id, { ...CATALOG[id], enabled: c.enabled, configured,
          available: c.enabled && configured,
          source: c.keys.length || c.credentialMode === "local" ? "credentials" : CATALOG[id].keyEnv && upstream?.configured ? "inherited" : "public",
          effectiveBaseUrl: c.baseUrl || "",
          missing_env: configured ? [] : upstream?.missing_env ?? [],
          use_when: upstream?.use_when || CATALOG[id].description }];
      })),
      models: { ...models, overrides: policy.models,
        search_modes: ["both", "web", "x"], default_search_mode: "both" },
      profiles: PROFILES,
      rule: "Only enabled channels can run. Specialist channels require explicit selection. Key values are never exposed.",
    };
  }
  async snapshot() {
    return { policy: this.store.policy(), capabilities: await this.publicCapabilities(),
      health: this.store.health(), history: this.store.history(), active: this.active,
      quotas: this.quotaSnapshot() };
  }
  async search(input, context = {}) {
    if (this.active >= 4) throw fault("已有四个搜索正在执行，请稍后再试", "BUSY", 429);
    this.active++;
    try { return await this.executeSearch(input, context); }
    finally { this.active--; }
  }
  async executeSearch(input, context = {}) {
    const policy = this.store.policy();
    const profile = input.profile || policy.defaultProfile;
    const count = input.count ?? ({ quick: 3, balanced: 6, deep: 10 }[profile]);
    if (typeof input.query !== "string" || !input.query.trim() || input.query.length > 8000 ||
        !PROFILES.includes(profile) || !Number.isInteger(count) || count < 1 || count > 20)
      throw fault("请填写搜索问题，选择档位，来源数量为 1–20");
    if (input.channels !== undefined && (!Array.isArray(input.channels) || !input.channels.length ||
        input.channels.some(id => !CATALOG[id]))) throw fault("搜索渠道无效");
    const model = input.model || policy.models[profile] || "";
    const grokSearchMode = input.grok_search_mode ?? "both";
    if (!["both", "web", "x"].includes(grokSearchMode)) throw fault("Grok 搜索范围须为 both、web 或 x");
    if (typeof model !== "string" || model.length > 100 || model && !/^[\w./:@+-]+$/.test(model))
      throw fault("模型 ID 无效");
    const caps = await this.publicCapabilities();
    const available = id => caps.channels[id]?.available;
    const normal = policy.order.filter(id => WEB.includes(id) && available(id));
    const selected = input.channels ? [...new Set(input.channels)] : (
      profile === "quick" ? (input.model ? ["grok"] : normal.slice(0, 1).length ? normal.slice(0, 1) : available("grok") ? ["grok"] : [])
        : [...(available("grok") ? ["grok"] : []), ...normal.slice(0, profile === "deep" ? 3 : 1)]
    );
    if (!selected.length) throw fault("没有可用渠道，请先启用并配置一个渠道", "NO_CHANNEL");
    if (input.model && !selected.includes("grok")) throw fault("指定模型时需要选择 Grok");
    for (const id of selected) if (!policy.channels[id].enabled) throw fault(`${CATALOG[id].name} 已停用`, "CHANNEL_DISABLED");
    const started = Date.now(), identifier = randomUUID();
    const budget = context.native ? 20 : ({ quick: 15, balanced: 25, deep: 40 }[profile]);
    const cancel = new AbortController();
    const abort = AbortSignal.any([cancel.signal, AbortSignal.timeout(context.native ? 29_000 : 90_000), ...(context.abort ? [context.abort] : [])]);
    const state = {}, answers = [], sources = [], usedModels = [];
    const allocations = Object.fromEntries(selected.map(id => [id, Math.max(1, Math.ceil(count / selected.length))]));
    const args = { query: input.query.trim(), profile, count, model };
    await Promise.all(selected.map(async id => {
      const channelStart = Date.now();
      const config = policy.channels[id];
      const perArgs = { ...args, count: allocations[id], model: id === "grok" ? model : "",
        ...(id === "grok" ? { grok_search_mode: grokSearchMode } : {}) };
      let result, keyLabel = "公开入口", attempts = [];
      if (config.keys.length || id === "searxng" && config.baseUrl) {
        const keys = config.keys.length ? await this.store.reserve(id, config) : [null];
        if (!keys.length) { state[id] = { status: "unavailable", reason: "凭据已停用或正在冷却" }; return; }
        for (const key of keys) {
          keyLabel = key?.label || "实例地址";
          const keyStart = Date.now();
          try {
            result = await this.credentialCall(id, key, { ...perArgs, time_budget_seconds: budget }, config.baseUrl, abort, cancel);
            const channelStatus = result.routing?.channel_results?.[id] || { status: "no_sources" };
            const status = channelStatus.models
              ? channelStatus.models.find(x => [401, 402, 403, 429].includes(x.http_status)) || channelStatus.models[0] || { status: "no_sources" }
              : channelStatus;
            attempts.push({ label: keyLabel, status: status.status || "ok", elapsedMs: Date.now() - keyStart });
            if (key && [401, 402, 403, 429].includes(status.http_status)) {
              const retry = Number(status.retry_after);
              const dateDelay = Date.parse(status.retry_after) - Date.now();
              const wait = status.http_status === 429 ? Math.min(600000, Math.max(30000, Number.isFinite(retry) ? retry * 1000 : Number.isFinite(dateDelay) ? dateDelay : 60000)) : status.http_status === 402 ? 3600_000 : 600_000;
              await this.store.noteKey(key.id, { status: status.http_status, retryAt: Date.now() + wait });
              continue;
            }
            if (key) await this.store.noteKey(key.id, { status: status.status || "ok", retryAt: 0 });
            break;
          } catch (error) {
            attempts.push({ label: keyLabel, status: error.code || "error", elapsedMs: Date.now() - keyStart });
            if (error.code === "UNLOCK_REFUSED") cancel.abort();
            state[id] = { status: "error", code: error.code || "CREDENTIAL_FAILED", reason: error.message, attempts };
            return;
          }
        }
      } else if (config.credentialMode === "local" && CATALOG[id].keyEnv && !["you", "github"].includes(id)) {
        state[id] = { status: "unavailable", reason: "请在本页面添加 API Key" }; return;
      } else if (config.baseUrl && safeEndpoint(config.baseUrl) && config.endpointSource !== "inherited") {
        state[id] = { status: "unavailable", reason: "自定义接口需关联凭据条目" };
        return;
      } else if (!caps.channels[id].configured) {
        state[id] = { status: "unavailable", reason: "尚未配置凭据或实例地址" }; return;
      } else {
        try {
          result = await this.backend.search({ ...perArgs, channels: [id] }, { abort, native: context.native });
        } catch (error) {
          state[id] = { status: "error", reason: "搜索失败或超过时限", code: error.code || "SEARCH_FAILED" }; return;
        }
      }
      if (!result) return;
      const entry = result.routing?.channel_results?.[id] || { status: "no_sources" };
      state[id] = { elapsed_ms: Date.now() - channelStart, ...entry, keyLabel, ...(attempts.length ? { attempts } : {}) };
      sources.push(...(result.sources || []).map(readableSource));
      if (id === "grok" && result.content) answers.push(result.content);
      usedModels.push(...(result.routing?.grok_models || []));
    }));
    sources.sort((a, b) => selected.indexOf(a.provider) - selected.indexOf(b.provider));
    const seen = new Set(), unique = sources.filter(s => {
      if (!s.url || seen.has(s.url)) return false; seen.add(s.url); return true;
    }).slice(0, count);
    const result = {
      session_id: identifier, content: answers.join("\n\n"), sources: unique,
      sources_count: unique.length, results: sourcePages(unique, count),
      routing: { profile, selected_channels: selected, grok_models: [...new Set(usedModels)], channel_results: state,
        ...(selected.includes("grok") ? { grok_search_mode: grokSearchMode } : {}) },
    };
    this.store.append({
      id: identifier, at: new Date().toISOString(), query: args.query,
      origin: context.origin || context.agent || "Agent", elapsedMs: Date.now() - started,
      profile, channels: selected, request: { count, model: selected.includes("grok") ? model : "",
        ...(selected.includes("grok") ? { grok_search_mode: grokSearchMode } : {}) }, sourcesCount: unique.length, routing: result.routing,
      sources: result.results.map(({ title, url }) => ({ title, url })),
    });
    return result;
  }
}
