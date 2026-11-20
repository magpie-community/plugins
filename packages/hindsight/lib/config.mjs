export const DEFAULTS = Object.freeze({
  hindsight_api: "http://127.0.0.1:8888",
  bank: "hermes",
  recall_max_tokens: 1024,
  capture: false,
  agents: Object.freeze([]),
  gatewayTimeoutMs: 5000,
  allowRemote: false,
  allowInsecureHttp: false,
  api_key: "",
  api_key_header: "Authorization",
  api_key_prefix: "Bearer ",
  authorizationEnv: "",
  max_replay_blocks: 8
});

const invalid = () => { throw new Error("invalid plugin options"); };

// Headers a caller must not repurpose as a credential slot: overriding them
// would corrupt the request instead of authenticating it.
const RESERVED_HEADERS = new Set([
  "host", "content-length", "content-type", "connection", "transfer-encoding",
  "expect", "upgrade", "te", "trailer", "cookie"
]);

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

  // Optional credentials for a protected Hindsight deployment, sent as
  // `api_key_header: api_key_prefix + api_key`. Never logged, never echoed by
  // the settings page.
  const apiKey = options.api_key ?? DEFAULTS.api_key;
  if (typeof apiKey !== "string" || apiKey.length > 512 || /[\x00-\x1f\x7f]/.test(apiKey)) invalid();
  const apiKeyHeader = options.api_key_header ?? DEFAULTS.api_key_header;
  if (typeof apiKeyHeader !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(apiKeyHeader)) invalid();
  if (apiKey && RESERVED_HEADERS.has(apiKeyHeader.toLowerCase())) invalid();
  const apiKeyPrefix = options.api_key_prefix ?? DEFAULTS.api_key_prefix;
  if (typeof apiKeyPrefix !== "string" || apiKeyPrefix.length > 64 || /[\x00-\x1f\x7f]/.test(apiKeyPrefix)) invalid();

  // The name of the environment variable that holds the same credential. An
  // env name is not a secret, so it can live in the options file where a key
  // should not; api_key still wins when both are set.
  const authorizationEnv = options.authorizationEnv ?? DEFAULTS.authorizationEnv;
  if (typeof authorizationEnv !== "string" ||
      (authorizationEnv !== "" && !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(authorizationEnv))) invalid();

  // How many historical memory blocks may stay attached to the resent
  // conversation. 0 disables the cap; see replay() in lib/turns.mjs for why the
  // cap drops in batches rather than as a sliding window.
  const maxReplayBlocks = options.max_replay_blocks ?? DEFAULTS.max_replay_blocks;
  if (!Number.isInteger(maxReplayBlocks) || maxReplayBlocks < 0 || maxReplayBlocks > 256) invalid();

  return {
    hindsight_api: url.toString().replace(/\/$/, ""),
    bank,
    recall_max_tokens: recallMaxTokens,
    capture,
    agents: [...new Set(agents.map(a => a.toLowerCase()))],
    gatewayTimeoutMs,
    allowRemote,
    allowInsecureHttp,
    api_key: apiKey,
    api_key_header: apiKeyHeader,
    api_key_prefix: apiKeyPrefix,
    authorizationEnv,
    max_replay_blocks: maxReplayBlocks
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
