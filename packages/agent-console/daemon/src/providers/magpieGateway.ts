// magpie gateway: magpie points each Agent's models at the local gateway (applied.json records the model currently applied to each).
// Here we fill in, for those Agents, the model list, the default model and each model's thinking levels. Read-only; no configuration is changed.
import { readFile } from "node:fs/promises";
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
  return (raw && /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/i.test(raw) ? raw : "http://127.0.0.1:3425").replace(/\/+$/, "");
}

async function fetchGatewayModelIds(): Promise<string[]> {
  const base = await gatewayBase();
  try {
    const res = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return [];
    const j = (await res.json()) as { data?: { id?: unknown }[] };
    return (j.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string" && !!id);
  } catch (e) {
    log("warn", "读取 magpie 网关模型列表失败", { err: String(e) });
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

/**
 * Fill in model info for Agents managed by magpie; if magpie doesn't manage this Agent (not in applied.json) return it unchanged.
 * - The Agent's own list knows magpie models (e.g. OpenCode, Codex): keep its list with magpie's first (only what it knows, so picks never fail)
 * - The Agent can't report models (Claude, Pi, dsh): use the gateway's /v1/models with the prefix that Agent uses
 * - Default model = the model magpie currently applies to it; thinking levels from magpie's capability table
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

  let list: ModelInfo[];
  if (knowsMagpie) {
    const mine = real.filter((m) => !tool.prefix || m.id.startsWith(tool.prefix));
    const others = tool.prefix ? real.filter((m) => !m.id.startsWith(tool.prefix)) : [];
    list = [...mine, ...others];
  } else {
    list = (await fetchGatewayModelIds()).map((gid) => ({ id: tool.prefix + gid, name: gid }));
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
