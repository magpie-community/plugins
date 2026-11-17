import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export function resolveConfigDir(given) {
  if (process.env.MAGPIE_CONFIG_DIR) return process.env.MAGPIE_CONFIG_DIR;
  if (given && existsSync(join(given, "plugins.json"))) return given;
  if (existsSync(join(process.cwd(), "plugins.json"))) return process.cwd();
  const xdg = process.env.XDG_CONFIG_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".config"), "magpie");
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw new Error(`无法读取 ${file.split("/").at(-1)}：${error.message}`);
  }
}

function number(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function timestamp(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = number(value);
  const parsed = numeric === null ? Date.parse(value) : numeric < 1e12 ? numeric * 1000 : numeric;
  return Number.isFinite(parsed) && Math.abs(parsed) <= 8.64e15 ? parsed : null;
}

export function windowKind(window) {
  const name = String(window.name ?? "").toLowerCase();
  const span = number(window.span);
  if (span === 18000 || span === 18000e9 || /(?:^|[^0-9])5[\s_-]*(?:h|hour|小时)/.test(name)) return "fiveHour";
  if (span === 604800 || span === 604800e9 || /week|weekly|每周|周限|(?:^|[^0-9])7[\s_-]*(?:d|day|天)/.test(name)) return "weekly";
  return null;
}

function normalizeWindow(window, readAt) {
  let remaining = number(window.remaining);
  const used = number(window.used);
  const amount = number(window.amount);
  const limit = number(window.limit);
  const balance = number(window.balance);
  if (remaining === null && used !== null) remaining = 100 - used;
  if (remaining === null && amount !== null && limit !== null && limit > 0) {
    remaining = 100 * (1 - amount / limit);
  }
  if (remaining === null && balance !== null && limit !== null && limit > 0) remaining = balance / limit * 100;
  const unlimited = window.unlimited === true;
  const text = window.text === true;
  if (unlimited || text || (balance !== null && !(limit > 0))) remaining = null;
  const resetSecs = number(window.resetSecs);
  const resetsAt = timestamp(window.resetsAt)
    ?? (resetSecs !== null && readAt !== null ? readAt + resetSecs * 1000 : null);
  return {
    name: String(window.name ?? ""),
    kind: windowKind(window),
    remaining: remaining === null ? null : Math.min(100, Math.max(0, remaining)),
    resetsAt,
    display: typeof window.display === "string" ? window.display : "",
    amount,
    limit,
    balance,
    unit: String(window.unit ?? ""),
    unlimited,
    text,
  };
}

function balanceDisplay(value, unit) {
  const formatted = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 4 }).format(value);
  if (unit === "USD" || unit === "$") return `$${formatted}`;
  if (unit === "CNY" || unit === "¥") return `¥${formatted}`;
  return unit ? `${formatted} ${unit}` : formatted;
}

function balancesFor(record, windows) {
  if ((typeof record.balance === "string" && record.balance.trim())
    || (typeof record.balance === "number" && Number.isFinite(record.balance))) {
    return [{ name: "余额", display: String(record.balance), remaining: null }];
  }
  const balances = [];
  for (const window of windows) {
    if (!window || typeof window !== "object") continue;
    let balance = number(window.balance);
    const limit = number(window.limit);
    const amount = number(window.amount);
    const unit = String(window.unit ?? "");
    if (balance === null && limit !== null && amount !== null && /credits?|tokens?|积分|额度|余额|usd|cny|[$¥]/i.test(unit)) {
      balance = Math.max(0, limit - amount);
    }
    if (balance === null) continue;
    balances.push({
      name: String(window.name || "余额"),
      display: balanceDisplay(balance, unit),
      remaining: limit !== null && limit > 0 ? Math.min(100, Math.max(0, balance / limit * 100)) : null,
    });
  }
  return balances;
}

const subscriptionProviders = new Set([
  "codex", "chatgpt", "openai-codex", "claude", "copilot", "github-copilot",
  "kiro", "gemini-cli", "antigravity",
]);

function recordKind(record, provider, windows) {
  const kind = String(record.kind ?? "").toLowerCase();
  if (["subscription", "plan", "balance"].includes(kind)) return kind;
  if (subscriptionProviders.has(provider)) return "subscription";
  if (["openai", "gemini"].includes(provider)
    && windows.some((window) => windowKind(window) || window.unlimited || number(window.used) !== null || number(window.remaining) !== null)) {
    return "subscription";
  }
  if (balancesFor(record, windows).length) return "balance";
  return "unknown";
}

