// ACP probe: start the Agent's ACP process once → initialize → session/new, read the models and thinking levels it reports, then close it.
// Sends no prompt and costs nothing. This is the Agent's own model list (as Paseo does), more reliable than parsing CLI text.
import { tmpdir } from "node:os";
import type { ModelInfo } from "../types.js";
import type { ResolveResult } from "../../util/bin.js";
import { spawnResolved, killAcpChild } from "./spawn.js";
import { log } from "../../log.js";

type SelectOption = { value?: unknown; name?: unknown; options?: SelectOption[] };
type ConfigOption = { id?: string; category?: string; type?: string; currentValue?: unknown; options?: SelectOption[] };

export type AcpProbeResult = {
  models: { id: string; name: string }[];
  currentModel: string | null;
  thinking: { id: string; label: string }[];
  currentThinking: string | null;
};

function flatten(opts: SelectOption[] | undefined): { id: string; name: string }[] {
  const out: { id: string; name: string }[] = [];
  for (const o of opts ?? []) {
    if (o.options) out.push(...flatten(o.options));
    else if (typeof o.value === "string" && o.value) {
      out.push({ id: o.value, name: typeof o.name === "string" && o.name ? o.name : o.value });
    }
  }
  // Dedupe (Copilot reports auto twice)
  return out.filter((m, i) => out.findIndex((x) => x.id === m.id) === i);
}

/** Extract models and thinking levels from a session/new response (pure function, easy to test) */
export function parseAcpSession(res: { configOptions?: ConfigOption[]; models?: { currentModelId?: string; availableModels?: { modelId?: string; name?: string }[] } }): AcpProbeResult {
  const opts = res.configOptions ?? [];
  const modelOpt = opts.find((o) => o.type === "select" && (o.category === "model" || o.id === "model"));
  const thoughtOpt = opts.find((o) => o.type === "select" && (o.category === "thought_level" || o.id === "thought_level"));
  let models = flatten(modelOpt?.options);
  let currentModel = typeof modelOpt?.currentValue === "string" ? modelOpt.currentValue : null;
  if (!models.length && res.models?.availableModels?.length) {
    models = res.models.availableModels
      .filter((m) => typeof m.modelId === "string" && m.modelId)
      .map((m) => ({ id: m.modelId!, name: m.name || m.modelId! }));
    models = models.filter((m, i) => models.findIndex((x) => x.id === m.id) === i);
    currentModel = res.models.currentModelId ?? currentModel;
  }
  const thinking = flatten(thoughtOpt?.options).map((t) => ({ id: t.id, label: t.name }));
  const currentThinking = typeof thoughtOpt?.currentValue === "string" ? thoughtOpt.currentValue : null;
  return { models, currentModel, thinking, currentThinking };
}

export function probeAcp(r: ResolveResult & { ok: true }, acpArgs: string[], timeoutMs = 30000): Promise<AcpProbeResult> {
  return probeAcpRaw(r, acpArgs, timeoutMs).then((x) => x.parsed);
}

/** Like probeAcp, but also calls an Agent-specific method after session/new (e.g. Cursor's cursor/list_available_models) */
export function probeAcpRaw(
  r: ResolveResult & { ok: true },
  acpArgs: string[],
  timeoutMs = 30000,
  extMethod?: string,
): Promise<{ parsed: AcpProbeResult; ext: unknown }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawnResolved(r, acpArgs, { cwd: tmpdir() });
    let buf = "";
    let nextId = 0;
    const pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>();
    let done = false;
    const finish = (err: Error | null, v?: { parsed: AcpProbeResult; ext: unknown }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      void killAcpChild(child).catch(() => {});
      if (err) reject(err);
      else resolvePromise(v!);
    };
    const timer = setTimeout(() => finish(new Error("ACP 探测超时")), timeoutMs);
    const send = (method: string, params: unknown) =>
      new Promise<unknown>((res, rej) => {
        const id = ++nextId;
        pending.set(id, { res, rej });
        child.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    child.on("error", (e) => finish(e));
    child.on("close", () => finish(new Error("ACP 进程提前退出")));
    child.stderr?.on("data", () => {});
    child.stdout?.on("data", (d: Buffer) => {
      buf += d.toString();
      let n: number;
      while ((n = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, n).trim();
        buf = buf.slice(n + 1);
        if (!line) continue;
        let m: { id?: number; method?: string; result?: unknown; error?: unknown };
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.id !== undefined && !m.method && pending.has(m.id)) {
          const p = pending.get(m.id)!;
          pending.delete(m.id);
          if (m.error) p.rej(new Error(JSON.stringify(m.error)));
          else p.res(m.result);
        } else if (m.id !== undefined && m.method) {
          // Requests from the Agent (shouldn't happen during a probe): always answer empty so it doesn't hang
          child.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: null }) + "\n");
        }
      }
    });
    void (async () => {
      try {
        await send("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "Agent Console", version: "probe" } });
        const res = (await send("session/new", { cwd: tmpdir(), mcpServers: [] })) as Parameters<typeof parseAcpSession>[0];
        let ext: unknown = null;
        if (extMethod) ext = await send(extMethod, {}).catch(() => null);
        finish(null, { parsed: parseAcpSession(res ?? {}), ext });
      } catch (e) {
        finish(e instanceof Error ? e : new Error(String(e)));
      }
    })();
  });
}

