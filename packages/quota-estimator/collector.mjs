import { readFile, writeFile, rename, mkdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { fileURLToPath } from "node:url";
import { WINDOWS, estimateAccount, pricesFrom, timestamp } from "./estimate.mjs";
import { readClaudeNative, mergeClaudeRows } from "./claude-native.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const configRoot = process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config");
const cacheRoot = process.env.XDG_CACHE_HOME || path.join(homedir(), ".cache");
export const DEFAULTS = { configDir: path.join(configRoot, "magpie"),
  claudeDir: process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude"),
  catalogFile: path.join(cacheRoot, "magpie/models.json"), output: path.join(ROOT, "page/snapshot.js") };

async function jsonFile(file) { return JSON.parse(await readFile(file, "utf8")); }

// Only the three documented read endpoints; never follow a redirect carrying a gateway key.
export function getJSON(base, endpoint, key = "") {
  if (!/^\/v1\/magpie\/(quotas\/(cards|history)|usage\/requests)(\?|$)/.test(endpoint)) {
    throw new Error("不允许的采集接口");
  }
  const url = new URL(endpoint, base);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("网关地址无效");
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? https : http).get(url, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
    }, response => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`只读接口返回 HTTP ${response.statusCode}`));
        return;
      }
      let size = 0;
      const chunks = [];
      response.on("data", chunk => {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) { request.destroy(new Error("接口响应超过 4 MiB")); return; }
        chunks.push(chunk);
      });
      response.on("error", () => reject(new Error("读取网关响应失败")));
      response.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch { reject(new Error("网关返回了无效 JSON")); }
      });
    });
    request.setTimeout(10000, () => request.destroy(new Error("网关读取超时")));
    request.on("error", error => reject(new Error(error.message === "网关读取超时" ? error.message : "无法读取网关；请检查现有连接")));
  });
}

function remoteBase(provider) {
  const base = provider.responses || provider.chat || provider.anthropic;
  const url = new URL(base);
  if (url.pathname.replace(/\/$/, "") !== "" && url.pathname.replace(/\/$/, "") !== "/v1") {
    throw new Error("远端使用非标准路径，不能确定只读接口地址");
  }
  return url.origin;
}

export async function remoteRows(base, key, quota, read = getJSON) {
  let rows = [], total = Infinity;
  const query = new URLSearchParams({ period: "all", provider: quota.provider, account: quota.user, limit: "500" });
  for (let page = 0; page < 200 && rows.length < total; page++) {
    query.set("offset", String(page * 500));
    const data = await read(base, `/v1/magpie/usage/requests?${query}`, key);
    if (!Array.isArray(data.rows) || !Number.isSafeInteger(data.total) || data.total < 0) throw new Error("远端请求明细格式无效");
    if (data.rows.some(row => row.provider !== quota.provider
      || String(row.providerAccount || "").toLowerCase() !== quota.user.toLowerCase())) {
      throw new Error("远端未提供可靠的账号归属，停止推算");
    }
    total = data.total;
    rows.push(...data.rows);
    if (!data.rows.length) {
      if (rows.length < total) throw new Error("远端分页不完整");
      break;
    }
  }
  return { rows, partial: rows.length < total };
}

function unavailable(title, reason) {
  return WINDOWS.map(kind => ({ title, window: kind.name, state: "unavailable", reason,
    readAt: null, used: null, tokens: null, cost: null, calls: 0, observedTokens: 0, observedCost: 0, unpriced: 0 }));
}