export function buildReport(records, { source, warning = "", now = Date.now() } = {}) {
  const accounts = new Map();
  const apiAccounts = new Map();
  const otherAccounts = new Map();
  for (const record of records) {
    if (!record || typeof record !== "object") continue;
    const provider = String(record.provider ?? "").toLowerCase().replace(/^plugin:/, "");
    const windows = Array.isArray(record.windows)
      ? record.windows.filter((window) => window && typeof window === "object") : [];
    if (!provider && !record.user && !record.name) continue;
    const kind = recordKind(record, provider, windows);
    const user = String(record.user || record.account || record.accountId || "");
    const from = String(record.from ?? "");
    const id = JSON.stringify([from, provider, kind, user || record.name || record.alias || ""]);
    const readAt = timestamp(record.readAt ?? record.asOf ?? record.at);
    const name = String(record.alias || user || record.name || provider || "未命名账号");
    const next = {
      id,
      name,
      user: user || "未命名账号",
      provider,
      kind,
      from,
      plan: String(record.plan ?? ""),
      until: timestamp(record.until),
      error: String(record.error ?? ""),
      readAt,
      windows: windows.map((window) => normalizeWindow(window, readAt)),
      balances: kind === "balance" ? balancesFor(record, windows) : [],
      balance: typeof record.balance === "string" || typeof record.balance === "number" ? String(record.balance) : "",
      fiveHour: [],
      weekly: [],
    };
    for (const window of next.windows) {
      if (window.kind) next[window.kind].push(window);
    }
    const group = kind === "balance" ? apiAccounts : kind === "unknown" ? otherAccounts : accounts;
    const previous = group.get(id);
    if (!previous || (next.readAt ?? 0) >= (previous.readAt ?? 0)) group.set(id, next);
  }
  return {
    generatedAt: now,
    source: source ?? "snapshot",
    warning,
    accounts: [...accounts.values()].sort((first, second) => first.user.localeCompare(second.user)),
    apiAccounts: [...apiAccounts.values()].sort((first, second) => first.name.localeCompare(second.name)),
    otherAccounts: [...otherAccounts.values()].sort((first, second) => first.name.localeCompare(second.name)),
  };
}

export function createReader({ configDir, fetchImpl = fetch } = {}) {
  const directory = resolveConfigDir(configDir);
  let cached;
  let pending;

  async function load() {
    let warning = "";
    try {
      const gateway = await readJson(join(directory, "gateway.json"), {});
      const address = process.env.MAGPIE_ADDR || gateway.addr || "127.0.0.1:3425";
      const base = new URL(/^https?:\/\//i.test(address) ? address : `http://${address}`);
      if (base.hostname === "0.0.0.0") base.hostname = "127.0.0.1";
      if (base.hostname === "[::]") base.hostname = "[::1]";
      if (!["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)) {
        throw new Error("只读取本机 Magpie 网关");
      }
      const response = await fetchImpl(new URL("/v1/magpie/quotas?kept=1", base), {
        signal: AbortSignal.timeout(5000),
        redirect: "error",
      });
      if (!response.ok) throw new Error(`网关返回 HTTP ${response.status}`);
      const body = await response.json();
      if (!Array.isArray(body.data)) throw new Error("网关额度格式不受支持");
      return buildReport(body.data, { source: "gateway" });
    } catch (error) {
      warning = `网关当前不可用，显示 Magpie 保存的额度快照。${error.message}`;
    }
    const snapshot = await readJson(join(directory, "quotas.json"), {});
    const records = Object.entries(snapshot).flatMap(([key, entry]) =>
      entry?.quota ? [{
        ...entry.quota,
        kind: entry.quota.kind || (/\/plan /.test(key) ? "plan" : /\/balance /.test(key) ? "balance"
          : key.startsWith(`${entry.quota.provider}/`) ? "subscription" : undefined),
        at: entry.at,
        windows: Array.isArray(entry.quota.windows) ? entry.quota.windows.map((window, index) =>
          window && typeof window === "object" ? { ...window, span: window.span ?? entry.spans?.[index]?.span } : window) : [],
      }] : [],
    );
    return buildReport(records, { source: "snapshot", warning });
  }

  return async ({ force = false } = {}) => {
    if (!force && cached && Date.now() - cached.generatedAt < 30000) return cached;
    if (!pending) {
      pending = load().then((report) => {
        cached = report;
        return report;
      }).finally(() => {
        pending = undefined;
      });
    }
    return pending;
  };
}
