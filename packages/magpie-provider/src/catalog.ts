import { lookupCatalogPrice, type ModelsDevCatalog } from './catalog-cache.js';
import type { ModelPricingProvider } from './model-pricing.js';
import { getModelPricing, resolveModelPricingKey } from './model-pricing.js';
import {
  type ModelInfo2,
  normalizeModelCosts,
  type ProviderInfo,
  toClassicModelInfo,
} from './opencode.js';

export type MagpieModel = {
  id: string;
  owned_by: string;
  display_name?: string;
  magpie_label?: string;
  context_window?: number;
  max_output_tokens?: number;
  native_endpoints?: string[];
  reasoning?: boolean;
  reasoning_levels?: string[];
  supported_reasoning_levels?: (string | { effort: string })[];
  service_tiers?: (string | { id: string })[];
  modalities?: { input?: string[]; output?: string[] };
  kind?: string;
  magpie_price?: {
    input: number;
    output: number;
    cache_read?: number;
    cache_write?: number;
    tiers?: {
      above: number;
      input?: number;
      output?: number;
      cache_read?: number;
      cache_write?: number;
    }[];
  };
};

export type Inventory = { info: ProviderInfo; models: ModelInfo2[] }[];

/** Whether any model Magpie lists has no price in any source, which asks for a fresher catalog. */
export const hasUnpricedModel = (inventory: Inventory): boolean =>
  inventory.some((entry) => entry.models.some((model) => model.cost.length === 0));

/** Routing groups are named by their own source rather than by a member vendor. */
const routingGroupName = (source: string): string | undefined =>
  source === 'group' ? 'Group' : source === 'auto' ? 'Auto' : undefined;

const routingGroupKey = (id: string): string | undefined => {
  if (id.startsWith('group/')) return id.slice('group/'.length);
  // Keep Auto Group presentation prefixes separate from vendor model IDs.
  if (id.startsWith('auto/')) return `auto-${id.slice('auto/'.length)}`;
  return undefined;
};

const reasoningVariants = (row: MagpieModel, anthropic: boolean): ModelInfo2['variants'] => {
  if (row.reasoning === false) return [];
  const levels =
    row.reasoning_levels ??
    row.supported_reasoning_levels?.map((level) =>
      typeof level === 'string' ? level : level.effort,
    ) ??
    [];
  return [...new Set(levels)]
    .filter((effort) => effort && effort !== 'default')
    .map((effort) => ({
      id: effort,
      settings: anthropic
        ? effort === 'none'
          ? { thinking: { type: 'disabled' } }
          : { thinking: { type: 'adaptive' }, effort }
        : { reasoningEffort: effort },
    }));
};

const pricingProvider = (owner: string): ModelPricingProvider | undefined => {
  const id = owner.toLowerCase();
  if (id === 'workbuddy') return 'codebuddy';
  return (['astra', 'boxai', 'codebuddy', 'cursor', 'imate', 'kalm'] as const).find(
    (provider) => provider === id,
  );
};

const normalizeProviderName = (name: string): string =>
  name.replace(/\bremote[- ]magpie\b/gi, 'Remote Magpie');

const providerName = (model: MagpieModel): string => {
  const label = model.magpie_label?.split(' · ').slice(1).join(' · ');
  return normalizeProviderName(
    label ||
      (({ cursor: 'Cursor', workbuddy: 'WorkBuddy' } as Record<string, string>)[model.owned_by] ??
        model.owned_by),
  );
};

const nestedProvider = (row: MagpieModel): { id: string; name: string } | undefined => {
  const prefix = `${row.owned_by}/`;
  if (!row.id.startsWith(prefix)) return;
  const remainder = row.id.slice(prefix.length);
  const slash = remainder.indexOf('/');
  if (slash <= 0 || slash === remainder.length - 1) return;
  const source = remainder.slice(0, slash);
  // The gateway suffix already contains Magpie; distinguish Group and Auto without repeating it.
  const routing = routingGroupName(source);
  const parts = row.magpie_label?.split(' · ') ?? [];
  if (routing) {
    return {
      id: `${row.owned_by}/${source}`,
      name: `${routing} · ${normalizeProviderName(parts.length === 3 ? parts[2] : providerName(row))}`,
    };
  }
  const label = providerName(row);
  const sourceName = providerName({ id: source, owned_by: source });
  return {
    id: `${row.owned_by}/${source}`,
    name: parts.length === 3 ? label : `${sourceName} · ${label}`,
  };
};

/** Magpie writes context windows as `Claude Opus 5.5 @ 1m`. The picker shows `@1m`. */
export const displayName = (name: string): string => name.replace(/@\s+(\d+(?:k|m))/gi, '@$1');

