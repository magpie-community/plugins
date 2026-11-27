import { access, open, readdir } from "node:fs/promises";
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
const unsupported = { ...unknown, evidence: "unsupported" };

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

function jsonConfig(text) {
  if (!text) return null;
  // Preserve quoted URLs and strings while removing JSONC comments.
  const plain = text.replace(/"(?:\\.|[^"\\])*"|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, token => token[0] === '"' ? token : "");
  try { return JSON.parse(plain.replace(/"(?:\\.|[^"\\])*"|,\s*(?=[}\]])/g, token => token[0] === '"' ? token : "")); }
  catch { return null; }
}

function safeBank(value) {
  return typeof value === "string" && /^[\p{L}\p{N}_.:@-]{1,128}$/u.test(value) ? value : "";
}

function commands(groups, action) {
  return Array.isArray(groups) && groups.some(group => {
    const hooks = Array.isArray(group?.hooks) ? group.hooks : [group];
    return hooks.some(hook => typeof hook?.command === "string" && /hindsight/i.test(hook.command) &&
      (action === "recall" ? !/(?:retain|stop-hook)/i.test(hook.command) : /retain|stop-hook|after[-_]agent/i.test(hook.command)));
  });
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
  const state = (wired, off, assumeAbsent) => wired
    ? (off ? (scoped ? "unknown" : "inactive") : "active")
    : (assumeAbsent ? "inactive" : "unknown");
  return {
    recall: state(registered.recall, settings.autoInject === "none" || (settings.autoInject === undefined && settings.autoReflect === false), allowInactive && !seen),
    capture: state(registered.capture, settings.retainSessions === false, false),
    bank: hasEvidence ? codingBank(settings) : "",
    variableBank: hasEvidence && !codingBank(settings),
    evidence: hasEvidence ? (scoped ? "scoped" : "wired") : absent ? "no-supported-integration" : seen ? "observed" : "unknown"
  };
}

