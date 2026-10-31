// In-memory cache of Provider detection results and model lists.
// detect / listModels often have to start a CLI (seconds); without a cache every page open and model pick would wait.
import type { Provider, DetectResult, ModelInfo } from "./types.js";
import { withMagpie } from "./magpieGateway.js";

const DETECT_MS = 60 * 1000;
const MODELS_MS = 10 * 60 * 1000;
const STEP_TIMEOUT_MS = 15000;
// Fetching models may start an ACP session (Cursor launches slowly through PowerShell), so it gets a longer timeout
const MODELS_TIMEOUT_MS = 35000;

type Entry<T> = { at: number; value: T } | undefined;
const detects = new Map<string, Entry<DetectResult>>();
const models = new Map<string, Entry<ModelInfo[]>>();
// Concurrent requests for the same Provider share one in-flight detection
const inflightDetect = new Map<string, Promise<DetectResult>>();
const inflightModels = new Map<string, Promise<ModelInfo[]>>();

function withTimeout<T>(p: Promise<T>, ms: number, fb: T): Promise<T> {
  return Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fb), ms))]);
}

function fresh<T>(e: Entry<T>, ttl: number): e is { at: number; value: T } {
  return !!e && Date.now() - e.at < ttl;
}

export async function cachedDetect(p: Provider): Promise<DetectResult> {
  const hit = detects.get(p.id);
  if (fresh(hit, DETECT_MS)) return hit.value;
  let job = inflightDetect.get(p.id);
  if (!job) {
    job = withTimeout(
      p.detect().catch((e): DetectResult => ({ available: false, reason: String((e as Error)?.message ?? e) })),
      STEP_TIMEOUT_MS,
      { available: false, reason: "检测超时" },
    ).then((v) => {
      // Don't cache a timeout; try again next time
      if (v.reason !== "检测超时") detects.set(p.id, { at: Date.now(), value: v });
      return v;
    }).finally(() => inflightDetect.delete(p.id));
    inflightDetect.set(p.id, job);
  }
  return job;
}

export async function cachedModels(p: Provider): Promise<ModelInfo[]> {
  const hit = models.get(p.id);
  if (fresh(hit, MODELS_MS)) return hit.value;
  let job = inflightModels.get(p.id);
  if (!job) {
    job = withTimeout<ModelInfo[] | null>(p.listModels().catch(() => []), MODELS_TIMEOUT_MS, null)
      .then(async (v) => {
        // Timeout: don't cache, fall back to the old value for now
        if (v === null) return models.get(p.id)?.value ?? [];
        // Agents behind the magpie gateway: fill in gateway models, the default model and thinking levels
        const list = await withMagpie(p.id, dropPlaceholder(v)).catch(() => dropPlaceholder(v));
        models.set(p.id, { at: Date.now(), value: list });
        return list;
      })
      .finally(() => inflightModels.delete(p.id));
    inflightModels.set(p.id, job);
  }
  return job;
}

/** A list holding only our own "Default" placeholder (id=default, name "默认") counts as having no real models.
 *  An auto / Auto the Agent itself reports (e.g. Copilot) is a real option and is kept. */
export function dropPlaceholder(list: ModelInfo[]): ModelInfo[] {
  if (list.length === 1 && list[0].id === "default" && list[0].name === "默认") return [];
  return list;
}

/** Return the cached value immediately if there is one (may be stale), else undefined */
export function peekModels(id: string): ModelInfo[] | undefined {
  return models.get(id)?.value;
}

export function clearProviderCache(id?: string): void {
  if (id) {
    detects.delete(id);
    models.delete(id);
  } else {
    detects.clear();
    models.clear();
  }
}
