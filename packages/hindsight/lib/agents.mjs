import { access, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { agentId } from "./config.mjs";

const TTL = 30000;
const KNOWN = {
  hermes: ["Hermes Agent", ".hermes"], dsh: ["DeepSeek Harness", ".dsh"],
  claude: ["Claude Code", ".claude"], codex: ["Codex", ".codex"],
  opencode: ["OpenCode", ".config/opencode"], pi: ["Pi", ".pi"],
  gemini: ["Gemini CLI", ".gemini"], agy: ["Antigravity CLI", ".antigravity"],
  cursor: ["Cursor", ".cursor"], copilot: ["GitHub Copilot", ".copilot"],
  codebuddy: ["CodeBuddy", ".codebuddy"], goose: ["Goose", ".config/goose"]
};
const empty = Object.freeze({ agents: [], native: {} });
const unknown = { recall: "unknown", capture: "unknown", evidence: "unknown" };

async function file(path, max = 512 * 1024, tail = false) {
  let handle;
  try {
    handle = await open(path, "r");
    const { size } = await handle.stat();
    if (size > max && !tail) return "";
    const start = Math.max(0, size - max);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const content = buffer.toString("utf8", 0, bytesRead).replace(/^\uFEFF/, "");
    return start ? content.slice(content.indexOf("\n") + 1) : content;
  } catch { return ""; }
  finally { await handle?.close().catch(() => {}); }
}

function json(text) {
  try { return JSON.parse(text) ?? {}; }
  catch { return {}; }
}

function safeBank(value) {
  return typeof value === "string" && /^[\p{L}\p{N}_.:@-]{1,128}$/u.test(value) ? value : "";
}

function commands(groups, filename) {
  return Array.isArray(groups) && groups.some(group => Array.isArray(group?.hooks) &&
    group.hooks.some(hook => typeof hook?.command === "string" &&
      /hindsight/i.test(hook.command) && hook.command.includes(filename)));
}

function hasEntry(text, filename) {
  return typeof text === "string" && /hindsight/i.test(text) && text.includes(filename);
}

function codingBank(config) {
  if (config.mapPathToBank || config.paths || config.banks) return "";
  return safeBank(config.bankId);
}

function codingPolicy(harness, seen, registered, config, allowInactive) {
  const settings = { ...config, ...config.harnesses?.[harness] };
  const scoped = Boolean(config.paths || config.banks);
  const hasEvidence = registered.recall || registered.capture;
  const absent = allowInactive && !hasEvidence && !seen;
  if (settings.disabled === true && hasEvidence && !scoped)
    return { recall: "inactive", capture: "inactive", evidence: "disabled" };
  const state = (wired, off) => wired ? (off ? (scoped ? "unknown" : "inactive") : "active") : (absent ? "inactive" : "unknown");
  return {
    recall: state(registered.recall, settings.autoInject === "none" || (settings.autoInject === undefined && settings.autoReflect === false)),
    capture: state(registered.capture, settings.retainSessions === false),
    bank: hasEvidence ? codingBank(settings) : "",
    variableBank: hasEvidence && !codingBank(settings),
    evidence: hasEvidence ? (scoped ? "scoped" : "wired") : absent ? "no-supported-integration" : seen ? "observed" : "unknown"
  };
}

function hermesPolicy(config, provider, knownOverrides) {
  if (!provider) return unknown;
  if (provider !== "hindsight") return { recall: "inactive", capture: "inactive", evidence: "other-provider" };
  return {
    recall: config.auto_recall === false ? "inactive" : "active",
    capture: config.auto_retain === false ? "inactive" : "active",
    bank: safeBank(config.bank_id || knownOverrides.HINDSIGHT_BANK_ID),
    variableBank: !config.bank_id && !knownOverrides.HINDSIGHT_BANK_ID,
    evidence: "hermes-provider"
  };
}

function counts(source) {
  const byAgent = Object.create(null);
  function update(line, kind) {
    const row = json(line);
    const id = agentId(row.harness);
    const time = Date.parse(row.ts);
    if (!id || !Number.isFinite(time) || time < Date.now() - 30 * 86400000) return;
    const agent = byAgent[id] ?? (byAgent[id] = { last: 0, turns: 0, tools: 0, retrievals: 0, errors: 0 });
    agent.last = Math.max(time, agent.last);
    if (kind === "usage") {
      agent.turns++;
      agent.tools += Array.isArray(row.calls) ? Math.min(row.calls.length, 100) : 0;
    } else if (/^(?:reflect|inject_|pages_|prefetch)/.test(row.event ?? "")) {
      if (/(?:_failed|_error)$/.test(row.event)) agent.errors++;
      else agent.retrievals++;
    }
  }
  for (const [key, text] of Object.entries(source)) for (const line of text.split("\n")) update(line, key);
  return byAgent;
}

export async function discoverAgents({ home = homedir(), env = process.env, configDir, nativeLogs = true } = {}) {
  configDir ??= env.MAGPIE_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(home, ".config"), "magpie");
  const configRoot = env.XDG_CONFIG_HOME || join(home, ".config");
  const hermes = env.HERMES_HOME || join(home, ".hermes");
  const dsh = env.DSH_HOME || join(home, ".dsh");
  const codex = env.CODEX_HOME || join(home, ".codex");
  const nativeLogDir = join(home, ".hindsight", "coding-agents-logs");
  const read = path => file(path);
  const [applied, hermesYaml, hermesConfig, dshPatch, coding, claude, codexHooks, oc, occ, pi, usage, diag, ...local] = await Promise.all([
    read(join(configDir, "applied.json")), read(join(hermes, "config.yaml")), read(join(hermes, "hindsight", "config.json")),
    read(join(dsh, "cordis.patch.yml")), read(env.HINDSIGHT_CONFIG || join(home, ".hindsight", "coding-agent.json")),
    read(join(env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "settings.json")), read(join(codex, "hooks.json")),
    read(join(configRoot, "opencode", "opencode.json")), read(join(configRoot, "opencode", "opencode.jsonc")),
    read(join(home, ".pi", "agent", "settings.json")),
    nativeLogs ? file(env.HINDSIGHT_USAGE_FILE || join(nativeLogDir, "usage.jsonl"), 256 * 1024, true) : "",
    nativeLogs ? file(env.HINDSIGHT_DIAG_FILE || join(nativeLogDir, "diag.jsonl"), 256 * 1024, true) : "",
    ...Object.entries(KNOWN).map(async ([id, [, dir]]) => {
      const path = { hermes, dsh, codex, opencode: join(configRoot, "opencode") }[id] || join(home, dir);
      try { await access(path); return id; } catch { return ""; }
    })
  ]);
  const connected = new Set(Object.keys(json(applied)).map(agentId).filter(Boolean));
  const discovered = new Set(local.filter(Boolean));
  const nativeStats = counts({ usage, diag });
  const cfg = json(coding);
  // Only static booleans and wiring are returned. Per-project overrides remain visible as scoped.
  const claudeData = json(claude);
  const claudeHooks = claudeData.hooks ?? {};
  const codexData = json(codexHooks).hooks ?? {};
  const hermesSection = /^memory:[^\S\r\n]*\r?\n((?:[ \t][^\r\n]*(?:\r?\n|$))*)/m.exec(hermesYaml)?.[1] || "";
  const provider = /^\s+provider:\s*["']?([a-z0-9_-]+)/im.exec(hermesSection)?.[1];
  const dshWired = /(?:^\s*-\s+id:\s*["']?hindsight["']?\s*$|^\s*# HINDSIGHT_CODING_AGENTS_DSH_START\s*$)/m.test(dshPatch);
  const ocWired = hasEntry(oc + "\n" + occ, "opencode.js");
  const piWired = Array.isArray(json(pi).extensions) && json(pi).extensions.some(entry => hasEntry(entry, "pi.js"));
  const native = {
    hermes: hermesPolicy(json(hermesConfig), provider, env),
    dsh: codingPolicy("dsh", nativeStats.dsh, { recall: dshWired, capture: dshWired }, cfg, Boolean(dshPatch)),
    claude: codingPolicy("claude-code", nativeStats.claude, {
      recall: !claudeData.disableAllHooks && commands(claudeHooks.UserPromptSubmit, "claude-hook.js"),
      capture: !claudeData.disableAllHooks && commands(claudeHooks.Stop, "claude-stop-hook.js")
    }, cfg, false),
    codex: codingPolicy("codex", nativeStats.codex, {
      recall: commands(codexData.UserPromptSubmit, "codex-hook.js"),
      capture: commands(codexData.Stop, "codex-stop-hook.js")
    }, cfg, false),
    opencode: codingPolicy("opencode", nativeStats.opencode, { recall: ocWired, capture: ocWired }, cfg, false),
    pi: codingPolicy("pi", nativeStats.pi, { recall: piWired, capture: piWired }, cfg, false)
  };
  const ids = new Set([...connected, ...discovered, ...Object.keys(nativeStats)]);
  return {
    agents: [...ids].slice(0, 128).map(id => {
      const item = native[id] ?? unknown;
      return {
        id, name: KNOWN[id]?.[0] ?? id,
        connected: connected.has(id), installed: discovered.has(id),
        native: item, activity: nativeStats[id] ?? null
      };
    }),
    native,
    nativeLogs: Boolean(usage || diag),
    checkedAt: Date.now()
  };
}

let snapshot = empty;
let inFlight;
export function inventory(refresh = false) {
  if (inFlight || (!refresh && Date.now() - (snapshot.checkedAt ?? 0) < TTL)) return inFlight ?? Promise.resolve(snapshot);
  inFlight = discoverAgents().then(result => {
    snapshot = result;
    return snapshot;
  }, () => snapshot).finally(() => { inFlight = undefined; });
  return inFlight;
}

export function nativePolicy(id) {
  // File discovery never delays a model request.
  void inventory();
  return snapshot.native[id];
}