function hermesProvider(text) {
  const section = /^memory:\s*(?:#[^\r\n]*)?\r?\n((?:[ \t][^\r\n]*(?:\r?\n|$))*)/m.exec(text)?.[1] || "";
  return /^\s+provider:\s*["']?([a-z0-9_-]+)/im.exec(section)?.[1]?.toLowerCase();
}

function dshPlugin(text) {
  return /(?:^\s*-\s*id:\s*["']?hindsight\b|^\s*# HINDSIGHT_CODING_AGENTS_DSH_START\s*$|^\s*(?:name|plugin):[^\r\n]*hindsight-coding-agents)/im.test(text);
}

function opencodePlugin(config) {
  return Array.isArray(config?.plugin) && config.plugin.some(value =>
    typeof value === "string" && /(?:@vectorize-io[\\/]|[\\/]\.?hindsight[\\/]).*coding-agents|hindsight.*opencode\.js/i.test(value));
}

function hooked(config, { recall, capture }) {
  const hooks = config?.hooks ?? {};
  return {
    recall: recall.some(event => commands(hooks[event], "recall")),
    capture: capture.some(event => commands(hooks[event], "capture"))
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
  const desktopHermes = env.HERMES_HOME || join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "hermes");
  const dsh = env.DSH_HOME || join(home, ".dsh");
  const codex = env.CODEX_HOME || join(home, ".codex");
  const nativeLogDir = join(home, ".hindsight", "coding-agents-logs");
  const read = path => file(path);
  const dshProfiles = await readdir(join(dsh, "profiles"), { withFileTypes: true }).catch(() => []);
  const dshPaths = dshProfiles.filter(entry => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules")
    .slice(0, 32).map(entry => join(dsh, "profiles", entry.name));
  const ocRoot = env.OPENCODE_CONFIG_DIR || join(configRoot, "opencode");
  const knownHooks = {
    agy: [".gemini/antigravity-cli/settings.json", ".antigravity/settings.json"],
    codebuddy: [".codebuddy/settings.json"],
    gemini: [".gemini/config/hooks.json", ".gemini/settings.json"],
    cursor: [".cursor/hooks.json"],
    copilot: [".copilot/hooks/hindsight-coding-agents.json"]
  };
  const [applied, hermesYaml, hermesConfig, desktopYaml, desktopConfig, dshRoot, dshSettings, profiles, dshPackages, coding, claude,
    codexHooks, codexSettings, oc, occ, pi, hookConfigs, usage, diag, ...local] = await Promise.all([
    read(join(configDir, "applied.json")), read(join(hermes, "config.yaml")), read(join(hermes, "hindsight", "config.json")),
    read(join(desktopHermes, "config.yaml")), read(join(desktopHermes, "hindsight", "config.json")),
    read(join(dsh, "cordis.patch.yml")), read(join(dsh, "settings.yaml")),
    Promise.all(dshPaths.map(path => read(join(path, "cordis.patch.yml")))),
    Promise.all(dshPaths.map(path => read(join(path, "package.json")))),
    read(env.HINDSIGHT_CONFIG || join(home, ".hindsight", "coding-agent.json")),
    read(join(env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "settings.json")), read(join(codex, "hooks.json")),
    read(join(codex, "config.toml")),
    read(env.OPENCODE_CONFIG || join(ocRoot, "opencode.json")), read(join(ocRoot, "opencode.jsonc")),
    read(join(home, ".pi", "agent", "settings.json")),
    Promise.all(Object.values(knownHooks).map(paths => Promise.all(paths.map(path => read(join(home, path)))))),
    nativeLogs ? file(env.HINDSIGHT_USAGE_FILE || join(nativeLogDir, "usage.jsonl"), 256 * 1024, true) : "",
    nativeLogs ? file(env.HINDSIGHT_DIAG_FILE || join(nativeLogDir, "diag.jsonl"), 256 * 1024, true) : "",
    ...Object.entries(KNOWN).map(async ([id, [, dir]]) => {
      const path = { hermes, dsh, codex, opencode: ocRoot }[id] || join(home, dir);
      try { await access(path); return id; } catch { return ""; }
    })
  ]);
  const connected = new Set(Object.keys(json(applied)).map(agentId).filter(Boolean));
  const discovered = new Set(local.filter(Boolean));
  const nativeStats = counts({ usage, diag });
  const cfg = json(coding);
  // Only static booleans and wiring are returned. Per-project overrides remain visible as scoped.
  const standard = { recall: ["UserPromptSubmit", "userPromptSubmitted", "BeforeAgent"], capture: ["Stop", "sessionEnd", "AfterAgent"] };
  const claudeData = jsonConfig(claude);
  const codexData = jsonConfig(codexHooks);
  const codexDisabled = /^\s*(?:codex_hooks|hooks)\s*=\s*false\s*(?:#.*)?$/m.test(codexSettings);
  const codexWiring = hooked(codexData, standard);
  const codexCustom = codexWiring.recall && !/codex-hook\.js/i.test(codexHooks);
  const primaryProvider = hermesProvider(hermesYaml);
  const desktopProvider = hermesProvider(desktopYaml);
  const desktop = !primaryProvider && Boolean(desktopProvider);
  const provider = primaryProvider || desktopProvider;
  const dshWired = [dshRoot, dshSettings, ...profiles].some(dshPlugin);
  const dshInstalled = dshPackages.some(text =>
    Object.hasOwn(json(text).dependencies ?? {}, "@vectorize-io/hindsight-coding-agents"));
  const ocSettings = [jsonConfig(oc), jsonConfig(occ)];
  const ocWired = ocSettings.some(opencodePlugin);
  const piSettings = jsonConfig(pi);
  const piWired = Array.isArray(piSettings?.extensions) &&
    piSettings.extensions.some(entry => typeof entry === "string" && /hindsight.*[\\/]pi\.js/i.test(entry));
  const native = {
    hermes: primaryProvider && desktopProvider && primaryProvider !== desktopProvider
      ? { ...unknown, evidence: "multiple-profiles" }
      : hermesPolicy(json(desktop ? desktopConfig : hermesConfig), provider, env),
    dsh: !dshWired && dshInstalled
      ? { ...unknown, bank: codingBank({ ...cfg, ...cfg.harnesses?.dsh }), evidence: "installed-profile" }
      : codingPolicy("dsh", nativeStats.dsh, { recall: dshWired, capture: dshWired }, cfg, profiles.some(Boolean) || Boolean(dshRoot)),
    claude: claudeData?.disableAllHooks ? { recall: "inactive", capture: "inactive", evidence: "disabled" }
      : codingPolicy("claude-code", nativeStats.claude, hooked(claudeData, standard), cfg, Boolean(claudeData)),
    codex: codexDisabled ? { recall: "inactive", capture: "inactive", evidence: "disabled" }
      : codexCustom ? { recall: "active", capture: codexWiring.capture ? "active" : "unknown", evidence: "custom-hook" }
      : codingPolicy("codex", nativeStats.codex, codexWiring, cfg, Boolean(codexData)),
    opencode: codingPolicy("opencode", nativeStats.opencode, { recall: ocWired, capture: ocWired }, cfg, ocSettings.some(Boolean)),
    pi: codingPolicy("pi", nativeStats.pi, { recall: piWired, capture: piWired }, cfg, Boolean(piSettings))
  };
  Object.keys(knownHooks).forEach((id, index) => {
    const configs = hookConfigs[index].map(jsonConfig).filter(Boolean);
    const registered = configs.map(config => hooked(config, standard));
    const wiring = { recall: registered.some(item => item.recall), capture: registered.some(item => item.capture) };
    const harness = id === "agy" ? "antigravity" : id;
    native[id] = configs.length
      ? codingPolicy(harness, nativeStats[id], wiring, cfg, true)
      : nativeStats[id] ? { ...unknown, evidence: "observed" } : unsupported;
  });
  const ids = new Set([...connected, ...discovered, ...Object.keys(nativeStats)]);
  if (provider) ids.add("hermes");
  for (const id of ids) {
    const base = native[id.split("#")[0]];
    native[id] ??= nativeStats[id] ? { ...unknown, evidence: "observed" }
      : base?.recall === "active" ? { ...unknown, evidence: "separate-profile" } : unsupported;
  }
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
  return Object.hasOwn(snapshot.native, id) ? snapshot.native[id] : (id ? unsupported : unknown);
}
