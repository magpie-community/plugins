// magpie gateway: magpie points each Agent's models at the local gateway (applied.json records the model currently applied to each).
// Here we fill in, for those Agents, the model list, the default model and each model's thinking levels. Read-only; no configuration is changed.
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelInfo } from "./types.js";
import { log } from "../log.js";

/** Agent Console provider id → the key in magpie's applied.json + the model id prefix used inside that Agent */
const MAGPIE_TOOLS: Record<string, { key: string; prefix: string }> = {
  claude: { key: "claude", prefix: "" },
  codex: { key: "codex", prefix: "" },
  opencode: { key: "opencode", prefix: "magpie/" },
  pi: { key: "pi", prefix: "magpie/" },
  dsh: { key: "dsh", prefix: "magpie/" },
};

/** Magpie gateway.TokenFor(agent) = "magpie-" + agent; CatalogFor / ModelOff key off that agent id. */
export const MAGPIE_GATEWAY_TOKEN = "magpie";
export function magpieTokenFor(agentId: string): string {
  return `${MAGPIE_GATEWAY_TOKEN}-${agentId}`;
}

/** Magpie agent id for a Magpie-managed Agent Console provider (same strings Magpie uses in HiddenModels / Visible). */
export function magpieAgentId(providerId: string): string | null {
  return MAGPIE_TOOLS[providerId]?.key ?? null;
}

const EFFORT_LABEL: Record<string, string> = {
  low: "Low", medium: "Medium", high: "High", xhigh: "Extra High", max: "Max",
};

type Applied = Record<string, { fields?: { model?: string; effort?: string } }>;

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

async function readApplied(): Promise<Applied> {
  return (await readJson<Applied>(join(homedir(), ".config", "magpie", "applied.json"))) ?? {};
}

async function readClaudeEnv(): Promise<Record<string, string>> {
  const s = await readJson<{ env?: Record<string, string> }>(join(homedir(), ".claude", "settings.json"));
  return s?.env ?? {};
}

/** Gateway address: ANTHROPIC_BASE_URL from the Claude config (written by magpie), otherwise the default 3425 */
async function gatewayBase(): Promise<string> {
  const env = await readClaudeEnv();
  const raw = env.ANTHROPIC_BASE_URL?.trim();
  return (raw && /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(raw) ? raw : "http://127.0.0.1:3425").replace(/\/+$/, "");
}

/**
 * Magpie's /v1/models is filtered per agent via agentOf(r):
 * Authorization Bearer magpie-<agent> (TokenFor) → CatalogFor(agent) + ModelOff(agent).
 * Without that token Magpie returns the anonymous / global catalog, so models the user hid
 * for Claude Code (etc.) still appear in our picker.
 */
export async function fetchGatewayModelIds(agentId: string): Promise<string[]> {
  const base = await gatewayBase();
  const token = magpieTokenFor(agentId);
  try {
    const res = await fetch(`${base}/v1/models`, {
      signal: AbortSignal.timeout(5000),
      headers: {
        Authorization: `Bearer ${token}`,
        "x-api-key": token,
        // Belt-and-suspenders: AgentOf also maps known User-Agents when the token is plain "magpie".
        "User-Agent": `agent-console/${agentId}`,
      },
    });
    if (!res.ok) return [];
    const j = (await res.json()) as { data?: { id?: unknown }[] };
    return (j.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string" && !!id);
  } catch (e) {
    log("warn", "读取 magpie 网关模型列表失败", { agent: agentId, err: String(e) });
    return [];
  }
}

/** CLAUDE_CODE_MODEL_CAPABILITIES: `id=effort,xhigh_effort,max_effort;id2=effort` → each model's levels */
export function parseCapabilities(raw: string | undefined): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of (raw ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const flags = new Set(part.slice(i + 1).split(",").map((s) => s.trim()));
    if (!flags.has("effort")) continue;
    const levels = ["low", "medium", "high"];
    if (flags.has("xhigh_effort")) levels.push("xhigh");
    if (flags.has("max_effort")) levels.push("max");
    out.set(part.slice(0, i).trim(), levels);
  }
  return out;
}

