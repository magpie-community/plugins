// Codex Provider (§7.3): detect + listModels (temporary app-server → model/list, cached 10 minutes) + createSession.
import type { Provider, ProviderSession, DetectResult, ModelInfo, Capabilities, HistoryItem, LaunchCommand } from "../types.js";
import type { ProviderEvent } from "../../timeline/types.js";
import { listCodexHistory, readCodexHistory } from "../../history/codex.js";
import { argvFor, resolveBin, killTree, spawnBin, type ResolveResult } from "../../util/bin.js";
import { CodexRpc, CodexProcessExitedError } from "./rpc.js";
import { CodexSession } from "./session.js";
import { log } from "../../log.js";
import { tr } from "../../util/i18n.js";
import { launchArgv, resolveLaunch } from "../launch.js";
import { PLACEHOLDER_MODEL_NAME } from "../types.js";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { readFile } from "node:fs/promises";
import { OutputDecoder } from "../../util/decode.js";

const INSTALL_HINT = "npm i -g @openai/codex";

export const codexCapabilities: Capabilities = {
  resume: true,
  interrupt: true,
  steer: true,
  images: true,
  plan: true,
  questions: true,
  cost: false, // tokenUsage yes, cost no
  effort: [], // effort values depend on the model — filled from model/list after detect
  // No "plan": app-server 0.16x has no plan/collaboration mode on turn/start, and a read-only "plan" was the same preset as default (B9)
  modes: ["default", "acceptEdits", "bypassPermissions"],
  modeLabels: { default: "Read Only", acceptEdits: "Auto", bypassPermissions: "Full Access" },
};

let modelCache: { at: number; models: ModelInfo[] } | null = null;
const MODEL_CACHE_MS = 10 * 60 * 1000;

/** Cleared by clearProviderCache so a Magpie refresh doesn't keep Codex's own 10-minute list. */
export function clearCodexModelCache(): void {
  modelCache = null;
}

function runVersion(r: ResolveResult & { ok: true }, args: string[], timeoutMs = 5000): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let out = "";
    const p = spawnBin(r, args, { stdio: ["ignore", "pipe", "pipe"] });
    const t = setTimeout(() => {
      try {
        void killTree(p, { graceMs: 500 }); // On Windows a .cmd wrapper must be killed together with its child processes
      } catch {}
      reject(new Error("timeout"));
    }, timeoutMs);
    // 1.3: --version / model lists may come back in the Windows code page (GBK) when something fails
    const od = new OutputDecoder(), ed = new OutputDecoder();
    p.stdout?.on("data", (c: Buffer) => (out += od.write(c)));
    p.stderr?.on("data", (c: Buffer) => (out += ed.write(c)));
    p.on("error", reject);
    p.on("close", (code) => {
      clearTimeout(t);
      if (code === 0) resolvePromise(out);
      else reject(new Error("exit " + code));
    });
  });
}

/** Normalize the level list to strings: accepts string[] and { reasoningEffort, description }[]; other shapes are dropped */
export function normalizeEfforts(raw: unknown[] | undefined): string[] {
  const out: string[] = [];
  for (const e of raw ?? []) {
    // model_catalog_json's supported_reasoning_levels are { effort, description }[]
    const o = e as { reasoningEffort?: unknown; effort?: unknown } | null;
    const v = typeof e === "string" ? e : o?.reasoningEffort ?? o?.effort;
    if (typeof v === "string" && v && !out.includes(v)) out.push(v);
  }
  return out;
}

async function fetchModels(r: ResolveResult & { ok: true }, cwd: string, launch?: LaunchCommand): Promise<ModelInfo[]> {
  const rpc = new CodexRpc(argvFor(r, launchArgv(["app-server"], launch)), { cwd });
  try {
    await rpc.request("initialize", {
      clientInfo: { name: "agent-console", title: "Agent Console", version: "0" },
      capabilities: { experimentalApi: true },
    }, 15000);
    rpc.notify("initialized", {});
    const res = (await rpc.request("model/list", {}, 15000)) as {
      data?: {
        id?: string;
        displayName?: string;
        isDefault?: boolean;
        // Newer app-server returns { reasoningEffort, description }[], older ones string[]
        supportedReasoningEfforts?: unknown[];
        defaultReasoningEffort?: string;
      }[];
    };
    const rows = res.data ?? [];
    return rows
      .filter((m) => typeof m.id === "string" && m.id)
      .map((m) => {
        const efforts = normalizeEfforts(m.supportedReasoningEfforts);
        const thinkingOptions = efforts.map((e) => ({ id: e, label: e }));
        const defaultThinking = (typeof m.defaultReasoningEffort === "string" ? m.defaultReasoningEffort : null) ?? thinkingOptions[0]?.id ?? null;
        return {
          id: m.id!,
          name: m.displayName ?? m.id!,
          isDefault: m.isDefault,
          efforts,
          thinkingOptions,
          defaultThinking,
        };
      });
  } finally {
    await rpc.close();
  }
}