/**
 * How much a model is trusted to cost, in the order Magpie looks for a price:
 * the built-in table, then Magpie's own price, then the models.dev catalog.
 * Routing groups take Magpie's price only; their members are what Magpie routes to.
 */
export type PriceSource = 'builtin' | 'magpie' | 'models.dev' | 'none';

/** One routing-group bucket. Membership stays in Magpie; this only places matching rows. */
export type GroupBucket = {
  prefix: string;
  id: string;
  name: string;
};

/**
 * How the catalog is shown. Empty groups and order keep group/ and auto/ on their default
 * providers. Nothing here names a real routing group. Which models are
 * listed at all is Magpie's call (`magpie visible`, `magpie group rm`), not this plugin's.
 */
export type CatalogPresentation = {
  groups: readonly GroupBucket[];
  /** Final provider id → final model id → time.released. Earlier order entries are larger. */
  order: ReadonlyMap<string, ReadonlyMap<string, number>>;
};

export type InventoryOptions = {
  apiKey?: string;
  agentID?: string;
  /** The cached models.dev catalog, for models neither the built-in table nor Magpie prices. */
  catalog?: ModelsDevCatalog;
  fastModelIDs?: ReadonlySet<string>;
  /** Parsed once at setup and reused by the refresh. Omitted means an empty presentation. */
  presentation?: CatalogPresentation;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const invalidOptions = (path: string, reason: string): Error =>
  new Error(`Magpie 插件的 options 无效（opencode.jsonc → plugins → ${path}）：${reason}。`);

const requiredString = (value: unknown, path: string): string => {
  if (typeof value !== 'string' || value.length === 0)
    throw invalidOptions(path, '必须是非空字符串');
  return value;
};

const parseGroups = (value: unknown): GroupBucket[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalidOptions('options.groups', '必须是数组');
  return value.map((entry, index) => {
    const path = `options.groups[${index}]`;
    if (!isRecord(entry)) throw invalidOptions(path, '必须是对象');
    for (const key of Object.keys(entry)) {
      if (key !== 'prefix' && key !== 'id' && key !== 'name')
        throw invalidOptions(`${path}.${key}`, '不是已知字段');
    }
    return {
      prefix: requiredString(entry.prefix, `${path}.prefix`),
      id: requiredString(entry.id, `${path}.id`),
      name: requiredString(entry.name, `${path}.name`),
    };
  });
};

const parseOrder = (value: unknown): Map<string, Map<string, number>> => {
  if (value === undefined) return new Map();
  if (!isRecord(value)) throw invalidOptions('options.order', '必须是对象');
  const order = new Map<string, Map<string, number>>();
  for (const [providerID, ids] of Object.entries(value)) {
    const path = `options.order.${providerID}`;
    if (!Array.isArray(ids)) throw invalidOptions(path, '必须是模型 id 数组');
    const weights = new Map<string, number>();
    for (const [index, id] of ids.entries()) {
      const modelID = requiredString(id, `${path}[${index}]`);
      // The first mention wins, so a repeated id does not sink below models listed after it.
      if (!weights.has(modelID)) weights.set(modelID, 1000 - index * 10);
    }
    order.set(providerID, weights);
  }
  return order;
};

/** Read presentation once. Invalid options fail startup instead of being skipped. */
export const parsePresentation = (options: unknown): CatalogPresentation => {
  if (options === undefined) return { groups: [], order: new Map() };
  if (!isRecord(options)) throw invalidOptions('options', '必须是对象');
  for (const key of Object.keys(options)) {
    if (key !== 'groups' && key !== 'order' && key !== 'remote' && key !== 'agentID')
      throw invalidOptions(`options.${key}`, '不是已知字段');
  }
  return {
    groups: parseGroups(options.groups),
    order: parseOrder(options.order),
  };
};

const modelCost = (
  row: MagpieModel,
  group: boolean,
  catalog: ModelsDevCatalog | undefined,
): { cost: unknown; source: PriceSource } => {
  const modelID = row.id.slice(row.id.indexOf('/') + 1);
  const pricingID = modelID.replace(/@\d+(?:k|m)$/i, '');
  const builtin = group ? undefined : getModelPricing(pricingID, pricingProvider(row.owned_by));
  if (builtin) return { cost: builtin, source: 'builtin' };
  if (row.magpie_price) return { cost: row.magpie_price, source: 'magpie' };
  const listed = group ? undefined : lookupCatalogPrice(catalog, row.owned_by, pricingID);
  if (listed) return { cost: listed, source: 'models.dev' };
  return { cost: undefined, source: 'none' };
};

export const buildInventory = (
  rows: MagpieModel[],
  baseURL: string,
  options: InventoryOptions = {},
): Inventory => {
  const providers = new Map<string, Inventory[number]>();
  const apiKey = options.apiKey ?? 'magpie';
  const fastModelIDs = new Set(options.fastModelIDs);
  const presentation = options.presentation ?? { groups: [], order: new Map() };
  // Longest prefix wins, so a narrower bucket is not swallowed by a shorter one declared first.
  const buckets = [...presentation.groups].sort(
    (left, right) => right.prefix.length - left.prefix.length,
  );
  for (const row of rows) {
    if (
      row.service_tiers?.some((tier) => (typeof tier === 'string' ? tier : tier.id) === 'priority')
    )
      fastModelIDs.add(row.id);
  }
  rows
    .filter((row) => !row.kind && row.id.includes('/'))
    .forEach((row) => {
      const source = row.id.slice(0, row.id.indexOf('/'));
      const groupKey = routingGroupKey(row.id);
      const group = groupKey !== undefined;
      const bucket = groupKey
        ? // A prefix must leave a model id behind; a bare `group/adams-` stays on magpie-group.
          buckets.find(
            (entry) => groupKey.length > entry.prefix.length && groupKey.startsWith(entry.prefix),
          )
        : undefined;
      const nested = group ? undefined : nestedProvider(row);
      const owner = group ? (bucket?.id ?? source) : (nested?.id ?? row.owned_by);
      // Names are the Magpie groups; IDs are namespaced so an existing Cursor plugin is not replaced.
      const providerID = `magpie-${encodeURIComponent(owner)}`;
      // A matched bucket drops its prefix from the picker id. The wire id stays the gateway row.
      const modelID =
        bucket && groupKey
          ? groupKey.slice(bucket.prefix.length)
          : (groupKey ?? row.id.slice(row.id.indexOf('/') + 1));
      const { cost } = modelCost(row, group, options.catalog);

      const model = toClassicModelInfo(providerID, modelID, {
        id: row.id,
        name: displayName(row.display_name ?? modelID),
        cost,
        limit: {
          context: row.context_window || 256_000,
          output: row.max_output_tokens || 32_000,
        },
        modalities: row.modalities,
        tool_call: true,
      });
      // A missing price is not a reason to hide the model. Leave cost empty so it is not
      // reported as free, and keep it selectable. Routing groups often have no single price
      // because members differ; they stay listed the same way.
      const anthropic = row.native_endpoints?.includes('/v1/messages');
      const responses = !anthropic && row.native_endpoints?.includes('/v1/responses');
      model.package = anthropic
        ? '@opencode/ai/providers/anthropic-compatible'
        : responses
          ? '@opencode/ai/providers/openai-compatible/responses'
          : '@opencode/ai/providers/openai-compatible';
      model.settings = {
        baseURL,
        apiKey,
        transport: 'http',
      };
      model.variants = reasoningVariants(row, !!anthropic);
      // Written before the Fast clone so a spread copies the parent's weight. A -fast id
      // keeps 0 unless that exact id is itself in the order list.
      model.time = { released: presentation.order.get(providerID)?.get(model.id) ?? 0 };
      const entry = providers.get(providerID) ?? {
        info: {
          id: providerID,
          name: bucket
            ? bucket.name
            : group
              ? `Magpie ${routingGroupName(source)}`
              : (nested?.name ?? providerName(row)),
          activation: 'enabled' as const,
          package: '@opencode/ai/providers/openai-compatible',
          settings: {
            baseURL,
            apiKey,
            transport: 'http',
          },
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'X-Magpie-Agent': options.agentID ?? 'opencode',
          },
        },
        models: [],
      };
      if (!entry.models.some((existing) => existing.id === model.id)) entry.models.push(model);
      providers.set(providerID, entry);
    });
  return [...providers.values()].map((entry) => {
    const ids = new Set(entry.models.map((model) => model.id));
    return {
      ...entry,
      models: entry.models.flatMap((model) => {
        if (
          !fastModelIDs.has(model.modelID) ||
          /-fast(?:@\d+[km])?$/i.test(model.id) ||
          ids.has(`${model.id}-fast`)
        )
          return [model];
        const row = rows.find((row) => row.id === model.modelID);
        const fastKey = `${model.id.replace(/@\d+(?:k|m)$/i, '')}-fast`;
        const fastPrice =
          row &&
          routingGroupKey(row.id) === undefined &&
          resolveModelPricingKey(fastKey)?.endsWith('-fast')
            ? getModelPricing(fastKey, pricingProvider(row.owned_by))
            : undefined;
        return [
          model,
          {
            ...model,
            id: `${model.id}-fast`,
            cost: fastPrice ? normalizeModelCosts(fastPrice) : model.cost,
            name: `${model.name} Fast`,
            body: { ...model.body, service_tier: 'priority' },
          },
        ];
      }),
    };
  });
};
