export const DEFAULTS = Object.freeze({
  hindsight_api: "http://127.0.0.1:8888",
  bank: "hermes",
  recall_max_tokens: 1024,
  injection_max_bytes: 16384,
  capture: false,
  agents: Object.freeze([]),
  gatewayTimeoutMs: 5000,
  allowRemote: false,
  allowInsecureHttp: false,
  port: 3482
});

const modes = new Set(["legacy", "auto", "manual"]);
const owners = new Set(["auto", "gateway", "native", "off"]);
const legacyNativeAgents = new Set(["hermes", "dsh"]);
const aliases = new Map([
  ["claude-code", "claude"], ["claude code", "claude"],
  ["hermes-agent", "hermes"], ["hermes agent", "hermes"],
  ["deepseek-harness", "dsh"], ["open-code", "opencode"]
]);

export function agentId(value) {
  if (typeof value !== "string") return "";
  const id = value.trim().toLowerCase();
  if (!id || id.length > 128 || /[\x00-\x1f\x7f]/.test(id)) return "";
  return aliases.get(id) ?? id;
}

function invalid(field) {
  throw new Error("invalid plugin option: " + field);
}

function integer(value, min, max, field) {
  if (!Number.isInteger(value) || value < min || value > max) invalid(field);
  return value;
}

function bankId(value, field) {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > 128 ||
    value === "." || value === ".." || /[/?#\x00-\x1f\x7f]/.test(value)) invalid(field);
  return value;
}

export function configuration(options = {}) {
  options ??= {};
  if (typeof options !== "object" || Array.isArray(options)) invalid("options");

  const rawApi = options.hindsight_api ?? DEFAULTS.hindsight_api;
  if (typeof rawApi !== "string" || rawApi.length > 2048) invalid("hindsight_api");
  let url;
  try { url = new URL(rawApi); } catch { invalid("hindsight_api"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    invalid("hindsight_api");
  url.pathname = url.pathname.replace(/\/+$/, "");
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const allowRemote = options.allowRemote === true;
  const allowInsecureHttp = options.allowInsecureHttp === true;
  if (!loopback && !allowRemote) invalid("allowRemote");
  if (!loopback && url.protocol === "http:" && !allowInsecureHttp) invalid("allowInsecureHttp");

  const bank = bankId(options.bank ?? DEFAULTS.bank, "bank");

  const capture = options.capture ?? DEFAULTS.capture;
  if (typeof capture !== "boolean") invalid("capture");

  const agents = options.agents ?? DEFAULTS.agents;
  if (!Array.isArray(agents) || agents.length > 64 ||
    agents.some(value => typeof value !== "string" || value !== value.trim() || !agentId(value))) invalid("agents");

  const agent_mode = options.agent_mode ?? (Object.hasOwn(options, "agents") ? "legacy" : "auto");
  if (!modes.has(agent_mode)) invalid("agent_mode");
  const rules = options.agent_policies ?? {};
  if (typeof rules !== "object" || Array.isArray(rules) || Object.keys(rules).length > 128) invalid("agent_policies");
  const agent_policies = Object.create(null);
  for (const [name, policy] of Object.entries(rules)) {
    const id = agentId(name);
    if (!id || !policy || typeof policy !== "object" || Array.isArray(policy)) invalid("agent_policies");
    const { recall = "auto", capture = "auto", bank } = policy;
    if (!owners.has(recall) || !owners.has(capture)) invalid("agent_policies");
    agent_policies[id] = { recall, capture, ...(bank != null && bank !== "" ? { bank: bankId(bank, "agent_policies") } : {}) };
  }
  const recall_tags = options.recall_tags ?? [];
  if (!Array.isArray(recall_tags) || recall_tags.length > 16 ||
    recall_tags.some(tag => typeof tag !== "string" || !tag.trim() || tag !== tag.trim() ||
      tag.length > 80 || /[\x00-\x1f\x7f]/.test(tag))) invalid("recall_tags");

  return {
    hindsight_api: url.toString().replace(/\/$/, ""),
    bank,
    recall_max_tokens: integer(options.recall_max_tokens ?? DEFAULTS.recall_max_tokens, 1, 16384, "recall_max_tokens"),
    injection_max_bytes: integer(options.injection_max_bytes ?? DEFAULTS.injection_max_bytes, 1024, 131072, "injection_max_bytes"),
    capture,
    agents: [...new Set(agents.map(a => a.toLowerCase()))],
    agent_mode,
    agent_policies,
    recall_tags: [...new Set(recall_tags)],
    gatewayTimeoutMs: integer(options.gatewayTimeoutMs ?? DEFAULTS.gatewayTimeoutMs, 100, 10000, "gatewayTimeoutMs"),
    port: integer(options.port ?? DEFAULTS.port, 1024, 65535, "port"),
    allowRemote,
    allowInsecureHttp
  };
}

export function gatewayBank(config, agent) {
  return (config.agent_mode !== "legacy" && config.agent_policies[agentId(agent)]?.bank) || config.bank;
}

export function gatewayBanks(config) {
  const overrides = config.agent_mode === "legacy" ? [] : Object.values(config.agent_policies).map(rule => rule.bank).filter(Boolean);
  return [...new Set([config.bank, ...overrides])];
}

export function agentAllowed(config, agent) {
  if (config.agents.length) return typeof agent === "string" && config.agents.includes(agent.toLowerCase());
  return !legacyNativeAgents.has(String(agent ?? "").trim().toLowerCase());
}

function decision(config, source, action, native, evidence) {
  if (source === "native") return { owner: "native", reason: native === "active" ? "native-active" : "manual-native" };
  if (source === "off") return { owner: "off", reason: "policy-off" };
  if (source === "auto" && native === "active") return { owner: "native", reason: "native-active" };
  if (action === "capture" && !config.capture) return { owner: "off", reason: "capture-off" };
  if (source === "gateway" || native === "inactive") {
    return { owner: "gateway", reason: native === "active" ? "native-conflict"
      : source === "auto" && evidence === "no-supported-integration" ? "gateway-fallback" : "gateway-enabled" };
  }
  return { owner: "pending", reason: evidence === "unsupported" ? "native-unsupported"
    : evidence === "observed" ? "native-history-only"
    : evidence === "installed-profile" ? "native-installed-unverified"
    : evidence === "separate-profile" || evidence === "multiple-profiles" ? "native-profile-unknown" : "native-unknown" };
}

export function agentPolicy(config, agent, native = {}) {
  if (config.agent_mode === "legacy") {
    const allowed = agentAllowed(config, agent);
    const legacyReason = action => native[action] === "active" ? "native-conflict" : "legacy-selected";
    return {
      recall: { owner: allowed ? "gateway" : "off", reason: allowed ? legacyReason("recall") : "legacy-excluded" },
      capture: { owner: allowed && config.capture ? "gateway" : "off", reason: allowed ? (config.capture ? legacyReason("capture") : "capture-off") : "legacy-excluded" }
    };
  }
  const id = agentId(agent);
  const setting = id ? config.agent_policies[id] : undefined;
  const fallback = config.agent_mode === "auto" ? "auto" : "off";
  return {
    recall: decision(config, setting?.recall ?? fallback, "recall", native.recall, native.evidence),
    capture: decision(config, setting?.capture ?? fallback, "capture", native.capture, native.evidence)
  };
}
