import { configuration } from "../lib/config.mjs";

const HEALTHY = new Set(["healthy", "ok", "ready", "up"]);
const MAX_HEALTH_BYTES = 65536;

async function readHealth(response) {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_HEALTH_BYTES) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    const data = JSON.parse(text);
    if (!data || typeof data !== "object" || typeof data.status !== "string") return "invalid";
    if (!HEALTHY.has(data.status)) return "invalid";
    return data.database === undefined || data.database === "connected" ? "connected" : "unavailable";
  } catch {
    try { await reader.cancel(); } catch { /* The response is already closed. */ }
    return null;
  }
}

export async function testConnection(options = {}, fetcher = fetch) {
  const started = Date.now();
  const raw = options && typeof options === "object" && !Array.isArray(options) ? options : {};
  const timeoutMs = Number.isInteger(raw.gatewayTimeoutMs) ? raw.gatewayTimeoutMs : 5000;
  let config;
  try { config = configuration({ ...raw, gatewayTimeoutMs: timeoutMs }); }
  catch { return { ok: false, code: "invalid-options", ms: Date.now() - started, bank: typeof raw.bank === "string" ? raw.bank : "" }; }

  let response;
  try {
    response = await fetcher(`${config.hindsight_api}/health`, {
      method: "GET",
      headers: { "Accept": "application/json", "User-Agent": "magpie-hindsight-page/0.1.0" },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch {
    return { ok: false, code: "unavailable", ms: Date.now() - started, bank: config.bank };
  }
  if (!response.ok) {
    try { await response.body?.cancel(); } catch { /* Ignore cleanup failures. */ }
    return { ok: false, code: [401, 403].includes(response.status) ? "unauthorized" : response.status === 404 ? "invalid" : "unavailable", ms: Date.now() - started, bank: config.bank };
  }
  const code = await readHealth(response) ?? "invalid";
  return { ok: code === "connected", code, ms: Date.now() - started, bank: config.bank };
}