function isPlaceholder(m: ModelInfo): boolean {
  return !m.id || /^(default|auto)$/i.test(m.id);
}

/** The model Magpie currently applies to this Agent (applied.json), or null when Magpie doesn't manage it.
 *  dsh is excluded: its ACP session needs its own JSON-array model ids, never raw applied.json "magpie/…" strings. */
export async function magpieDefaultModel(providerId: string): Promise<string | null> {
  if (providerId === "dsh") return null;
  const tool = MAGPIE_TOOLS[providerId];
  if (!tool) return null;
  const applied = (await readApplied())[tool.key]?.fields?.model?.trim();
  return applied || null;
}

/**
 * Fingerprint of Magpie / agent config files that change when the user toggles models or the default.
 * Used by the provider model cache: a changed mtime invalidates without waiting for the 10-minute TTL.
 */
export async function magpieConfigFingerprint(providerId: string): Promise<string> {
  // Only our Magpie overlay consumes applied.json / settings.json. Native-only model lists
  // (Cursor, Copilot, Devin) must not spawn a new probe for an unrelated Magpie edit.
  if (!MAGPIE_TOOLS[providerId]) return "";
  const home = homedir();
  const ownFiles: Record<string, string[]> = {
    claude: [join(home, ".claude", "settings.json")],
    codex: [join(home, ".codex", "config.toml"), join(home, ".codex", "magpie-models.json"), join(home, ".codex", "models.json")],
    opencode: [join(home, ".config", "opencode", "opencode.json")],
    pi: [join(home, ".pi", "agent", "settings.json"), join(home, ".pi", "agent", "models.json")],
    // DSH uses YAML under DSH_HOME (default ~/.dsh), not ~/.config/dsh/config.json.
    dsh: ["config.yaml", "settings.yaml", "cordis.patch.yml", "profiles/desktop/cordis.patch.yml", "profiles/web/cordis.patch.yml"]
      .map((file) => join(process.env.DSH_HOME?.trim() || join(home, ".dsh"), file)),
  };
  const paths = [
    join(home, ".config", "magpie", "applied.json"),
    join(home, ".config", "magpie", "settings.json"),
    ...ownFiles[providerId],
  ];
  const parts: string[] = [];
  for (const p of paths) {
    try {
      const st = await stat(p);
      parts.push(`${p}=${st.mtimeMs}`);
    } catch {
      parts.push(`${p}=-`);
    }
  }
  return parts.join("|");
}

/** Keep models Magpie still shows this agent (gateway catalog), matching prefix-aware ids.
 *  Codex ChatGPT-own rows use bare slugs in model/list while Magpie lists them as "codex/<slug>". */
export function filterToGatewayShown(
  list: ModelInfo[],
  gatewayIds: string[],
  prefix: string,
  opts?: { providerId?: string },
): ModelInfo[] {
  if (!gatewayIds.length) return list;
  const shown = new Set(gatewayIds);
  const shownPrefixed = new Set(gatewayIds.map((id) => prefix + id));
  const codexBare = opts?.providerId === "codex";
  return list.filter((m) => {
    if (shown.has(m.id) || shownPrefixed.has(m.id)) return true;
    if (prefix && m.id.startsWith(prefix) && shown.has(m.id.slice(prefix.length))) return true;
    // Codex + ChatGPT sign-in: bare "gpt-5.3-codex" matches gateway "codex/gpt-5.3-codex"
    if (codexBare && !m.id.includes("/") && shown.has(`codex/${m.id}`)) return true;
    return false;
  });
}

