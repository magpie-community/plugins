import { execFile } from "node:child_process";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { aggregateLedgerRows, aggregateUsageCSV, PERIODS } from "./usage.mjs";

const execFileAsync = promisify(execFile);

export function configDir() {
  if (process.env.MAGPIE_CONFIG_DIR) return process.env.MAGPIE_CONFIG_DIR;
  if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, "magpie");
  return join(homedir(), ".config", "magpie");
}

export function cacheDir() {
  if (process.env.MAGPIE_CACHE_DIR) return process.env.MAGPIE_CACHE_DIR;
  if (process.env.XDG_CACHE_HOME) return join(process.env.XDG_CACHE_HOME, "magpie");
  return join(homedir(), ".cache", "magpie");
}

// fxRate is the CNY-per-USD rate Magpie itself uses for its CNY currency
// preference (internal/fx). Reading Magpie's own cache keeps the numbers on
// this page the same as the ones on Magpie's Usage page.
export function fxRate(fallback = 7.2) {
  const file = join(cacheDir(), "fxrate.json");
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    const rate = Number(raw?.rate);
    if (Number.isFinite(rate) && rate > 0) return rate;
  } catch {
    // No cache yet: use the fallback.
  }
  return fallback;
}

export function currencySetting() {
  const file = join(configDir(), "settings.json");
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    return raw?.currency === "usd" ? "usd" : "cny";
  } catch {
    return "cny";
  }
}

// accountNames are the names the user gave their accounts, kept in
// providers.json (magpie's internal/provider/account_names.go). The tables
// of magpie show these beside the account.
export function accountNames() {
  const file = join(configDir(), "providers.json");
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    const out = {};
    for (const provider of raw?.providers || []) {
      const names = provider.accountNames;
      if (!names || typeof names !== "object") continue;
      const forProvider = {};
      for (const [account, name] of Object.entries(names)) {
        if (typeof name === "string" && name.trim()) {
          forProvider[String(account).toLowerCase()] = name.trim();
        }
      }
      if (Object.keys(forProvider).length) out[provider.id] = forProvider;
    }
    return out;
  } catch {
    return {};
  }
}

function executableNames() {
  if (process.platform !== "win32") return ["magpie"];
  const exts = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean)
    .map((ext) => ext.toLowerCase());
  return ["magpie", ...exts.map((ext) => `magpie${ext}`)];
}

export function findMagpieBinary() {
  for (const key of ["MAGPIE_BIN", "MAGPIE_BINARY", "MAGPIE_EXE"]) {
    const value = process.env[key];
    if (value && existsSync(value)) return value;
  }

  const directories = String(process.env.PATH || "")
    .split(delimiter)
    .filter(Boolean);
  for (const directory of directories) {
    for (const name of executableNames()) {
      const candidate = join(directory, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return "";
}

function normalizePeriod(period) {
  return PERIODS.has(period) ? period : "7d";
}

// A read of the whole log costs a second or three, so what it came to is
// kept until the log changes. The log's size and mtime are the key: a new
// call changes both, and the next read recomputes.
function usageSourceKey() {
  try {
    const st = statSync(join(configDir(), "usage.jsonl"));
    return `${st.size}:${Math.round(st.mtimeMs)}`;
  } catch {
    return "";
  }
}

function cacheFile(period) {
  return join(cacheDir(), "usage-tree", `${period}.json`);
}

// What a cache file's numbers are shaped like. A read written by an older
// build is not the same answer: it may lack a field this page needs, so it
// is read as a miss rather than served as if it were current.
const CACHE_VERSION = 2;

export function cacheUsable(data) {
  return Boolean(data && Array.isArray(data.providers) && Array.isArray(data.accounts));
}

function readCached(period, { any = false } = {}) {
  try {
    const raw = JSON.parse(readFileSync(cacheFile(period), "utf8"));
    if (!raw?.data || raw.v !== CACHE_VERSION || !cacheUsable(raw.data)) return null;
    if (!any && raw.key !== usageSourceKey()) return null;
    return { data: raw.data, at: raw.at || 0, key: raw.key };
  } catch {
    return null;
  }
}

function writeCached(period, data) {
  try {
    const file = cacheFile(period);
    mkdirSync(dirname(file), { recursive: true });
    // The stale mark is about this read, not about the numbers: it is not
    // kept, or every later read would say it is old.
    const { stale, cached, ...keep } = data;
    writeFileSync(
      file,
      JSON.stringify({ v: CACHE_VERSION, key: usageSourceKey(), at: Date.now(), data: keep }),
      "utf8",
    );
  } catch {
    // A cache that can't be written only costs the next read its wait.
  }
}

async function readCSVWithCLI(period, binary) {
  const { stdout } = await execFileAsync(binary, ["usage", "--csv", period], {
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    timeout: 90_000,
    windowsHide: true,
  });
  return stdout;
}

async function readLedgerFallback(period) {
  const file = join(configDir(), "usage.jsonl");
  if (!existsSync(file)) throw new Error(`找不到用量记录：${file}`);

  const rows = [];
  const input = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // A truncated final line is normal while Magpie is appending.
    }
  }
  return aggregateLedgerRows(rows, { period, accountNames: accountNames() });
}

export async function loadUsageData(period, options = {}) {
  const wanted = normalizePeriod(period);
  const binary = findMagpieBinary();

  if (!options.fresh) {
    const fresh = readCached(wanted);
    if (fresh) return { ...fresh.data, cached: true, stale: false };

    // The log changes with every call, so a strict key would miss nearly
    // every time. Show what the last read came to at once and read again
    // behind the page.
    const stale = readCached(wanted, { any: true });
    if (stale) {
      void refreshBehind(wanted, binary);
      return { ...stale.data, stale: true };
    }
  }

  return refresh(wanted, binary, options);
}

const refreshing = new Set();

function refreshBehind(period, binary) {
  if (refreshing.has(period)) return;
  refreshing.add(period);
  refresh(period, binary, { fresh: true })
    .catch(() => {})
    .finally(() => refreshing.delete(period));
}

async function refresh(wanted, binary, options = {}) {
  if (binary) {
    try {
      const csv = await readCSVWithCLI(wanted, binary);
      const result = aggregateUsageCSV(csv, { period: wanted, accountNames: accountNames() });
      result.source = "magpie usage --csv";
      result.command = `${binary} usage --csv ${wanted}`;
      writeCached(wanted, result);
      return result;
    } catch (error) {
      const fallback = await readLedgerFallback(wanted);
      fallback.source = "usage.jsonl fallback";
      fallback.command = `${binary} usage --csv ${wanted}`;
      fallback.warnings.push(`命令读取失败，已回退到只读日志：${error.message}`);
      fallback.warnings.push("回退模式下费用字段可能不可用。");
      writeCached(wanted, fallback);
      return fallback;
    }
  }

  const fallback = await readLedgerFallback(wanted);
  fallback.source = "usage.jsonl fallback";
  fallback.command = "magpie usage --csv";
  fallback.warnings.push("未在 PATH 中找到 magpie 命令，已回退到只读日志。");
  fallback.warnings.push("回退模式下费用字段可能不可用。");
  writeCached(wanted, fallback);
  return fallback;
}