export type CodexConfig = { modelProvider: string | null; model: string | null; providerModels: string[]; catalogJson: string | null };

function tomlValue(raw: string): string | string[] | null {
  const v = raw.trim().replace(/\s+#.*$/, "");
  const quoted = v.match(/^"([\s\S]*)"$/) ?? v.match(/^'([\s\S]*)'$/);
  if (quoted) return quoted[1];
  if (v.startsWith("[") && v.endsWith("]")) {
    return v.slice(1, -1).split(",").map((x) => tomlValue(x)).filter((x): x is string => typeof x === "string");
  }
  return null;
}

export function parseCodexConfig(text: string): CodexConfig {
  let section = "";
  const values = new Map<string, string | string[]>();
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const header = s.match(/^\[([^\]]+)\]$/);
    if (header) { section = header[1]; continue; }
    const m = s.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!m) continue;
    const value = tomlValue(m[2]);
    if (typeof value === "string" || Array.isArray(value)) values.set(`${section}\0${m[1]}`, value);
  }
  const top = (key: string) => values.get(`\0${key}`);
  const profile = top("profile");
  const profileName = typeof profile === "string" ? profile : null;
  const profileValue = (key: string) => profileName ? values.get(`profiles.${profileName}\0${key}`) : undefined;
  const modelProvider = (profileValue("model_provider") ?? top("model_provider"));
  const model = (profileValue("model") ?? top("model"));
  const catalog = (profileValue("model_catalog_json") ?? top("model_catalog_json"));
  const provider = typeof modelProvider === "string" ? modelProvider : null;
  const models = new Set<string>();
  if (typeof model === "string" && model) models.add(model);
  for (const [key, value] of values) {
    if (provider && key === `model_providers.${provider}\0models` && Array.isArray(value)) {
      for (const m of value) models.add(m);
    }
  }
  return {
    modelProvider: provider,
    model: typeof model === "string" ? model : null,
    providerModels: [...models],
    catalogJson: typeof catalog === "string" && catalog.trim() ? catalog.trim() : null,
  };
}

/**
 * Where Codex reads model_catalog_json from: "~" and "~/…" are the home folder, a relative
 * path is taken from config.toml's folder (Codex's AbsolutePathBuf). Codex doesn't expand
 * environment variables; a leading $HOME / ${HOME} is expanded here anyway (#758).
 */
export function resolveCatalogPath(raw: string, configDir: string, home = homedir()): string {
  let p = raw.trim();
  const env = p.match(/^(?:\$HOME|\$\{HOME\})(?=$|[\\/])/);
  if (env) p = home + p.slice(env[0].length);
  else if (p === "~") p = home;
  else if (/^~[\\/]/.test(p)) p = join(home, p.slice(2));
  return isAbsolute(p) ? p : join(configDir, p);
}

/** The picker's rows from a Codex models.json ({ models: [{ slug, display_name, … }] }); hidden entries are left out as Codex's picker does */
export function parseCodexCatalog(text: string): ModelInfo[] {
  const doc = JSON.parse(text) as { models?: unknown };
  if (!Array.isArray(doc?.models)) return [];
  const out: ModelInfo[] = [];
  const seen = new Set<string>();
  for (const raw of doc.models) {
    const m = raw as { slug?: unknown; display_name?: unknown; visibility?: unknown; supported_reasoning_levels?: unknown; default_reasoning_level?: unknown } | null;
    if (!m || typeof m.slug !== "string" || !m.slug || seen.has(m.slug)) continue;
    if (typeof m.visibility === "string" && m.visibility !== "list") continue;
    seen.add(m.slug);
    const efforts = normalizeEfforts(Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels : undefined);
    const thinkingOptions = efforts.map((e) => ({ id: e, label: e }));
    const def = typeof m.default_reasoning_level === "string" && efforts.includes(m.default_reasoning_level) ? m.default_reasoning_level : null;
    const name = typeof m.display_name === "string" && m.display_name.trim() ? m.display_name.trim() : m.slug;
    out.push({ id: m.slug, name, efforts, thinkingOptions, defaultThinking: def ?? thinkingOptions[0]?.id ?? null });
  }
  return out;
}

