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
import { join } from "node:path";
import { readFile } from "node:fs/promises";

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
    p.stdout?.on("data", (c: Buffer) => (out += c.toString()));
    p.stderr?.on("data", (c: Buffer) => (out += c.toString()));
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
    const v = typeof e === "string" ? e : (e as { reasoningEffort?: unknown } | null)?.reasoningEffort;
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

export type CodexConfig = { modelProvider: string | null; model: string | null; providerModels: string[] };

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
  const provider = typeof modelProvider === "string" ? modelProvider : null;
  const models = new Set<string>();
  if (typeof model === "string" && model) models.add(model);
  for (const [key, value] of values) {
    if (provider && key === `model_providers.${provider}\0models` && Array.isArray(value)) {
      for (const m of value) models.add(m);
    }
  }
  return { modelProvider: provider, model: typeof model === "string" ? model : null, providerModels: [...models] };
}

async function readCodexConfig(): Promise<CodexConfig> {
  const home = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  const file = home.toLowerCase().endsWith(".toml") ? home : join(home, "config.toml");
  try { return parseCodexConfig(await readFile(file, "utf8")); } catch { return { modelProvider: null, model: null, providerModels: [] }; }
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
        const rows = config.providerModels.map((id, i) => ({ id, name: id, isDefault: i === 0 }));
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
