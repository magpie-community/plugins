import { ApiError, Hindsight } from "./hindsight.mjs";
import { hash } from "./turns.mjs";

const pageSize = 100;

export async function listBanks(config, { query = "", fetcher = fetch, maxPages = 3 } = {}) {
  const client = new Hindsight(config, fetcher);
  const banks = new Map();
  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({ limit: pageSize, offset: page * pageSize });
    if (query) params.set("q", query);
    const data = await client.request("/v1/default/banks?" + params, undefined, { timeoutMs: 1500 });
    if (!Array.isArray(data?.banks)) throw new ApiError("invalid");
    for (const entry of data.banks) {
      const id = entry?.bank_id;
      if (typeof id !== "string" || !id || id.length > 128) continue;
      const name = typeof entry.name === "string" ? entry.name.slice(0, 128) : "";
      banks.set(id, { id, name });
    }
    if (data.banks.length < pageSize || (page + 1) * pageSize >= Number(data.total))
      return { banks: [...banks.values()], partial: false };
  }
  return { banks: [...banks.values()], partial: true };
}

export function bankVerifier({ fetcher = fetch, clock = Date.now } = {}) {
  const checks = new Map();
  return config => {
    const key = hash([config.hindsight_api, config.bank]);
    const current = checks.get(key);
    if (current && current.until > clock()) return current.promise;
    const entry = { until: clock() + 10000 };
    entry.promise = listBanks(config, { query: config.bank, fetcher }).then(result => {
      const found = result.banks.some(bank => bank.id === config.bank);
      entry.until = clock() + (found ? 120000 : 10000);
      return found;
    }, () => false);
    checks.delete(key);
    checks.set(key, entry);
    if (checks.size > 128) checks.delete(checks.keys().next().value);
    return entry.promise;
  };
}
