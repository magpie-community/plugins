import { configuration } from "../lib/config.mjs";
import { ApiError, Hindsight } from "../lib/hindsight.mjs";

const HEALTHY = new Set(["healthy", "ok", "ready", "up"]);
const numeric = value => Number.isFinite(value) && value >= 0 ? value : null;

export async function testConnection(options = {}, fetcher = fetch) {
  const start = Date.now();
  let config;
  try { config = configuration(options); }
  catch (error) { return { api: "invalid-options", bankStatus: "unverified", field: error.message.split(": ").at(-1), checkedAt: start }; }

  const client = new Hindsight(config, fetcher);
  const result = { api: "unavailable", database: "unverified", bank: config.bank, bankStatus: "unverified", checkedAt: start };
  const errorCode = error => error instanceof ApiError ? error.code : "unavailable";
  const elapsed = () => Date.now() - start;
  try {
    const health = await client.request("/health", undefined, { timeoutMs: 2500 });
    if (!HEALTHY.has(health?.status)) return { ...result, api: "invalid", ms: elapsed() };
    result.api = "connected";
    result.database = health.database === undefined ? "unverified" : health.database === "connected" ? "connected" : "unavailable";
  } catch (error) {
    return { ...result, api: errorCode(error), ms: elapsed() };
  }
  if (result.database === "unavailable") return { ...result, ms: elapsed() };

  try {
    const data = await client.request("/v1/default/banks?q=" + encodeURIComponent(config.bank) + "&limit=100", undefined, { timeoutMs: 2500 });
    if (!Array.isArray(data?.banks)) throw new ApiError("invalid");
    if (!data.banks.some(bank => bank?.bank_id === config.bank)) {
      return { ...result, bankStatus: Number(data.total) > data.banks.length ? "unverified" : "not-listed", ms: elapsed() };
    }
    result.bankStatus = "listed";
    const stats = await client.request(client.bankPath("/stats"), undefined, { timeoutMs: 2500 });
    if (stats?.bank_id !== config.bank || !Number.isFinite(stats.total_documents)) throw new ApiError("invalid");
    result.bankStatus = "accessible";
    result.stats = { documents: numeric(stats.total_documents), memories: numeric(stats.total_nodes),
      pending: numeric(stats.pending_operations), failed: numeric(stats.failed_operations) };
  } catch (error) {
    result.bankStatus = errorCode(error);
  }
  return { ...result, ms: elapsed() };
}
