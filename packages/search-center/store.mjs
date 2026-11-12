import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CATALOG, IDS, PROFILES, fault } from "./catalog.mjs";
import { DATA } from "./runtime.mjs";
export { DATA };

const seeded = new Set(["grok", "tavily", "exa", "firecrawl", "you", "github", "arxiv", "crossref"]);
export function defaults() {
  return {
    version: 1, revision: 0, defaultProfile: "quick", order: [...IDS],
    models: { quick: "", balanced: "", deep: "" },
    channels: Object.fromEntries(IDS.map(id => [id, {
      enabled: seeded.has(id), baseUrl: "", endpointSource: "custom", credentialMode: "local", strategy: "order", keys: [],
    }])),
  };
}
const text = (x, max = 160) => typeof x === "string" && x.length <= max;
export function validatePolicy(v) {
  if (!v || !Number.isInteger(v.revision) || !PROFILES.includes(v.defaultProfile) ||
      !Array.isArray(v.order) || v.order.length !== IDS.length ||
      new Set(v.order).size !== IDS.length || v.order.some(id => !CATALOG[id])) throw fault("设置格式不正确");
  for (const p of PROFILES) {
    if (!text(v.models?.[p], 100) || (v.models[p] && !/^[\w./:@+-]+$/.test(v.models[p]))) throw fault("模型 ID 格式不正确");
  }
  const keys = new Set();
  for (const id of IDS) {
    const c = v.channels?.[id];
    if (!c || typeof c.enabled !== "boolean" || !["order", "rotate"].includes(c.strategy) ||
        !text(c.baseUrl, 500) || !Array.isArray(c.keys) || c.keys.length > 20 ||
        c.endpointSource !== undefined && !["custom", "inherited"].includes(c.endpointSource) ||
        c.credentialMode !== undefined && !["local", "inherited"].includes(c.credentialMode)) throw fault(`${id} 配置无效`);
    if (c.baseUrl) {
      let url;
      try { url = new URL(c.baseUrl); } catch { throw fault("接口地址格式不正确"); }
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
        throw fault("接口地址仅允许无凭据、无查询参数的 HTTP(S) 地址");
      if (!CATALOG[id].urlEnv) throw fault("此渠道使用官方固定接口地址");
    }
    for (const k of c.keys) {
      if (!CATALOG[id].keyEnv || !text(k.id, 50) || !/^[\w-]+$/.test(k.id) || keys.has(k.id) ||
          !text(k.label, 60) || !k.label.trim() || typeof k.enabled !== "boolean" ||
          !text(k.ref, 200) || !/^(?:bw:\/\/[^/\r\n\0]+\/[^/\r\n\0]+|local:\/\/[\w-]{1,50})$/.test(k.ref))
        throw fault("凭据只接受标签和 bw://条目/字段 引用，不接受密钥明文");
      keys.add(k.id);
    }
  }
  return {
    version: 1, revision: v.revision, defaultProfile: v.defaultProfile,
    order: [...v.order], models: Object.fromEntries(PROFILES.map(p => [p, v.models[p]])),
    channels: Object.fromEntries(IDS.map(id => {
      const c = v.channels[id];
      return [id, { enabled: c.enabled, baseUrl: c.baseUrl.trim(), endpointSource: c.endpointSource || "custom", credentialMode: c.credentialMode || "inherited", strategy: c.strategy,
        keys: c.keys.map(k => ({ id: k.id, label: k.label.trim(), ref: k.ref.trim(), enabled: k.enabled })) }];
    })),
  };
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}

