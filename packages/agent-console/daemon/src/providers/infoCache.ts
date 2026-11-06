// In-memory cache of Provider detection results and model lists.
// detect / listModels often have to start a CLI (seconds); without a cache every page open and model pick would wait.
import type { Provider, DetectResult, ModelInfo, LaunchCommand } from "./types.js";
import { PLACEHOLDER_MODEL_NAME } from "./types.js";
import { magpieConfigFingerprint, withMagpie } from "./magpieGateway.js";
import { launchKey } from "./launch.js";
import { tr } from "../util/i18n.js";


const DETECT_MS = 60 * 1000;
const MODELS_MS = 10 * 60 * 1000;
const STEP_TIMEOUT_MS = 15000;
// Fetching models may start an ACP session (Cursor launches slowly through PowerShell), so it gets a longer timeout
const MODELS_TIMEOUT_MS = 35000;

type Entry<T> = { at: number; value: T; fp?: string } | undefined;
const detects = new Map<string, Entry<DetectResult>>();
const models = new Map<string, Entry<ModelInfo[]>>();
// Concurrent requests for the same Provider share one in-flight detection
const inflightDetect = new Map<string, Promise<DetectResult>>();
const inflightModels = new Map<string, Promise<ModelInfo[]>>();

/** Extra provider-local caches (e.g. Codex's own 10-minute modelCache) cleared together with ours. */
const extraClearHooks = new Set<(id?: string) => void>();

export function registerProviderCacheClear(hook: (id?: string) => void): void {
  extraClearHooks.add(hook);
}

function withTimeout<T>(p: Promise<T>, ms: number, fb: T): Promise<T> {
  return Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fb), ms))]);
}

function fresh<T>(e: Entry<T>, ttl: number, fp?: string): e is { at: number; value: T; fp?: string } {
  if (!e || Date.now() - e.at >= ttl) return false;
  // Magpie / agent config changed on disk since we cached → treat as stale even inside the TTL
  if (fp !== undefined && e.fp !== undefined && e.fp !== fp) return false;
  return true;
}

function cacheKey(p: Provider, launch?: LaunchCommand): string {
  return launch ? `${p.id}\0${launchKey(launch)}` : p.id;
}

export async function cachedDetect(p: Provider, launch?: LaunchCommand): Promise<DetectResult> {
  const key = cacheKey(p, launch);
  const hit = detects.get(key);
  if (fresh(hit, DETECT_MS)) return hit.value;
  let job = inflightDetect.get(key);
  if (!job) {
    const timedOut: DetectResult = { available: false, reason: tr("provider.timeout") };
    job = withTimeout(
      p.detect(launch).catch((e): DetectResult => ({ available: false, reason: String((e as Error)?.message ?? e) })),
      STEP_TIMEOUT_MS,
      timedOut,
    ).then((v) => {
      // Don't cache a timeout; try again next time
      if (v !== timedOut) detects.set(key, { at: Date.now(), value: v });
      return v;
    }).finally(() => inflightDetect.delete(key));
    inflightDetect.set(key, job);
  }
  return job;
}

export async function cachedModels(p: Provider, launch?: LaunchCommand): Promise<ModelInfo[]> {
  const key = cacheKey(p, launch);
  const fp = await magpieConfigFingerprint(p.id).catch(() => "");
  const hit = models.get(key);
  if (fresh(hit, MODELS_MS, fp)) return hit.value;
  let job = inflightModels.get(key);
  if (!job) {
    job = withTimeout<ModelInfo[] | null>(p.listModels(launch).catch(() => []), MODELS_TIMEOUT_MS, null)
      .then(async (v) => {
        // Timeout: don't cache, fall back to the old value for now
        if (v === null) return models.get(key)?.value ?? [];
        // Agents behind the magpie gateway: fill in gateway models, the default model and thinking levels
        const list = await withMagpie(p.id, dropPlaceholder(v)).catch(() => dropPlaceholder(v));
        // Keep the pre-list fingerprint: a config change during listing must invalidate the next read.
        models.set(key, { at: Date.now(), value: list, fp });
        return list;
      })
      .finally(() => inflightModels.delete(key));
    inflightModels.set(key, job);
  }
  return job;
}

/** A list holding only our own "Default" placeholder (id=default, name "默认") counts as having no real models.
 *  An auto / Auto the Agent itself reports (e.g. Copilot) is a real option and is kept. */
export function dropPlaceholder(list: ModelInfo[]): ModelInfo[] {
  if (list.length === 1 && list[0].id === "default" && (list[0].name === "默认" || list[0].name === PLACEHOLDER_MODEL_NAME)) return [];
  return list;
}

/** Return the cached value immediately if there is one (may be stale), else undefined */
export function peekModels(id: string): ModelInfo[] | undefined {
  return models.get(id)?.value;
}

export function clearProviderCache(id?: string): void {
  if (id) {
    for (const m of [detects, models] as Map<string, unknown>[]) {
      for (const k of [...m.keys()]) if (k === id || k.startsWith(id + "\0")) m.delete(k);
    }
  } else {
    detects.clear();
    models.clear();
  }
  for (const hook of extraClearHooks) {
    try { hook(id); } catch { /* ignore */ }
  }
}
