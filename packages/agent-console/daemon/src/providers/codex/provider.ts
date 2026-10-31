// Codex Provider (§7.3): detect + listModels (temporary app-server → model/list, cached 10 minutes) + createSession.
import type { Provider, ProviderSession, DetectResult, ModelInfo, Capabilities, HistoryItem } from "../types.js";
import type { ProviderEvent } from "../../timeline/types.js";
import { listCodexHistory, readCodexHistory } from "../../history/codex.js";
import { argvFor, resolveBin, killTree, spawnBin, type ResolveResult } from "../../util/bin.js";
import { CodexRpc, CodexProcessExitedError } from "./rpc.js";
import { CodexSession } from "./session.js";
import { log } from "../../log.js";

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
  modes: ["plan", "default", "acceptEdits", "bypassPermissions"],
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

async function fetchModels(r: ResolveResult & { ok: true }, cwd: string): Promise<ModelInfo[]> {
  const rpc = new CodexRpc(argvFor(r, ["app-server"]), { cwd });
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

export function createCodexProvider(version: string): Provider {
  return {
    id: "codex",
    name: "Codex",
    capabilities: codexCapabilities,
    async detect(): Promise<DetectResult> {
      const bin = await resolveBin("codex");
      if (!bin.ok) {
        return { available: false, reason: bin.reason, installHint: INSTALL_HINT };
      }
      try {
        const v = await runVersion(bin, ["--version"]);
        return { available: true, bin: bin.display, version: v.trim().split("\n")[0] || "" };
      } catch (e) {
        return { available: true, bin: bin.display, version: "", reason: String(e) };
      }
    },
    async listModels(): Promise<ModelInfo[]> {
      if (modelCache && Date.now() - modelCache.at < MODEL_CACHE_MS) return modelCache.models;
      const bin = await resolveBin("codex");
      if (!bin.ok) return [{ id: "", name: "默认" }];
      try {
        const models = await fetchModels(bin, process.cwd());
        modelCache = { at: Date.now(), models };
        return models;
      } catch (e) {
        // Gateway region errors etc. — the frontend shows a single "Default" entry (§7.3.6)
        log("warn", "codex model/list 失败", { err: String(e) });
        return [{ id: "", name: "默认" }];
      }
    },
    async createSession(o): Promise<ProviderSession> {
      const bin = await resolveBin("codex");
      if (!bin.ok) throw new Error(`找不到 codex：${bin.reason}`);
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
