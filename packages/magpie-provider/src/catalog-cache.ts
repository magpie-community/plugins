import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { type ModelInfo2, normalizeModelCosts } from './opencode.js';

/**
 * models.dev catalog, read the way Magpie reads it.
 *
 * Magpie fetches `models.dev/api.json`, keeps it in `~/.cache/magpie/models.json`,
 * uses OpenCode's `~/.cache/opencode/models.json` when its own is absent, treats it
 * as stale after a day, and looks again sooner when a model it cannot price appears.
 * This module mirrors that, so a model Magpie knows comes with a price here too.
 */

export const MODELS_DEV_URL = 'https://models.dev/api.json';

const DAY = 24 * 60 * 60 * 1000;
const MISSING_RETRY = 6 * 60 * 60 * 1000;

export type CatalogCost = {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
  tiers?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
    tier?: { type?: string; size?: number };
  }[];
};

export type CatalogModel = {
  id?: string;
  name?: string;
  cost?: CatalogCost;
  limit?: { context?: number; input?: number; output?: number };
  /** The "maker/model" a reseller's entry stands for, e.g. `deepseek/deepseek-v4.1-flash`. */
  canonical_model_id?: string;
};

export type ModelsDevCatalog = Record<
  string,
  { id?: string; name?: string; models?: Record<string, CatalogModel> }
>;

export type CatalogCache = {
  /** The cached catalog; absent when nothing readable exists yet. */
  data: ModelsDevCatalog | undefined;
  /** Absolute path of the file in use. */
  path: string;
  /** Whether `data` is older than the interval that applies. */
  stale: boolean;
};

/** Own writable cache, followed by read-only Magpie and OpenCode seed catalogs. */
export const cachePaths = (): string[] => {
  const cache = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  return [
    join(cache, 'opencode-magpie-plugin', 'models.json'),
    join(cache, 'magpie', 'models.json'),
    join(cache, 'opencode', 'models.json'),
  ];
};

const parse = (text: string): ModelsDevCatalog | undefined => {
  try {
    const data = JSON.parse(text) as ModelsDevCatalog;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
    const providers = Object.values(data);
    return providers.length &&
      providers.every(
        (p) =>
          p &&
          typeof p === 'object' &&
          p.models &&
          typeof p.models === 'object' &&
          !Array.isArray(p.models) &&
          Object.values(p.models).every((m) => m && typeof m === 'object'),
      )
      ? data
      : undefined;
  } catch {
    return undefined;
  }
};

export type CatalogSource = { path: string; age: number } | undefined;

/** First readable, valid catalog and its age; a corrupt file does not hide the seeds. */
export const catalogSource = async (): Promise<CatalogSource> => {
  for (const path of cachePaths()) {
    let age: number;
    try {
      const stats = await stat(path);
      if (!stats.isFile()) continue;
      if (!parse(await readFile(path, 'utf8'))) continue;
      age = Date.now() - stats.mtimeMs;
    } catch {
      continue;
    }
    return { path, age };
  }
  return undefined;
};

export const readCatalogCache = async (): Promise<CatalogCache> => {
  const [first] = cachePaths();
  const source = await catalogSource();
  if (!source) return { data: undefined, path: first, stale: true };
  const data = parse(await readFile(source.path, 'utf8').catch(() => ''));
  if (!data) return { data: undefined, path: source.path, stale: true };
  return { data, path: source.path, stale: source.age > DAY };
};

/** Download the catalog and write it atomically, leaving the previous file intact on failure. */
export const fetchCatalogCache = async (
  url = MODELS_DEV_URL,
  timeout = 30_000,
): Promise<CatalogCache> => {
  const path = cachePaths()[0];
  const response = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw new Error(`models.dev 返回 HTTP ${response.status}`);
  const text = await response.text();
  const data = parse(text);
  if (!data || Object.keys(data).length === 0) throw new Error('models.dev 返回了无效的模型目录');
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return { data, path, stale: false };
};

/** Read the cache and refresh it in the background when stale; discovery never waits on the network. */
const attempts = new Map<string, number>();
const pending = new Map<string, Promise<void>>();