/** A custom provider's models: model_catalog_json's list, then the provider's models = [...]; the configured model is the default */
export async function codexProviderModels(config: CodexConfig, configDir: string, home = homedir()): Promise<ModelInfo[]> {
  let rows: ModelInfo[] = [];
  if (config.catalogJson) {
    const file = resolveCatalogPath(config.catalogJson, configDir, home);
    try {
      rows = parseCodexCatalog(await readFile(file, "utf8"));
    } catch (e) {
      // a missing or broken catalog keeps the list from config.toml
      log("warn", "codex model_catalog_json 读取失败", { file, err: String(e) });
    }
  }
  const ids = new Set(rows.map((r) => r.id));
  for (const id of config.providerModels) {
    if (!ids.has(id)) { ids.add(id); rows.push({ id, name: id }); }
  }
  if (config.model && !rows.some((r) => r.id === config.model)) rows.unshift({ id: config.model, name: config.model });
  const def = config.model ?? rows[0]?.id;
  return rows.map((r) => ({ ...r, isDefault: r.id === def }));
}

function codexConfigFile(): string {
  const home = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  return home.toLowerCase().endsWith(".toml") ? home : join(home, "config.toml");
}

async function readCodexConfig(): Promise<CodexConfig> {
  try { return parseCodexConfig(await readFile(codexConfigFile(), "utf8")); } catch { return { modelProvider: null, model: null, providerModels: [], catalogJson: null }; }
}

function isChatGptProvider(id: string | null): boolean {
  return !id || /^(openai|chatgpt)$/i.test(id);
}

export function createCodexProvider(version: string): Provider {
  return {
    id: "codex",
    name: "Codex",
    capabilities: codexCapabilities,
    async detect(launch?: LaunchCommand): Promise<DetectResult> {
      const bin = launch ? await resolveLaunch(launch) : await resolveBin("codex");
      if (!bin.ok) {
        return { available: false, reason: bin.reason, installHint: INSTALL_HINT };
      }
      try {
        const v = await runVersion(bin, [...(launch?.prefixArgs ?? []), "--version"]);
        return { available: true, bin: bin.display, version: v.trim().split("\n")[0] || "" };
      } catch (e) {
        return { available: true, bin: bin.display, version: "", reason: String(e) };
      }
    },
    async listModels(launch?: LaunchCommand): Promise<ModelInfo[]> {
      const config = await readCodexConfig();
      if (!isChatGptProvider(config.modelProvider)) {
        const rows = await codexProviderModels(config, dirname(codexConfigFile()));
        return rows.length ? rows : [{ id: "", name: `${PLACEHOLDER_MODEL_NAME} (${config.modelProvider})`, isDefault: true }];
      }
      if (!launch && modelCache && Date.now() - modelCache.at < MODEL_CACHE_MS) return modelCache.models;
      const bin = launch ? await resolveLaunch(launch) : await resolveBin("codex");
      if (!bin.ok) return [{ id: "", name: PLACEHOLDER_MODEL_NAME }];
      try {
        const models = await fetchModels(bin, process.cwd(), launch);
        modelCache = { at: Date.now(), models };
        return models;
      } catch (e) {
        // Gateway region errors etc. — the frontend shows a single "Default" entry (§7.3.6)
        log("warn", "codex model/list 失败", { err: String(e) });
        return [{ id: "", name: PLACEHOLDER_MODEL_NAME }];
      }
    },
    async createSession(o): Promise<ProviderSession> {
      const bin = o.launch ? await resolveLaunch(o.launch) : await resolveBin("codex");
      if (!bin.ok) throw new Error(tr("codex.notFound", { detail: bin.reason, hint: INSTALL_HINT }));
      return new CodexSession({
        threadId: o.threadId,
        cwd: o.cwd,
        model: o.model,
        mode: o.mode,
        effort: o.effort,
        resumeId: o.resumeId,
        binCmd: bin.cmd,
        binPrefixArgs: bin.prefixArgs,
        binVia: bin.via,
        binShim: bin.shim,
        launch: o.launch,
        version,
      });
    },
    // §7.6: ~/.codex/sessions/**/rollout-*.jsonl matched by cwd
    async listHistory(cwd: string): Promise<HistoryItem[]> {
      const items = await listCodexHistory(cwd);
      return items.map((i) => ({ provider: "codex", ...i, imported: false }));
    },
    async readHistory(sessionId: string, cwd: string): Promise<ProviderEvent[]> {
      return (await readCodexHistory(sessionId, cwd)) as unknown as ProviderEvent[];
    },
  };
}