export async function collect(options = {}) {
  const { configDir, catalogFile, claudeDir } = { ...DEFAULTS, ...options };
  const now = options.now ?? Date.now();
  const read = options.getJSON || getJSON;
  const cards = [], errors = [];
  let localStage = "读取缓存";
  let prices;
  try { prices = pricesFrom(await jsonFile(catalogFile)); }
  catch { prices = new Map(); errors.push("无法读取 Magpie 价格缓存：仍显示 Token，美元暂缺"); }
  try {
    const [saved, text, histories] = await Promise.all([
      jsonFile(path.join(configDir, "quotas.json")), readFile(path.join(configDir, "usage.jsonl"), "utf8"),
      jsonFile(path.join(configDir, "quota-history.json")),
    ]);
    localStage = "解析请求日志";
    const rows = [];
    let malformed = false;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error();
        rows.push(row);
      } catch { malformed = true; }
    }
    const native = await readClaudeNative({ claudeDir, since: now - 8 * 86400000, until: now });
    localStage = "计算账号窗口";
    for (const provider of ["codex", "claude"]) {
      const name = provider === "codex" ? "Codex" : "Claude";
      const quotas = Object.entries(saved).filter(([, entry]) => entry?.quota?.provider === provider);
      quotas.forEach(([key, { quota }], i) => {
        const title = `本机 ${name} · 账号 ${i + 1}`;
        // Magpie may omit quota.user when persisting an account-keyed cache entry.
        const account = key.startsWith(`${provider}/`) ? key.slice(provider.length + 1) : null;
        const user = quota.user ?? account;
        if (typeof user !== "string" || !user) {
          cards.push(...unavailable(title, "账号身份尚未读到，无法匹配调用记录"));
          return;
        }
        if (account && account.toLowerCase() !== user.toLowerCase()) {
          cards.push(...unavailable(title, "缓存账号身份不一致，无法匹配调用记录"));
          return;
        }
        try {
          const localNative = provider === "claude" && native.user === user.toLowerCase();
          const accountRows = localNative ? mergeClaudeRows(rows, native.rows) : rows;
          const firstRecordAt = accountRows.reduce((first, row) => Math.min(first, timestamp(row.t) || Infinity), Infinity);
          const estimates = estimateAccount({ quota: { ...quota, user }, rows: accountRows, prices, now, title, firstRecordAt,
            partial: malformed || provider === "claude" && native.partial,
            history: Object.entries(histories[`${quota.provider}|${user.toLowerCase()}`] || {})
              .map(([name, points]) => ({ name, points })),
          });
          if (provider === "claude") {
            for (const card of estimates) card.nativeNote = native.user && !localNative ? "原生账号与此 Magpie 账号不同，未合并" : native.note;
          }
          cards.push(...estimates);
        } catch (error) {
          cards.push(...unavailable(title, `该账号的窗口数据无效（${error.name}），等待正常更新`));
        }
      });
      if (!quotas.length) cards.push(...unavailable(`本机 ${name}`, "Magpie 尚无该账号的缓存额度"));
    }
  } catch (error) {
    for (const name of ["Codex", "Claude"]) {
      cards.push(...unavailable(`本机 ${name}`, `本机数据不可用（${localStage}：${error.code || error.name}）；未触发登录或刷新`));
    }
  }
  let providers;
  try {
    providers = (await jsonFile(path.join(configDir, "providers.json"))).providers;
    if (!Array.isArray(providers)) throw new Error();
  }
  catch { errors.push("无法读取 Remote magpie 连接配置"); providers = []; }
  for (const [i, provider] of providers.filter(p => p.preset === "remote-magpie" && !p.off).entries()) {
    const label = `Remote magpie ${i + 1}`;
    try {
      const base = remoteBase(provider);
      const data = await read(base, "/v1/magpie/quotas/cards", provider.key);
      if (!Array.isArray(data.data)) throw new Error("远端额度格式无效");
      const quotas = data.data.filter(q => q.user && ["codex", "claude"].includes(q.provider));
      if (!quotas.length) cards.push(...unavailable(label, "远端未提供可读取的 Codex / Claude 账号额度"));
      let history = [];
      try {
        const data = await read(base, "/v1/magpie/quotas/history?days=8", provider.key);
        if (!Array.isArray(data.data)) throw new Error();
        history = data.data;
      } catch { throw new Error("远端额度历史不可读，无法排除周期内重置或额外付费"); }
      for (const [j, quota] of quotas.entries()) {
        const title = `${label} · ${quota.provider === "codex" ? "Codex" : "Claude"} · 账号 ${j + 1}`;
        try {
          const { rows, partial } = await remoteRows(base, provider.key, quota, read);
          const firstRecordAt = rows.reduce((first, row) => Math.min(first, timestamp(row.t) || Infinity), Infinity);
          const lines = history.find(h => h.provider === quota.provider && h.user?.toLowerCase() === quota.user.toLowerCase())?.lines || [];
          cards.push(...estimateAccount({ quota, rows, prices, now, title, history: lines, firstRecordAt, partial }));
        } catch (error) { cards.push(...unavailable(title, error.message)); }
      }
    } catch (error) { cards.push(...unavailable(label, error.message)); }
  }
  if (!providers.some(p => p.preset === "remote-magpie" && !p.off)) {
    cards.push(...unavailable("Remote magpie", "没有已启用的 Remote magpie 连接"));
  }
  return { version: 1, generatedAt: now, cards, errors };
}

export async function publish(options = {}) {
  const settings = { ...DEFAULTS, ...options };
  const snapshot = await collect(settings);
  const temporary = `${settings.output}.${process.pid}.tmp`;
  await mkdir(path.dirname(settings.output), { recursive: true });
  try {
    await writeFile(temporary, `window.acceptQuotaSnapshot(${JSON.stringify(snapshot)});\n`, { mode: 0o600 });
    await rename(temporary, settings.output);
  } finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
  return snapshot;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  publish().then(snapshot => console.log(JSON.stringify({ cards: snapshot.cards.length,
    estimated: snapshot.cards.filter(c => c.state === "estimated").length, errors: snapshot.errors })))
    .catch(() => { console.error("采集失败，未修改路由或登录配置"); process.exitCode = 1; });
}