/** Probe result → model list: the current model is the default; thinking levels hang on the current model (other models' levels are only known after switching, so reuse the same set for now) */
export function probeToModels(p: AcpProbeResult): ModelInfo[] {
  return p.models.map((m) => ({
    id: m.id,
    name: m.name,
    isDefault: m.id === p.currentModel,
    ...(p.thinking.length
      ? { thinkingOptions: p.thinking, defaultThinking: p.currentThinking ?? undefined }
      : {}),
  }));
}

const EFFORT_LABEL: Record<string, string> = {
  none: "None", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra High", max: "Max",
};

type CursorCatalog = {
  models?: { value?: string; name?: string; configOptions?: ConfigOption[] }[];
};

/**
 * Cursor: a model's thinking levels are not in the session-level thought_level but in each model's own parameter (effort / reasoning_effort / reasoning).
 * Following Paseo's resolveCursorCatalogModels: call Cursor's extension method cursor/list_available_models to get each model's parameter definitions.
 * The model id is the base name without parameters (grok-4.6); thinkingParam records the level parameter name, sent as grok-4.6[effort=high].
 */
export function cursorCatalogToModels(catalog: CursorCatalog, currentModel: string | null): ModelInfo[] {
  const currentBase = currentModel?.replace(/\[.*\]$/u, "") ?? null;
  const out: ModelInfo[] = [];
  for (const m of catalog.models ?? []) {
    if (typeof m.value !== "string" || !m.value) continue;
    const id = m.value.replace(/\[.*\]$/u, "");
    const thought = (m.configOptions ?? []).find((o) => o.category === "thought_level");
    const levels = flatten(thought?.options);
    out.push({
      id,
      name: typeof m.name === "string" && m.name ? m.name : id,
      isDefault: id === currentBase,
      ...(thought && levels.length
        ? {
            thinkingOptions: levels.map((l) => ({ id: l.id, label: EFFORT_LABEL[l.id] ?? l.name })),
            defaultThinking: typeof thought.currentValue === "string" ? thought.currentValue : undefined,
            thinkingParam: thought.id,
          }
        : {}),
    });
  }
  return out;
}

export function cursorProbeModels(acpArgs: string[]) {
  return async (r: ResolveResult & { ok: true }): Promise<ModelInfo[]> => {
    try {
      const { parsed, ext } = await probeAcpRaw(r, acpArgs, 40000, "cursor/list_available_models");
      const fromCatalog = ext ? cursorCatalogToModels(ext as CursorCatalog, parsed.currentModel) : [];
      // If the extension method is unavailable (older Cursor CLI), fall back to the model list reported by the session (no levels)
      return fromCatalog.length ? fromCatalog : probeToModels(parsed);
    } catch (e) {
      log("warn", "Cursor 模型探测失败", { err: String(e) });
      return [];
    }
  };
}

export function acpProbeModels(acpArgs: string[]) {
  return async (r: ResolveResult & { ok: true }): Promise<ModelInfo[]> => {
    try {
      return probeToModels(await probeAcp(r, acpArgs));
    } catch (e) {
      log("warn", "ACP 探测模型失败", { err: String(e) });
      return [];
    }
  };
}