export const loadCatalogCache = async (missing = false): Promise<CatalogCache> => {
  const cache = await readCatalogCache().catch(
    (): CatalogCache => ({ data: undefined, path: cachePaths()[0], stale: true }),
  );
  const path = cachePaths()[0];
  const due = cache.stale || (missing && missingPriceStale(await catalogSource()));
  if (
    due &&
    !pending.has(path) &&
    Date.now() - (attempts.get(path) ?? -Infinity) >= MISSING_RETRY
  ) {
    attempts.set(path, Date.now());
    const task = fetchCatalogCache()
      .then(() => {})
      .catch((error: unknown) => {
        console.warn(
          '[magpie] models.dev 价格目录刷新失败，继续使用本地缓存：',
          error instanceof Error ? error.message : String(error),
        );
      })
      .finally(() => {
        pending.delete(path);
      });
    pending.set(path, task);
  }
  return cache;
};

/** A model Magpie gave no price for: refetch sooner than a day, as Magpie does. */
export const missingPriceStale = (source: CatalogSource): boolean =>
  (source?.age ?? Infinity) > MISSING_RETRY;

const bareID = (id: string): string => {
  const slash = id.indexOf('/');
  return slash < 0 ? id : id.slice(slash + 1);
};

/** The price models.dev lists, expressed as OpenCode's cost array. */
export type CatalogPrice = {
  input: number;
  output: number;
  cache: { read: number; write: number };
  tiers?: Array<ModelInfo2['cost'][number]>;
};

export const catalogPrice = (cost: CatalogCost | undefined): CatalogPrice | undefined => {
  if (!cost || typeof cost.input !== 'number' || typeof cost.output !== 'number') return undefined;
  if (
    [cost.input, cost.output, cost.cache_read ?? 0, cost.cache_write ?? 0].some(
      (n) => typeof n !== 'number' || !Number.isFinite(n) || n < 0,
    )
  )
    return undefined;
  const [base, ...tiers] = normalizeModelCosts(cost);
  return { ...base, ...(tiers.length ? { tiers } : {}) };
};

/**
 * The price models.dev lists for a model, under the maker that sells it.
 *
 * The maker's own catalog is the only one read, so a reseller's tariff never
 * passes for the maker's. Matching follows models.dev's own links rather than
 * guessing by name:
 * 1. the maker's entry of that id;
 * 2. the maker's entry whose `canonical_model_id` is it, e.g. DeepSeek's
 *    `deepseek-flash` standing for `deepseek/deepseek-v4.1-flash`;
 * Known model prefixes may fall back to the maker's catalog. Conflicting
 * canonical entries and subscription-plan catalogs are not used for prices.
 */
export const lookupCatalogPrice = (
  catalog: ModelsDevCatalog | undefined,
  maker: string,
  modelID: string,
): CatalogPrice | undefined => {
  if (/(?:^|-)plan(?:-|$)/i.test(maker)) return undefined;
  const id = modelID.replace(/@\d+(?:k|m)$/i, '').toLowerCase();
  const own = priceInProvider(catalog, maker, id);
  if (own) return own;
  const vendor = /^(?:gpt-|o[134](?:-|$))/.test(id)
    ? 'openai'
    : id.startsWith('claude-')
      ? 'anthropic'
      : id.startsWith('deepseek-')
        ? 'deepseek'
        : id.startsWith('gemini-')
          ? 'google'
          : id.startsWith('grok-')
            ? 'xai'
            : id.startsWith('muse-')
              ? 'meta'
              : undefined;
  return vendor && vendor !== maker ? priceInProvider(catalog, vendor, id) : undefined;
};

const priceInProvider = (
  catalog: ModelsDevCatalog | undefined,
  maker: string,
  id: string,
): CatalogPrice | undefined => {
  const models = catalog?.[maker.toLowerCase()]?.models;
  if (!models) return undefined;
  const bare = bareID(id).toLowerCase();
  const canonical = `${maker.toLowerCase()}/${bare}`;
  const entries = Object.entries(models).map(([key, model]) => ({ ...model, id: model.id ?? key }));
  const exact = entries.find((model) => model.id.toLowerCase() === id);
  const price = catalogPrice(exact?.cost);
  if (price) return price;
  const matches = entries
    .filter((model) => model.canonical_model_id?.toLowerCase() === canonical)
    .map((model) => catalogPrice(model.cost));
  const prices = matches.filter((price) => price !== undefined);
  return prices.length &&
    prices.every((price) => JSON.stringify(price) === JSON.stringify(prices[0]))
    ? prices[0]
    : undefined;
};