export class Store {
  constructor(root = DATA, { lockRetries = 80, lockRetryMs = 25, lockStaleMs = 5000 } = {}) {
    this.root = root;
    this.lockRetries = lockRetries;
    this.lockRetryMs = lockRetryMs;
    this.lockStaleMs = lockStaleMs;
  }
  read(name, fallback) {
    try { return JSON.parse(fs.readFileSync(path.join(this.root, name), "utf8")); }
    catch (e) { if (e.code === "ENOENT") return fallback; throw fault("设置文件损坏，请从备份恢复", "STATE_INVALID", 500); }
  }
  write(name, data) {
    const destination = path.join(this.root, name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const temp = destination + "." + randomUUID() + ".tmp";
    fs.writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(temp, destination);
  }
  policy() { return validatePolicy(this.read("policy.json", defaults())); }
  #isStaleLock(target) {
    let raw, stat;
    try {
      stat = fs.statSync(target);
      raw = fs.readFileSync(target, "utf8");
    } catch (e) {
      return e.code === "ENOENT" ? false : true;
    }
    try {
      const meta = JSON.parse(raw);
      const age = Date.now() - Number(meta?.at);
      if (!Number.isFinite(age) || age > this.lockStaleMs) return true;
      if (!isPidAlive(meta?.pid)) return true;
      return false;
    } catch {
      return Date.now() - stat.mtimeMs > Math.min(this.lockStaleMs, 250);
    }
  }
  async lock(fn) {
    fs.mkdirSync(this.root, { recursive: true });
    const target = path.join(this.root, ".write-lock");
    const owner = randomUUID();
    let acquired = false;
    for (let i = 0; i < this.lockRetries; i++) {
      try {
        const fd = fs.openSync(target, "wx", 0o600);
        try {
          fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now(), owner }), "utf8");
        } finally {
          fs.closeSync(fd);
        }
        acquired = true;
        break;
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
        if (this.#isStaleLock(target)) {
          try { fs.unlinkSync(target); } catch {}
          continue;
        }
        await new Promise(r => setTimeout(r, this.lockRetryMs));
      }
    }
    if (!acquired) throw fault("设置正被另一请求更新，请稍后重试", "BUSY", 409);
    try {
      return fn();
    } finally {
      try {
        const current = JSON.parse(fs.readFileSync(target, "utf8"));
        if (current?.owner === owner) fs.unlinkSync(target);
      } catch {}
    }
  }
  async save(value) {
    const clean = validatePolicy(value);
    return this.lock(() => {
      const old = this.policy();
      if (old.revision !== clean.revision) throw fault("设置已被另一窗口修改，请刷新后重试", "CONFLICT", 409);
      this.write("policy.previous.json", old);
      clean.revision++;
      this.write("policy.json", clean);
      return clean;
    });
  }
  health() { return this.read("health.json", {}); }
  async reserve(id, configuration) {
    return this.lock(() => {
      const health = this.health(), now = Date.now();
      const active = configuration.keys.filter(k => k.enabled &&
        (health[k.id]?.retryAt ?? 0) <= now);
      if (!active.length) return [];
      const cursor = health["cursor:" + id] ?? 0;
      const start = configuration.strategy === "rotate" ? cursor % active.length : 0;
      health["cursor:" + id] = cursor + 1;
      this.write("health.json", health);
      return active.slice(start).concat(active.slice(0, start));
    });
  }
  async noteKey(key, state) {
    return this.lock(() => {
      const health = this.health();
      health[key] = { ...state, at: Date.now() };
      this.write("health.json", health);
    });
  }
  append(entry) {
    const name = Date.now() + "-" + randomUUID() + ".json";
    this.write("history/" + name, entry);
    const files = fs.readdirSync(path.join(this.root, "history")).filter(f => /^\d+-[\w-]+\.json$/.test(f)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - 100))) fs.unlinkSync(path.join(this.root, "history", f));
  }
  history() {
    const dir = path.join(this.root, "history");
    let entries;
    try { entries = fs.readdirSync(dir); }
    catch (e) { if (e.code === "ENOENT") return []; throw e; }
    return entries.filter(f => /^\d+-[\w-]+\.json$/.test(f))
      .sort().reverse().slice(0, 100).map(f => {
        try {
          const parsed = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
          return parsed && typeof parsed === "object" ? parsed : null;
        } catch {
          return null;
        }
      }).filter(Boolean);
  }
}
