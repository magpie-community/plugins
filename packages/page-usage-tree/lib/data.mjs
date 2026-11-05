import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { accountKey, aggregateGatewayUsage, PERIODS } from "./usage.mjs";
import {
  gatewayAccountRequests,
  gatewayUsage,
} from "./gateway.mjs";

export function cacheDir() {
  if (process.env.MAGPIE_CACHE_DIR) return process.env.MAGPIE_CACHE_DIR;
  if (isAbsolute(process.env.XDG_CACHE_HOME || "")) {
    return join(process.env.XDG_CACHE_HOME, "magpie");
  }
  return join(homedir(), ".cache", "magpie");
}

// The page takes only what the gateway can tell it. Currency and number
// units are presentation choices passed by the launcher from this page's
// options; the gateway's costs are USD, which is magpie's default.
export function displaySettings(overrides = {}) {
  return {
    currency: overrides.currency === "cny" ? "cny" : "usd",
    chineseUnits: overrides.chineseUnits === true,
    lang: typeof overrides.lang === "string" && overrides.lang ? overrides.lang : "en",
    usdCny: Number.isFinite(Number(overrides.usdCny)) && Number(overrides.usdCny) > 0
      ? Number(overrides.usdCny)
      : 0,
    theme: overrides.theme === "dark" || overrides.theme === "light" ? overrides.theme : "",
  };
}

// Cost comes from the gateway in USD. The page only converts it for display,
// using the options Magpie's page bridge hands to the launcher. No settings
// or exchange-rate file is read here.

function normalizePeriod(period) {
  return PERIODS.has(period) ? period : "today";
}

function cacheFile(period) {
  return join(cacheDir(), "usage-tree", `${period}.json`);
}

// A read written by an older build can lack a field this page needs, so it
// is a miss rather than served as current.
const CACHE_VERSION = 6;

export function cacheUsable(data) {
  return Boolean(data && Array.isArray(data.providers) && Array.isArray(data.accounts));
}

function readCached(period) {
  try {
    const raw = JSON.parse(readFileSync(cacheFile(period), "utf8"));
    if (!raw?.data || raw.v !== CACHE_VERSION || !cacheUsable(raw.data)) return null;
    return { data: raw.data, at: Number(raw.at) || 0 };
  } catch {
    return null;
  }
}

function writeCached(period, data) {
  let temporary = "";
  try {
    const file = cacheFile(period);
    const directory = dirname(file);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      chmodSync(directory, 0o700);
    } catch {
      // Windows ignores POSIX modes; the write itself is still useful.
    }
    const { stale, cached, ...keep } = data;
    temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(
      temporary,
      JSON.stringify({ v: CACHE_VERSION, at: Date.now(), data: keep }),
      { encoding: "utf8", mode: 0o600 },
    );
    renameSync(temporary, file);
  } catch {
    // A cache that cannot be written only costs the next read its wait.
  } finally {
    if (temporary) try { unlinkSync(temporary); } catch {}
  }
}

// magpie's requests API can narrow by provider as well as account. A
// subscription id is unique in practice, but passing both keeps an API-key
// group from borrowing another provider's models.
async function requestsForAccounts(usage, period, options) {
  const out = {};
  const accounts = Array.isArray(usage?.accounts) ? usage.accounts : [];
  await Promise.all(
    accounts.map(async (item) => {
      const account = String(item?.account || "");
      if (!account) return;
      const provider = String(item?.provider || "");
      const key = accountKey(provider, account);
      try {
        out[key] = await gatewayAccountRequests(period, account, provider, options);
      } catch {
        // The account totals still come from the usage answer; only its
        // model rows are missing.
        out[key] = null;
      }
    }),
  );
  return out;
}

async function readGateway(period, options) {
  const usage = await gatewayUsage(period, options);
  // The usage answer carries the model table already. Only accounts whose
  // models it cannot place need their own requests read; on a large ledger
  // that is usually none of them.
  const preview = aggregateGatewayUsage(usage, {}, { period });
  const missing = preview.accounts.filter((account) => account.calls > 0 && !account.models.length);
  const requestsByAccount = missing.length
    ? await requestsForAccounts(
      { ...usage, accounts: usage.accounts.filter((item) =>
        missing.some((account) => account.provider === item.provider && account.account === item.account)) },
      period,
      options,
    )
    : {};
  return aggregateGatewayUsage(usage, requestsByAccount, { period });
}

const refreshing = new Set();

export async function loadUsageData(period, options = {}) {
  const wanted = normalizePeriod(period);

  if (!options.fresh) {
    const hit = readCached(wanted);
    if (hit) {
      const stale = Date.now() - hit.at >= 25_000;
      if (stale) void refreshBehind(wanted, options);
      return { ...hit.data, cached: true, stale };
    }
  }

  return refresh(wanted, options);
}

function refreshBehind(period, options) {
  if (refreshing.has(period)) return;
  refreshing.add(period);
  refresh(period, { ...options, fresh: true })
    .catch(() => {})
    .finally(() => refreshing.delete(period));
}

async function refresh(period, options = {}) {
  const result = await readGateway(period, options);
  result.source = "Magpie gateway usage";
  writeCached(period, result);
  return result;
}

export { PERIODS };
