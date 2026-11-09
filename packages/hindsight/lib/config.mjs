export const DEFAULTS = Object.freeze({
  hindsight_api: "http://127.0.0.1:8888",
  bank: "hermes",
  recall_max_tokens: 1024,
  capture: false,
  agents: Object.freeze([]),
  gatewayTimeoutMs: 5000,
  allowRemote: false,
  allowInsecureHttp: false
});

const invalid = () => { throw new Error("invalid plugin options"); };

export function configuration(options = {}) {
  if (options === null) options = {};
  if (typeof options !== "object" || Array.isArray(options)) invalid();

  const rawApi = options.hindsight_api ?? DEFAULTS.hindsight_api;
  if (typeof rawApi !== "string" || rawApi.length > 2048) invalid();
  let url;
  try { url = new URL(rawApi); } catch { invalid(); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) invalid();
  url.pathname = url.pathname.replace(/\/+$/, "");
  // Recall sends the latest user message to this host, so leaving the machine
  // is strictly opt-in: a non-loopback API needs allowRemote, and plain HTTP to
  // a non-loopback host additionally needs allowInsecureHttp.
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const allowRemote = options.allowRemote === true;
  const allowInsecureHttp = options.allowInsecureHttp === true;
  if (!loopback && !allowRemote) invalid();
  if (!loopback && url.protocol === "http:" && !allowInsecureHttp) invalid();

  const bank = options.bank ?? DEFAULTS.bank;
  if (typeof bank !== "string" || !bank || bank !== bank.trim() || bank.length > 128 || /[/?#]/.test(bank)) invalid();

  const recallMaxTokens = options.recall_max_tokens ?? DEFAULTS.recall_max_tokens;
  if (!Number.isInteger(recallMaxTokens) || recallMaxTokens < 1 || recallMaxTokens > 16384) invalid();

  const capture = options.capture ?? DEFAULTS.capture;
  if (typeof capture !== "boolean") invalid();

  const agents = options.agents ?? DEFAULTS.agents;
  if (!Array.isArray(agents) || agents.length > 64 || agents.some(a => typeof a !== "string" || !a || a !== a.trim() || a.length > 128)) invalid();

  const gatewayTimeoutMs = options.gatewayTimeoutMs ?? DEFAULTS.gatewayTimeoutMs;
  if (!Number.isInteger(gatewayTimeoutMs) || gatewayTimeoutMs < 100 || gatewayTimeoutMs > 10000) invalid();

  return {
    hindsight_api: url.toString().replace(/\/$/, ""),
    bank,
    recall_max_tokens: recallMaxTokens,
    capture,
    agents: [...new Set(agents.map(a => a.toLowerCase()))],
    gatewayTimeoutMs,
    allowRemote,
    allowInsecureHttp
  };
}

// Agents with their own automatic Hindsight injection (Hermes plugin, DSH
// coding-agents). With no allow-list configured we skip them so memory is
// never injected twice. Name one in `agents` to force-enable it anyway.
const NATIVE_MEMORY_AGENTS = new Set(["hermes", "dsh"]);

export function agentAllowed(config, agent) {
  if (config.agents.length > 0) return typeof agent === "string" && config.agents.includes(agent.toLowerCase());
  return !NATIVE_MEMORY_AGENTS.has(String(agent ?? "").trim().toLowerCase());
}