/**
 * Fill in model info for Agents managed by magpie; if magpie doesn't manage this Agent (not in applied.json) return it unchanged.
 * - The Agent's own list knows magpie models (e.g. OpenCode, Codex): keep its list with magpie's first (only what it knows, so picks never fail)
 * - The Agent can't report models (Claude, Pi, dsh): use the gateway's /v1/models with the prefix that Agent uses
 * - Default model = the model magpie currently applies to it; thinking levels from magpie's capability table
 * - Gateway fetch always sends TokenFor(agent) so HiddenModels / PickedModels / Visible apply
 */
export async function withMagpie(providerId: string, own: ModelInfo[]): Promise<ModelInfo[]> {
  const tool = MAGPIE_TOOLS[providerId];
  if (!tool) return own;
  const applied = (await readApplied())[tool.key]?.fields;
  if (!applied?.model) return own;

  const caps = parseCapabilities((await readClaudeEnv()).CLAUDE_CODE_MODEL_CAPABILITIES);
  const real = own.filter((m) => !isPlaceholder(m));

  // Over ACP, DSH returns its own real model IDs (JSON-array strings).
  // We must not push an old / another Agent's model ID from applied.json into DSH,
  // otherwise DSH treats it as a routed model and sends it to the wrong provider.
  if (providerId === "dsh") {
    const appliedId = applied.model.replace(/^magpie\//, "");
    const selected = real.find((m) =>
      m.id === applied.model ||
      m.id === appliedId ||
      (appliedId.includes("/") && m.id.includes(appliedId)),
    );
    const fallback = selected ?? real.find((m) => m.isDefault) ?? real[0];
    return real.map((m) => ({ ...m, isDefault: m.id === fallback?.id }));
  }

  const knowsMagpie = tool.prefix ? real.some((m) => m.id.startsWith(tool.prefix)) : real.length > 0;
  // Always ask the gateway as this agent so per-agent visibility (HiddenModels / PickedModels) applies.
  const gatewayIds = await fetchGatewayModelIds(tool.key);

  let list: ModelInfo[];
  if (knowsMagpie) {
    const mine = real.filter((m) => !tool.prefix || m.id.startsWith(tool.prefix));
    const others = tool.prefix ? real.filter((m) => !m.id.startsWith(tool.prefix)) : [];
    // Prefer Magpie's shown catalog when the gateway answered: drops models the user turned off for this agent
    // even if the Agent's own config file is briefly stale.
    const filteredMine = gatewayIds.length ? filterToGatewayShown(mine, gatewayIds, tool.prefix, { providerId }) : mine;
    list = [...(filteredMine.length ? filteredMine : mine), ...others];
  } else {
    list = gatewayIds.map((gid) => ({ id: tool.prefix + gid, name: gid }));
  }

  // Default model = the one magpie currently applies; if it's not in the list, add it at the top
  const defId = applied.model;
  if (!list.some((m) => m.id === defId)) list.unshift({ id: defId, name: defId.slice(tool.prefix.length) || defId });
  list = list.map((m) => ({ ...m, isDefault: m.id === defId }));
  list.sort((a, b) => Number(!!b.isDefault) - Number(!!a.isDefault));

  // Thinking levels: use the Agent's own if it reports them, otherwise magpie's capability table
  return list.map((m) => {
    const name = tool.prefix && m.name.startsWith(tool.prefix) ? m.name.slice(tool.prefix.length) : m.name;
    if (m.thinkingOptions?.length && providerId !== "claude") return { ...m, name };
    const levels = caps.get(m.id.slice(tool.prefix.length) || m.id);
    if (!levels) return { ...m, name, thinkingOptions: providerId === "claude" ? [] : m.thinkingOptions };
    const def = applied.effort && levels.includes(applied.effort) ? applied.effort : levels.includes("high") ? "high" : levels[0];
    return {
      ...m,
      name,
      thinkingOptions: levels.map((id) => ({ id, label: EFFORT_LABEL[id] ?? id })),
      defaultThinking: m.isDefault ? def : m.defaultThinking ?? def,
    };
  });
}
