// src/index.ts
import { fileURLToPath } from "node:url";

// src/call-ids.ts
import { createHash } from "node:crypto";
var normalizeOpenAICallIDs = ({ messages }) => {
  for (const message of messages) {
    for (const part of message.content) {
      if (part.type !== "tool-call" && part.type !== "tool-result")
        continue;
      if (typeof part.id !== "string" || part.id.length <= 64)
        continue;
      part.id = `call_${createHash("sha256").update(part.id).digest("base64url")}`;
    }
  }
};

// src/catalog-cache.ts
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// src/opencode.ts
var createTrackedSetup = () => {
  const registrations = [];
  return {
    track: async (registration) => {
      registrations.push(await registration);
    },
    cleanup: async () => {
      await registrations.splice(0).reverse().reduce(async (previous, registration) => {
        await previous;
        await registration.dispose().catch(() => {});
      }, Promise.resolve());
    }
  };
};
var reloadProviderCatalog = async (ctx) => {
  await ctx.provider?.reload();
};
var normalizeModelCosts = (cost) => {
  if (!cost || typeof cost !== "object")
    return [];
  const value = cost;
  if (typeof value.input !== "number" || !Number.isFinite(value.input) || typeof value.output !== "number" || !Number.isFinite(value.output))
    return [];
  const base = {
    input: value.input,
    output: value.output,
    cache: {
      read: value.cache?.read ?? value.cache_read ?? 0,
      write: value.cache?.write ?? value.cache_write ?? 0
    }
  };
  const valid = (rate) => typeof rate === "number" && Number.isFinite(rate) && rate >= 0;
  if (![base.input, base.output, base.cache.read, base.cache.write].every(valid))
    return [];
  const result = [base];
  for (const raw of Array.isArray(value.tiers) ? value.tiers : []) {
    if (!raw || typeof raw !== "object")
      continue;
    const entry = raw;
    const size = entry.tier ? entry.tier.type === "context" ? entry.tier.size : undefined : entry.above;
    if (!valid(size) || !Number.isInteger(size))
      continue;
    const rates = {
      input: entry.input ?? base.input,
      output: entry.output ?? base.output,
      cache: {
        read: entry.cache?.read ?? entry.cache_read ?? base.cache.read,
        write: entry.cache?.write ?? entry.cache_write ?? base.cache.write
      }
    };
    if (![rates.input, rates.output, rates.cache.read, rates.cache.write].every(valid))
      continue;
    result.push({ ...rates, tier: { type: "context", size } });
  }
  return result;
};
var toClassicModelInfo = (providerID, catalogID, entry) => ({
  id: catalogID,
  modelID: entry.id,
  providerID,
  name: entry.name,
  capabilities: {
    tools: entry.tool_call !== false,
    input: entry.modalities?.input?.length ? entry.modalities.input : ["text"],
    output: entry.modalities?.output?.length ? entry.modalities.output : ["text"]
  },
  limit: { ...entry.limit },
  variants: [],
  status: "active",
  enabled: true,
  time: { released: 0 },
  cost: normalizeModelCosts(entry.cost)
});

// src/catalog-cache.ts
var MODELS_DEV_URL = "https://models.dev/api.json";
var DAY = 24 * 60 * 60 * 1000;
var MISSING_RETRY = 6 * 60 * 60 * 1000;
var cachePaths = () => {
  const cache = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return [
    join(cache, "opencode-magpie-plugin", "models.json"),
    join(cache, "magpie", "models.json"),
    join(cache, "opencode", "models.json")
  ];
};
var parse = (text) => {
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== "object" || Array.isArray(data))
      return;
    const providers = Object.values(data);
    return providers.length && providers.every((p) => p && typeof p === "object" && p.models && typeof p.models === "object" && !Array.isArray(p.models) && Object.values(p.models).every((m) => m && typeof m === "object")) ? data : undefined;
  } catch {
    return;
  }
};
var catalogSource = async () => {
  for (const path of cachePaths()) {
    let age;
    try {
      const stats = await stat(path);
      if (!stats.isFile())
        continue;
      if (!parse(await readFile(path, "utf8")))
        continue;
      age = Date.now() - stats.mtimeMs;
    } catch {
      continue;
    }
    return { path, age };
  }
  return;
};
var readCatalogCache = async () => {
  const [first] = cachePaths();
  const source = await catalogSource();
  if (!source)
    return { data: undefined, path: first, stale: true };
  const data = parse(await readFile(source.path, "utf8").catch(() => ""));
  if (!data)
    return { data: undefined, path: source.path, stale: true };
  return { data, path: source.path, stale: source.age > DAY };
};
var fetchCatalogCache = async (url = MODELS_DEV_URL, timeout = 30000) => {
  const path = cachePaths()[0];
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(timeout) });
  if (!response.ok)
    throw new Error(`models.dev 返回 HTTP ${response.status}`);
  const text = await response.text();
  const data = parse(text);
  if (!data || Object.keys(data).length === 0)
    throw new Error("models.dev 返回了无效的模型目录");
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
var attempts = new Map;
var pending = new Map;
var loadCatalogCache = async (missing = false, online = false) => {
  const cache = await readCatalogCache().catch(() => ({ data: undefined, path: cachePaths()[0], stale: true }));
  if (!online)
    return cache;
  const path = cachePaths()[0];
  const due = cache.stale || missing && missingPriceStale(await catalogSource());
  if (due && !pending.has(path) && Date.now() - (attempts.get(path) ?? -Infinity) >= MISSING_RETRY) {
    attempts.set(path, Date.now());
    const task = fetchCatalogCache().then(() => {}).catch((error) => {
      console.warn("[magpie] models.dev 价格目录刷新失败，继续使用本地缓存：", error instanceof Error ? error.message : String(error));
    }).finally(() => {
      pending.delete(path);
    });
    pending.set(path, task);
  }
  return cache;
};
var missingPriceStale = (source) => (source?.age ?? Infinity) > MISSING_RETRY;
var bareID = (id) => {
  const slash = id.indexOf("/");
  return slash < 0 ? id : id.slice(slash + 1);
};
var catalogPrice = (cost) => {
  if (!cost || typeof cost.input !== "number" || typeof cost.output !== "number")
    return;
  if ([cost.input, cost.output, cost.cache_read ?? 0, cost.cache_write ?? 0].some((n) => typeof n !== "number" || !Number.isFinite(n) || n < 0))
    return;
  const [base, ...tiers] = normalizeModelCosts(cost);
  return { ...base, ...tiers.length ? { tiers } : {} };
};
var lookupCatalogPrice = (catalog, maker, modelID) => {
  if (/(?:^|-)plan(?:-|$)/i.test(maker))
    return;
  const id = modelID.replace(/@\d+(?:k|m)$/i, "").toLowerCase();
  const own = priceInProvider(catalog, maker, id);
  if (own)
    return own;
  const vendor = /^(?:gpt-|o[134](?:-|$))/.test(id) ? "openai" : id.startsWith("claude-") ? "anthropic" : id.startsWith("deepseek-") ? "deepseek" : id.startsWith("gemini-") ? "google" : id.startsWith("grok-") ? "xai" : id.startsWith("muse-") ? "meta" : undefined;
  return vendor && vendor !== maker ? priceInProvider(catalog, vendor, id) : undefined;
};
var priceInProvider = (catalog, maker, id) => {
  const models = catalog?.[maker.toLowerCase()]?.models;
  if (!models)
    return;
  const bare = bareID(id).toLowerCase();
  const canonical = `${maker.toLowerCase()}/${bare}`;
  const entries = Object.entries(models).map(([key, model]) => ({ ...model, id: model.id ?? key }));
  const exact = entries.find((model) => model.id.toLowerCase() === id);
  const price = catalogPrice(exact?.cost);
  if (price)
    return price;
  const matches = entries.filter((model) => model.canonical_model_id?.toLowerCase() === canonical).map((model) => catalogPrice(model.cost));
  const prices = matches.filter((price2) => price2 !== undefined);
  return prices.length && prices.every((price2) => JSON.stringify(price2) === JSON.stringify(prices[0])) ? prices[0] : undefined;
};

// src/model-pricing.ts
var MODEL_PRICING_ALIASES = {
  "claude-opus-4-6": "claude-opus-4.6",
  "claude-opus-4-7": "claude-opus-4.7",
  "claude-opus-4-8": "claude-opus-4.8",
  "claude-opus-5-5": "claude-opus-5.5",
  "claude-opus-4.6-1m": "claude-opus-4.6",
  "claude-opus-4.7-1m": "claude-opus-4.7",
  "claude-opus-4.8-1m": "claude-opus-4.8",
  "claude-opus-5.5-1m": "claude-opus-5.5",
  "claude-sonnet-4-6": "claude-sonnet-4.6",
  "claude-sonnet-4.6-1m": "claude-sonnet-4.6",
  "claude-sonnet-5-1m": "claude-sonnet-5",
  "deepseek-v3-2": "deepseek-v3.2",
  "deepseek-v3-2-volc-ioa": "deepseek-v3.2",
  "deepseek-v4-flash-external": "deepseek-v4-flash",
  "deepseek-v4-flash-official": "deepseek-v4-flash",
  "deepseek-v4-flash-ioa": "deepseek-v4-flash",
  "deepseek-v4-flash-0731": "deepseek-v4-flash",
  "deepseek-v4.1-flash": "deepseek-v4-flash",
  "deepseek-v4-flash-vision-exp": "deepseek-v4-flash",
  "deepseek-v4-pro-external": "deepseek-v4-pro",
  "deepseek-v4-pro-official": "deepseek-v4-pro",
  "deepseek-v4-pro-ioa": "deepseek-v4-pro",
  "gemini-3-1-pro": "gemini-3.1-pro",
  "gemini-3-5-flash": "gemini-3.5-flash",
  "glm-5-1": "glm-5.1",
  "glm-5-2-internal": "glm-5.2",
  "glm-5-3-internal": "glm-5.3",
  "glm-5-3-flash-internal": "glm-5.3-flash",
  "glm-5.1-external": "glm-5.1",
  "glm-5.2-external": "glm-5.2",
  "glm-5-1-ioa": "glm-5.1",
  "glm-5-2-ioa": "glm-5.2",
  "glm-5.0-ioa": "glm-5.0",
  "glm-4.6-ioa": "glm-4.6",
  "glm-4.6v-ioa": "glm-4.6v",
  "glm-4.7-ioa": "glm-4.7",
  "glm-5-fp8-ioa": "glm-5-fp8",
  "glm-5v-turbo-ioa": "glm-5v-turbo",
  "glm-5-turbo-external": "glm-5-turbo",
  "glm-5v-turbo": "glm-5v-turbo",
  "gpt-5-4": "gpt-5.4",
  "gpt-5-4-mini": "gpt-5.4-mini",
  "gpt-5-4-nano": "gpt-5.4-nano",
  "gpt-5-5": "gpt-5.5",
  "gpt-5-6-sol": "gpt-5.6-sol",
  "gpt-5-6-terra": "gpt-5.6-terra",
  "gpt-5-6-luna": "gpt-5.6-luna",
  "gpt-6-1-sol": "gpt-6.1-sol",
  "hy3-ioa": "hy-3",
  hy3: "hy-3",
  "hy-4-preview": "hy4-preview",
  "kimi-k2.6-external": "kimi-k2.6",
  "kimi-k2.6-ioa": "kimi-k2.6",
  "minimax-m2.5-ioa": "minimax-m2.5",
  "minimax-m2.7-ioa": "minimax-m2.7",
  "minimax-m3-external": "minimax-m3",
  "cursor-grok-4.5": "grok-4.5",
  "cursor-grok-4.7": "grok-4.7"
};
var PROVIDER_MODEL_SUFFIXES = ["-external", "-internal", "-ioa", "-official"];
var CAPABILITY_SUFFIXES = ["-fast"];
var CONTEXT_SUFFIX_REGEX = /-(\d+)(k|m)$/i;
var stripContextSuffixes = (key) => key.replace(CONTEXT_SUFFIX_REGEX, "");
var MODEL_PRICINGS = {
  "claude-haiku-4.5": {
    default: { input: 1, output: 5 },
    providers: {
      cursor: { input: 1, output: 5.25, cache: { read: 0.35, write: 1.5 } }
    }
  },
  "claude-sonnet-4.6": {
    default: { input: 3, output: 15 },
    providers: {
      boxai: { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
      cursor: { input: 3, output: 15.25, cache: { read: 0.55, write: 4 } }
    }
  },
  "claude-sonnet-5": {
    default: { input: 3, output: 15 },
    providers: {
      cursor: { input: 3, output: 15, cache: { read: 0.45, write: 2.75 } }
    }
  },
  "claude-sonnet-5.5": {
    default: { input: 3, output: 15 }
  },
  "claude-opus-4.5": {
    default: { input: 5, output: 25, cache: { read: 0.5, write: 6.25 } }
  },
  "claude-opus-4.6": {
    default: { input: 5, output: 25, cache: { read: 0.5, write: 6.25 } },
    providers: {
      boxai: { input: 5, output: 25, cache: { read: 0.5, write: 6.25 } },
      cursor: { input: 5, output: 25, cache: { read: 0.75, write: 6.5 } }
    }
  },
  "claude-opus-4.7": {
    default: { input: 5, output: 25, cache: { read: 0.5, write: 6.25 } },
    providers: {
      boxai: { input: 5, output: 25, cache: { read: 0.5, write: 6.25 } }
    }
  },
  "claude-opus-4.8": {
    default: { input: 5, output: 25, cache: { read: 0.5, write: 6.25 } },
    providers: {
      boxai: { input: 5, output: 25, cache: { read: 0.5, write: 6.25 } },
      cursor: { input: 5, output: 25, cache: { read: 0.77, write: 6.59 } }
    }
  },
  "claude-opus-5": {
    default: { input: 5, output: 25, cache: { read: 0.5, write: 6.25 } },
    providers: {
      cursor: { input: 5, output: 25, cache: { read: 0.75, write: 6.5 } }
    }
  },
  "claude-opus-5.5": {
    default: { input: 5, output: 25, cache: { read: 0.5, write: 6.25 } },
    providers: {
      cursor: { input: 5, output: 25, cache: { read: 0.75, write: 6.5 } }
    }
  },
  "composer-2.5": {
    default: { input: 3, output: 15 },
    providers: {
      cursor: { input: 0.66, output: 4.5, cache: { read: 0.42 } }
    }
  },
  "composer-2.5-fast": {
    default: { input: 3, output: 15 },
    providers: {
      cursor: { input: 2.73, output: 13.23, cache: { read: 0.76 } }
    }
  },
  "deepseek-v3.2": { default: { input: 0.29, output: 0.43 } },
  "deepseek-v4-flash": {
    default: { input: 0.429, output: 1.286, cache: { read: 0.014 } }
  },
  "deepseek-v4-pro": {
    default: { input: 1.286, output: 3.857, cache: { read: 0.043 } }
  },
  "gemini-3.1-pro": { default: { input: 2, output: 12 } },
  "gemini-3.5-flash": {
    default: { input: 1.55, output: 9.45 },
    providers: { boxai: { input: 0.15, output: 0.6 } }
  },
  "gemini-3.6-flash": {
    default: { input: 1.5, output: 7.5 },
    providers: {
      cursor: { input: 1.75, output: 7.75, cache: { read: 0.4 } }
    }
  },
  "gemini-3.8-flash": {
    default: { input: 0.75, output: 3.5, cache: { read: 0.075 } },
    providers: {
      cursor: { input: 0.75, output: 3.5, cache: { read: 0.075 } }
    }
  },
  "gemini-4-argon": {
    default: { input: 2, output: 10, cache: { read: 0.1 } },
    providers: {
      cursor: { input: 2, output: 10, cache: { read: 0.1 } }
    }
  },
  "gemini-2.5-pro": { default: { input: 0, output: 0 } },
  "glm-4.6": { default: { input: 0, output: 0 } },
  "glm-4.6v": { default: { input: 0, output: 0 } },
  "glm-4.7": { default: { input: 0, output: 0 } },
  "glm-5.0": { default: { input: 0, output: 0 } },
  "glm-5-fp8": {
    default: { input: 1, output: 3.2 }
  },
  "glm-5.1": {
    default: { input: 1.4, output: 4.4 },
    providers: {
      astra: { input: 1, output: 3.2 },
      boxai: { input: 1.4, output: 4.4, cache: { read: 0.26 } },
      kalm: { input: 1, output: 3.2 }
    }
  },
  "glm-5.2": {
    default: { input: 1.4, output: 4.4 },
    providers: {
      astra: { input: 1, output: 3.2 },
      boxai: { input: 1.4, output: 4.4, cache: { read: 0.26 } },
      kalm: { input: 1, output: 3.2 }
    }
  },
  "glm-5.3": {
    default: { input: 1.4, output: 4.4, cache: { read: 0.26 } },
    providers: {
      astra: { input: 0, output: 0 },
      kalm: { input: 0, output: 0 },
      imate: { input: 0, output: 0 }
    }
  },
  "glm-5.3-flash": {
    default: { input: 0.15, output: 0.5, cache: { read: 0.03 } },
    providers: {
      astra: { input: 0, output: 0 },
      kalm: { input: 0, output: 0 },
      imate: { input: 0, output: 0 }
    }
  },
  "glm-5.3-flashx": {
    default: { input: 0.37, output: 1.25, cache: { read: 0.075 } }
  },
  apex_glm5d3_w4a8_p800: {
    default: { input: 1.4, output: 4.4, cache: { read: 0.26 } },
    providers: {
      astra: { input: 0, output: 0 }
    }
  },
  "glm-5-turbo": {
    default: { input: 1.2, output: 4, cache: { read: 0.24 } }
  },
  "glm-5v-turbo": {
    default: { input: 1.2, output: 4, cache: { read: 0.24 } }
  },
  "grok-4.5": {
    default: { input: 3, output: 15 },
    providers: {
      cursor: { input: 1.53, output: 6.88, cache: { read: 0.249 } }
    }
  },
  "grok-4.5-fast": {
    default: { input: 3, output: 15 },
    providers: {
      cursor: { input: 2.62, output: 14.45, cache: { read: 0.588 } }
    }
  },
  "grok-4.7": {
    default: { input: 2, output: 6, cache: { read: 0.5 } },
    providers: {
      cursor: { input: 2, output: 6, cache: { read: 0.5 } }
    }
  },
  "grok-4.7-fast": {
    default: { input: 4, output: 12, cache: { read: 1 } },
    providers: {
      cursor: { input: 4, output: 12, cache: { read: 1 } }
    }
  },
  "gpt-5.6-sol": {
    default: { input: 4, output: 20, cache: { read: 0.4, write: 5 } },
    providers: {
      cursor: { input: 5, output: 29.07, cache: { read: 0.735, write: 6.4 } }
    }
  },
  "gpt-5.6-sol-fast": {
    default: { input: 8, output: 40, cache: { read: 0.8, write: 10 } }
  },
  "gpt-5.6-terra": {
    default: { input: 2, output: 12, cache: { read: 0.2, write: 2.5 } },
    providers: {
      cursor: { input: 2.5, output: 15.25, cache: { read: 0.5, write: 3.375 } }
    }
  },
  "gpt-5.6-terra-fast": {
    default: { input: 4, output: 24, cache: { read: 0.4, write: 5 } }
  },
  "gpt-5.6-luna": {
    default: { input: 0.2, output: 1.2, cache: { read: 0.02, write: 0.25 } }
  },
  "gpt-5.6-luna-fast": {
    default: { input: 0.4, output: 2.4, cache: { read: 0.04, write: 0.5 } }
  },
  "gpt-6-astra": {
    default: {
      input: 10,
      output: 50,
      cache: { read: 1, write: 12.5 },
      tiers: [
        {
          input: 20,
          output: 75,
          cache: { read: 2, write: 25 },
          tier: { type: "context", size: 272000 }
        }
      ]
    }
  },
  "gpt-6-astra-fast": {
    default: {
      input: 20,
      output: 100,
      cache: { read: 2, write: 25 },
      tiers: [
        {
          input: 40,
          output: 150,
          cache: { read: 4, write: 50 },
          tier: { type: "context", size: 272000 }
        }
      ]
    }
  },
  "gpt-6-sol": {
    default: {
      input: 2,
      output: 10,
      cache: { read: 0.2, write: 2.5 },
      tiers: [
        {
          input: 4,
          output: 15,
          cache: { read: 0.4, write: 5 },
          tier: { type: "context", size: 272000 }
        }
      ]
    }
  },
  "gpt-6-sol-fast": {
    default: {
      input: 4,
      output: 20,
      cache: { read: 0.4, write: 5 },
      tiers: [
        {
          input: 8,
          output: 30,
          cache: { read: 0.8, write: 10 },
          tier: { type: "context", size: 272000 }
        }
      ]
    }
  },
  "gpt-6-luna": {
    default: {
      input: 0.1,
      output: 0.5,
      cache: { read: 0.01, write: 0.125 },
      tiers: [
        {
          input: 0.2,
          output: 0.75,
          cache: { read: 0.02, write: 0.25 },
          tier: { type: "context", size: 272000 }
        }
      ]
    }
  },
  "gpt-6-luna-fast": {
    default: {
      input: 0.2,
      output: 1,
      cache: { read: 0.02, write: 0.25 },
      tiers: [
        {
          input: 0.4,
          output: 1.5,
          cache: { read: 0.04, write: 0.5 },
          tier: { type: "context", size: 272000 }
        }
      ]
    }
  },
  "gpt-6.1-sol": {
    default: {
      input: 2,
      output: 10,
      cache: { read: 0.1, write: 2.5 },
      tiers: [
        {
          input: 4,
          output: 15,
          cache: { read: 0.2, write: 5 },
          tier: { type: "context", size: 272000 }
        }
      ]
    }
  },
  "gpt-6.1-sol-fast": {
    default: {
      input: 4,
      output: 20,
      cache: { read: 0.2, write: 5 },
      tiers: [
        {
          input: 8,
          output: 30,
          cache: { read: 0.4, write: 10 },
          tier: { type: "context", size: 272000 }
        }
      ]
    }
  },
  "gpt-5.5": {
    default: { input: 5, output: 30, cache: { read: 0.5 } },
    providers: {
      cursor: { input: 3.61, output: 13.82, cache: { read: 0.795 } }
    }
  },
  "gpt-5.5-fast": {
    default: { input: 12.5, output: 75, cache: { read: 1.25 } }
  },
  "gpt-5.4": {
    default: { input: 2.5, output: 15, cache: { read: 0.25 } }
  },
  "gpt-5.4-fast": {
    default: { input: 5, output: 30, cache: { read: 0.5 } }
  },
  "gpt-5.4-mini": {
    default: { input: 0.75, output: 4.5, cache: { read: 0.075 } }
  },
  "gpt-5.4-nano": { default: { input: 0.2, output: 1.25 } },
  "gpt-5.3-codex": { default: { input: 0, output: 0 } },
  "gpt-5.1-codex": { default: { input: 0, output: 0 } },
  "gpt-5.1-codex-mini": { default: { input: 0, output: 0 } },
  "hy-3": { default: { input: 0.5, output: 2 } },
  "kimi-k2.5": { default: { input: 0.6, output: 3 } },
  "kimi-k2-thinking": { default: { input: 0, output: 0 } },
  "kimi-k2.6": {
    default: { input: 0.6, output: 3 },
    providers: { boxai: { input: 2, output: 8 } }
  },
  "kimi-k2.7": { default: { input: 0.95, output: 4 } },
  "kimi-k3": { default: { input: 3, output: 15, cache: { read: 0.3 } } },
  "kimi-k2.8-preview": {
    default: { input: 1, output: 4, cache: { read: 0.25 } }
  },
  "minimax-m2.5": { default: { input: 0.3, output: 1.2 } },
  "minimax-m2.7": { default: { input: 0.3, output: 1.2 } },
  "minimax-m3": {
    default: { input: 0.6, output: 2.4, cache: { read: 0.12 } },
    providers: { astra: { input: 0.3, output: 1.2 } }
  },
  "deepseek-v4-pro-0813": { default: { input: 0, output: 0 } },
  "hy4-preview": {
    default: { input: 0.834, output: 2.501, cache: { read: 0.042 } },
    providers: {
      astra: { input: 0, output: 0 },
      kalm: { input: 0, output: 0 },
      imate: { input: 0, output: 0 }
    }
  },
  "qwen3.8-27b": { default: { input: 0, output: 0 } },
  "qwen3.8-flash-next": { default: { input: 0, output: 0 } },
  "MiMo-V2.6-Flash-RL-astra": {
    default: { input: 0.14, output: 0.28, cache: { read: 0.0028 } }
  },
  "MiMo-V2.6-Pro-RL-astra": {
    default: { input: 0.435, output: 0.87, cache: { read: 0.0036 } }
  }
};
var clonePricing = (pricing) => ({
  input: pricing.input,
  output: pricing.output,
  ...pricing.cache ? { cache: { ...pricing.cache } } : {},
  ...pricing.tiers ? { tiers: pricing.tiers.map((entry) => ({ ...clonePricing(entry), tier: { ...entry.tier } })) } : {}
});
var stripProviderSuffixes = (key) => {
  const suffix = PROVIDER_MODEL_SUFFIXES.find((candidate) => key.endsWith(candidate));
  return suffix ? stripProviderSuffixes(key.slice(0, -suffix.length)) : key;
};
var normalizeVersionSeparators = (key) => key.replace(/^([a-z]+(?:-[a-z]+)*)-(\d+)-(\d+)(?=-|$)/, "$1-$2.$3");
var splitCapabilitySuffix = (key) => {
  const suffix = CAPABILITY_SUFFIXES.find((candidate) => key.endsWith(candidate));
  return suffix ? { base: key.slice(0, -suffix.length), capability: suffix } : { base: key, capability: "" };
};
var normalizeModelPricingKey = (key) => {
  const withoutProviderSuffixes = stripProviderSuffixes(key);
  const withoutContext = stripContextSuffixes(withoutProviderSuffixes);
  const normalizedVersion = normalizeVersionSeparators(withoutContext);
  return MODEL_PRICING_ALIASES[key] ?? MODEL_PRICING_ALIASES[withoutProviderSuffixes] ?? MODEL_PRICING_ALIASES[withoutContext] ?? MODEL_PRICING_ALIASES[normalizedVersion] ?? normalizedVersion;
};
var parseVersionedModelKey = (key) => {
  const match = /^([a-z]+(?:-[a-z]+)*)-(\d+)(?:\.(\d+))?(?:-.+)?$/.exec(key);
  if (!match)
    return;
  return {
    key,
    family: match[1],
    isFast: key.endsWith("-fast"),
    major: Number(match[2]),
    minor: Number(match[3] ?? 0)
  };
};
var compareModelVersions = (left, right) => left.major === right.major ? left.minor - right.minor : left.major - right.major;
var getFallbackPriority = (candidate) => candidate.key.includes("-sol") ? 1 : 0;
var findVersionFallbackKey = (key) => {
  const requested = parseVersionedModelKey(key);
  if (!requested)
    return;
  const candidates = Object.keys(MODEL_PRICINGS).map(parseVersionedModelKey).filter((candidate) => candidate !== undefined && candidate.family === requested.family && candidate.isFast === requested.isFast && candidate.major === requested.major && compareModelVersions(candidate, requested) <= 0).sort((left, right) => compareModelVersions(right, left) || getFallbackPriority(right) - getFallbackPriority(left) || left.key.localeCompare(right.key));
  return candidates[0]?.key;
};
var resolveModelPricingKey = (key) => {
  if (MODEL_PRICINGS[key])
    return key;
  const { base, capability } = splitCapabilitySuffix(key);
  const normalizedBase = normalizeModelPricingKey(base);
  const candidates = capability ? [`${normalizedBase}${capability}`, normalizedBase] : [normalizedBase];
  for (const candidate of candidates) {
    if (MODEL_PRICINGS[candidate])
      return candidate;
    const versionFallback = findVersionFallbackKey(candidate);
    if (versionFallback)
      return versionFallback;
  }
  return;
};
var getModelPricing = (key, provider) => {
  const resolvedKey = resolveModelPricingKey(key);
  const entry = resolvedKey ? MODEL_PRICINGS[resolvedKey] : undefined;
  const pricing = provider ? entry?.providers?.[provider] ?? entry?.default : entry?.default;
  return pricing ? clonePricing(pricing) : undefined;
};

// src/catalog.ts
var hasUnpricedModel = (inventory) => inventory.some((entry) => entry.models.some((model) => model.cost.length === 0));
var routingGroupName = (source) => source === "group" ? "Group" : source === "auto" ? "Auto" : undefined;
var routingGroupKey = (id) => {
  if (id.startsWith("group/"))
    return id.slice("group/".length);
  if (id.startsWith("auto/"))
    return `auto-${id.slice("auto/".length)}`;
  return;
};
var reasoningVariants = (row, anthropic) => {
  if (row.reasoning === false)
    return [];
  const levels = row.reasoning_levels ?? row.supported_reasoning_levels?.map((level) => typeof level === "string" ? level : level.effort) ?? [];
  return [...new Set(levels)].filter((effort) => effort && effort !== "default").map((effort) => ({
    id: effort,
    settings: anthropic ? effort === "none" ? { thinking: { type: "disabled" } } : { thinking: { type: "adaptive" }, effort } : { reasoningEffort: effort }
  }));
};
var pricingProvider = (owner) => {
  const id = owner.toLowerCase();
  if (id === "workbuddy")
    return "codebuddy";
  return ["astra", "boxai", "codebuddy", "cursor", "imate", "kalm"].find((provider) => provider === id);
};
var normalizeProviderName = (name) => name.replace(/\bremote[- ]magpie\b/gi, "Remote Magpie");
var providerName = (model) => {
  const label = model.magpie_label?.split(" · ").slice(1).join(" · ");
  return normalizeProviderName(label || ({ cursor: "Cursor", workbuddy: "WorkBuddy" }[model.owned_by] ?? model.owned_by));
};
var nestedProvider = (row) => {
  const prefix = `${row.owned_by}/`;
  if (!row.id.startsWith(prefix))
    return;
  const remainder = row.id.slice(prefix.length);
  const slash = remainder.indexOf("/");
  if (slash <= 0 || slash === remainder.length - 1)
    return;
  const source = remainder.slice(0, slash);
  const routing = routingGroupName(source);
  const parts = row.magpie_label?.split(" · ") ?? [];
  if (routing) {
    return {
      id: `${row.owned_by}/${source}`,
      name: `${routing} · ${normalizeProviderName(parts.length === 3 ? parts[2] : providerName(row))}`
    };
  }
  const label = providerName(row);
  const sourceName = providerName({ id: source, owned_by: source });
  return {
    id: `${row.owned_by}/${source}`,
    name: parts.length === 3 ? label : `${sourceName} · ${label}`
  };
};
var displayName = (name) => name.replace(/@\s+(\d+(?:k|m))/gi, "@$1");
var isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
var invalidOptions = (path, reason) => new Error(`Magpie 插件的 options 无效（opencode.jsonc → plugins → ${path}）：${reason}。`);
var requiredString = (value, path) => {
  if (typeof value !== "string" || value.length === 0)
    throw invalidOptions(path, "必须是非空字符串");
  return value;
};
var parseGroups = (value) => {
  if (value === undefined)
    return [];
  if (!Array.isArray(value))
    throw invalidOptions("options.groups", "必须是数组");
  return value.map((entry, index) => {
    const path = `options.groups[${index}]`;
    if (!isRecord(entry))
      throw invalidOptions(path, "必须是对象");
    for (const key of Object.keys(entry)) {
      if (key !== "prefix" && key !== "id" && key !== "name")
        throw invalidOptions(`${path}.${key}`, "不是已知字段");
    }
    return {
      prefix: requiredString(entry.prefix, `${path}.prefix`),
      id: requiredString(entry.id, `${path}.id`),
      name: requiredString(entry.name, `${path}.name`)
    };
  });
};
var parseOrder = (value) => {
  if (value === undefined)
    return new Map;
  if (!isRecord(value))
    throw invalidOptions("options.order", "必须是对象");
  const order = new Map;
  for (const [providerID, ids] of Object.entries(value)) {
    const path = `options.order.${providerID}`;
    if (!Array.isArray(ids))
      throw invalidOptions(path, "必须是模型 id 数组");
    const weights = new Map;
    for (const [index, id] of ids.entries()) {
      const modelID = requiredString(id, `${path}[${index}]`);
      if (!weights.has(modelID))
        weights.set(modelID, 1000 - index * 10);
    }
    order.set(providerID, weights);
  }
  return order;
};
var parsePresentation = (options) => {
  if (options === undefined)
    return { groups: [], order: new Map };
  if (!isRecord(options))
    throw invalidOptions("options", "必须是对象");
  for (const key of Object.keys(options)) {
    if (key !== "groups" && key !== "order" && key !== "remote" && key !== "agentID" && key !== "modelsDev")
      throw invalidOptions(`options.${key}`, "不是已知字段");
  }
  if (options.modelsDev !== undefined && typeof options.modelsDev !== "boolean")
    throw invalidOptions("options.modelsDev", "必须是布尔值");
  return {
    groups: parseGroups(options.groups),
    order: parseOrder(options.order)
  };
};
var modelCost = (row, group, catalog) => {
  const modelID = row.id.slice(row.id.indexOf("/") + 1);
  const pricingID = modelID.replace(/@\d+(?:k|m)$/i, "");
  const builtin = group ? undefined : getModelPricing(pricingID, pricingProvider(row.owned_by));
  if (builtin)
    return { cost: builtin, source: "builtin" };
  if (row.magpie_price)
    return { cost: row.magpie_price, source: "magpie" };
  const listed = group ? undefined : lookupCatalogPrice(catalog, row.owned_by, pricingID);
  if (listed)
    return { cost: listed, source: "models.dev" };
  return { cost: undefined, source: "none" };
};
var buildInventory = (rows, baseURL, options = {}) => {
  const providers = new Map;
  const apiKey = options.apiKey ?? "magpie";
  const fastModelIDs = new Set(options.fastModelIDs);
  const presentation = options.presentation ?? { groups: [], order: new Map };
  const buckets = [...presentation.groups].sort((left, right) => right.prefix.length - left.prefix.length);
  for (const row of rows) {
    if (row.service_tiers?.some((tier) => (typeof tier === "string" ? tier : tier.id) === "priority"))
      fastModelIDs.add(row.id);
  }
  rows.filter((row) => !row.kind && row.id.includes("/")).forEach((row) => {
    const source = row.id.slice(0, row.id.indexOf("/"));
    const groupKey = routingGroupKey(row.id);
    const group = groupKey !== undefined;
    const bucket = groupKey ? buckets.find((entry2) => groupKey.length > entry2.prefix.length && groupKey.startsWith(entry2.prefix)) : undefined;
    const nested = group ? undefined : nestedProvider(row);
    const owner = group ? bucket?.id ?? source : nested?.id ?? row.owned_by;
    const providerID = `magpie-${encodeURIComponent(owner)}`;
    const modelID = bucket && groupKey ? groupKey.slice(bucket.prefix.length) : groupKey ?? row.id.slice(row.id.indexOf("/") + 1);
    const { cost } = modelCost(row, group, options.catalog);
    const model = toClassicModelInfo(providerID, modelID, {
      id: row.id,
      name: displayName(row.display_name ?? modelID),
      cost,
      limit: {
        context: row.context_window || 256000,
        output: row.max_output_tokens || 32000
      },
      modalities: row.modalities,
      tool_call: true
    });
    const anthropic = row.native_endpoints?.includes("/v1/messages");
    const responses = !anthropic && row.native_endpoints?.includes("/v1/responses");
    model.package = anthropic ? "@opencode/ai/providers/anthropic-compatible" : responses ? "@opencode/ai/providers/openai-compatible/responses" : "@opencode/ai/providers/openai-compatible";
    model.settings = {
      baseURL,
      apiKey,
      transport: "http"
    };
    model.variants = reasoningVariants(row, !!anthropic);
    model.time = { released: presentation.order.get(providerID)?.get(model.id) ?? 0 };
    const entry = providers.get(providerID) ?? {
      info: {
        id: providerID,
        name: bucket ? bucket.name : group ? `Magpie ${routingGroupName(source)}` : nested?.name ?? providerName(row),
        activation: "enabled",
        package: "@opencode/ai/providers/openai-compatible",
        settings: {
          baseURL,
          apiKey,
          transport: "http"
        },
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "X-Magpie-Agent": options.agentID ?? "opencode"
        }
      },
      models: []
    };
    if (!entry.models.some((existing) => existing.id === model.id))
      entry.models.push(model);
    providers.set(providerID, entry);
  });
  return [...providers.values()].map((entry) => {
    const ids = new Set(entry.models.map((model) => model.id));
    return {
      ...entry,
      models: entry.models.flatMap((model) => {
        if (!fastModelIDs.has(model.modelID) || /-fast(?:@\d+[km])?$/i.test(model.id) || ids.has(`${model.id}-fast`))
          return [model];
        const row = rows.find((row2) => row2.id === model.modelID);
        const fastKey = `${model.id.replace(/@\d+(?:k|m)$/i, "")}-fast`;
        const fastPrice = row && routingGroupKey(row.id) === undefined && resolveModelPricingKey(fastKey)?.endsWith("-fast") ? getModelPricing(fastKey, pricingProvider(row.owned_by)) : undefined;
        return [
          model,
          {
            ...model,
            id: `${model.id}-fast`,
            cost: fastPrice ? normalizeModelCosts(fastPrice) : model.cost,
            name: `${model.name} Fast`,
            body: { ...model.body, service_tier: "priority" }
          }
        ];
      })
    };
  });
};

// src/fast-models.ts
import { readFile as readFile2 } from "node:fs/promises";
import { homedir as homedir2 } from "node:os";
import { join as join2 } from "node:path";
var loadFastModelIDs = async () => {
  const path = join2(process.env.XDG_CONFIG_HOME || join2(homedir2(), ".config"), "magpie", "plugin-providers.json");
  const ids = new Set;
  try {
    const providers = JSON.parse(await readFile2(path, "utf8"));
    if (!Array.isArray(providers))
      return ids;
    for (const provider of providers) {
      if (typeof provider?.id !== "string" || !Array.isArray(provider.models))
        continue;
      for (const model of provider.models) {
        if (typeof model?.id !== "string")
          continue;
        const priority = Array.isArray(model.serviceTiers) && model.serviceTiers.includes("priority");
        if (priority || provider.id === "cursor" && model.fast === true)
          ids.add(`${provider.id}/${model.id}`);
      }
    }
  } catch {}
  return ids;
};

// src/gateway.ts
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile as readFile3, realpath } from "node:fs/promises";
import { homedir as homedir3 } from "node:os";
import { delimiter, isAbsolute, join as join3 } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
var INSTALL_MESSAGE = "未安装 Magpie，请先从 https://usemagpie.ai/zh/ 安装并登录所需服务，再使用此插件。";
var resolveConnection = async (options) => {
  const agentID = options?.agentID ?? "opencode";
  if (typeof agentID !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(agentID))
    throw new Error("Magpie options.agentID must be a lowercase identifier (1-64 characters).");
  const remote = options?.remote;
  if (remote === undefined) {
    const localURL = await resolveBaseURL();
    return {
      agentID,
      baseURL: `${localURL}/v1`,
      token: "magpie",
      remote: false,
      ensure: () => ensureGateway(localURL)
    };
  }
  const invalid = (field, reason) => new Error(`Magpie 插件的 options.remote${field} 无效：${reason}。`);
  if (typeof remote !== "object" || remote === null || Array.isArray(remote))
    throw invalid("", "必须是包含 baseURL 和 token 的对象");
  const value = remote;
  if (Object.keys(value).some((key) => key !== "baseURL" && key !== "token" && key !== "tokenFile"))
    throw invalid("", "仅支持 baseURL、token 和 tokenFile 字段");
  let url;
  try {
    if (typeof value.baseURL !== "string" || value.baseURL.trim() !== value.baseURL)
      throw new Error;
    url = new URL(value.baseURL);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      throw new Error;
  } catch {
    throw invalid(".baseURL", "必须是完整 HTTP(S) API 基地址，不能包含用户名、密码、查询参数或片段");
  }
  const baseURL = url.href.replace(/\/+$/, "");
  if (value.tokenFile !== undefined) {
    if (value.token !== undefined || typeof value.tokenFile !== "string" || !isAbsolute(value.tokenFile))
      throw invalid(".tokenFile", "必须是绝对路径，且不能同时设置 token");
    const tokenFile = value.tokenFile;
    const connection = {
      agentID,
      baseURL,
      tokenFile,
      token: await readAssignedKey(tokenFile, baseURL),
      remote: true,
      ensure: async () => {
        connection.token = await readAssignedKey(tokenFile, baseURL);
      }
    };
    return connection;
  }
  if (typeof value.token !== "string" || !/^[\x21-\x7e]+$/.test(value.token))
    throw invalid(".token", "必须是非空 token，不能包含空格或控制字符");
  return {
    agentID,
    baseURL,
    token: value.token,
    remote: true,
    ensure: async () => {}
  };
};
var readAssignedKey = async (file, baseURL) => {
  try {
    const connection = JSON.parse(await readFile3(file, "utf8"));
    if (new URL(connection.baseURL).href.replace(/\/+$/, "") !== baseURL || typeof connection.gatewayKey !== "string" || !/^[\x21-\x7e]+$/.test(connection.gatewayKey))
      throw new Error;
    return connection.gatewayKey;
  } catch {
    throw new Error("Magpie options.remote.tokenFile 不可用、无效或连接地址已改变；请检查 Agent 连接。");
  }
};
var resolveBaseURL = async () => {
  if (process.env.MAGPIE_ADDR) {
    const addr = process.env.MAGPIE_ADDR.replace(/^:/, "127.0.0.1:");
    const url = new URL(addr.includes("://") ? addr : `http://${addr}`);
    if (url.hostname === "0.0.0.0" || url.hostname === "[::]")
      url.hostname = "127.0.0.1";
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
      throw new Error("Magpie 自动启动仅支持本机 MAGPIE_ADDR。");
    }
    return url.origin;
  }
  const path = join3(process.env.XDG_CONFIG_HOME || join3(homedir3(), ".config"), "magpie", "settings.json");
  const settings = await readFile3(path, "utf8").then((text) => JSON.parse(text)).catch((error) => {
    if (error.code === "ENOENT")
      return {};
    throw error;
  });
  const port = settings.port || 3425;
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("Magpie settings.json 中的 port 无效。");
  return `http://127.0.0.1:${port}`;
};
var findExecutable = async () => {
  const binary = process.platform === "win32" ? "magpie.exe" : "magpie";
  const candidates = [
    ...(process.env.PATH ?? "").split(delimiter).filter(Boolean).map((path) => join3(path, binary)),
    join3(homedir3(), ".local", "bin", binary),
    "/opt/homebrew/bin/magpie",
    "/usr/local/bin/magpie",
    "/Applications/Magpie.app/Contents/MacOS/magpie",
    join3(homedir3(), "Applications/Magpie.app/Contents/MacOS/magpie")
  ];
  const found = await Promise.all(candidates.map(async (path) => await access(path, constants.X_OK).then(() => path, () => {
    return;
  })));
  const executable = found.find(Boolean);
  if (!executable)
    return;
  return await realpath(executable).catch(() => executable);
};
var probeGateway = async (baseURL) => {
  let response;
  try {
    response = await fetch(baseURL, { signal: AbortSignal.timeout(1500) });
  } catch {
    return false;
  }
  const info = await response.json().catch(() => {
    return;
  });
  if (!response.ok || info?.name !== "magpie")
    throw new Error(`${baseURL} 已被非 Magpie 服务占用。`);
  return true;
};
var gatewayArgs = (executable) => {
  const app = /[\\/]magpie\.app[\\/]/i.test(executable);
  return process.platform === "darwin" && app ? ["tray"] : ["serve"];
};
var startAttempts = (executable) => {
  const preferred = gatewayArgs(executable);
  return preferred[0] === "tray" ? [preferred, ["serve"]] : [preferred];
};
var startGateway = async (executable, args) => {
  const state = { failed: false };
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      state.failed = code !== null && code !== 0 || signal != null;
    });
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
  return state;
};
var waitForGateway = async (baseURL, tries, state) => {
  for (let remaining = tries;remaining >= 0; remaining -= 1) {
    if (await probeGateway(baseURL))
      return true;
    if (state.failed)
      return false;
    if (remaining === 0)
      return false;
    await delay(500);
  }
  return false;
};
var starting = new Map;
var ensureGateway = async (baseURL) => {
  if (await probeGateway(baseURL))
    return;
  const pending2 = starting.get(baseURL);
  if (pending2)
    return pending2;
  const task = (async () => {
    const executable = await findExecutable();
    if (!executable)
      throw new Error(INSTALL_MESSAGE);
    for (const args of startAttempts(executable)) {
      const state = await startGateway(executable, args);
      if (await waitForGateway(baseURL, args[0] === "tray" ? 60 : 30, state))
        return;
      if (args[0] === "tray" && !state.failed) {
        throw new Error("Magpie app 网关尚未就绪，请在 app 中检查网关状态；未启动无窗口服务，以免抢占端口。");
      }
    }
    throw new Error("Magpie 网关启动超时，请运行 magpie serve 查看错误。");
  })();
  starting.set(baseURL, task);
  try {
    await task;
  } finally {
    starting.delete(baseURL);
  }
};
var fetchModels = async (baseURL, token = "magpie", agentID = "opencode") => {
  const response = await fetch(`${baseURL}/models`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Magpie-Prices": "1",
      "X-Magpie-Agent": agentID
    },
    redirect: "error",
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok)
    throw new Error(`Magpie 模型发现失败：HTTP ${response.status}`);
  const body = await response.json().catch(() => {
    return;
  });
  if (!Array.isArray(body?.data) || body.data.some((model) => !model || typeof model.id !== "string" || typeof model.owned_by !== "string")) {
    throw new Error("Magpie models 接口返回了无效的模型目录。");
  }
  return body.data;
};

// src/image.ts
import { mkdir as mkdir2, writeFile as writeFile2 } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as join4 } from "node:path";
var listImageModels = async (connection, signal) => {
  await connection.ensure();
  const response = await fetch(`${connection.baseURL}/models`, {
    headers: {
      Authorization: `Bearer ${connection.token}`,
      "X-Magpie-Drawers": "1",
      "X-Magpie-Agent": connection.agentID ?? "opencode"
    },
    redirect: "error",
    signal: AbortSignal.any([AbortSignal.timeout(15000), ...signal ? [signal] : []])
  });
  if (!response.ok)
    throw new Error(`Magpie 模型列表失败：HTTP ${response.status}`);
  const body = await response.json().catch(() => {
    return;
  });
  const rows = (body?.data ?? []).flatMap((row) => row.kind === "image" && typeof row.id === "string" ? [{ id: row.id, name: typeof row.display_name === "string" ? row.display_name : row.id }] : []);
  const ids = new Set(rows.map((row) => row.id));
  return rows.filter((row) => !(row.id.startsWith("remote-magpie/") && ids.has(row.id.slice(14))));
};
var extension = (bytes) => bytes.subarray(0, 4).equals(Buffer.from([137, 80, 78, 71])) ? ".png" : bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ? ".jpg" : bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP" ? ".webp" : bytes.subarray(0, 3).toString("latin1") === "GIF" ? ".gif" : ".png";
var drawImage = async (connection, input, signal) => {
  await connection.ensure();
  const response = await fetch(`${connection.baseURL}/images/generations`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${connection.token}`,
      "Content-Type": "application/json",
      "X-Magpie-Agent": connection.agentID ?? "opencode"
    },
    body: JSON.stringify({ ...input, n: 1, response_format: "b64_json" }),
    redirect: "error",
    signal: AbortSignal.any([AbortSignal.timeout(10 * 60000), ...signal ? [signal] : []])
  });
  const body = await response.json().catch(() => {
    return;
  });
  if (!response.ok) {
    throw new Error(body?.error?.message ?? `Magpie 生图失败：HTTP ${response.status}`);
  }
  const image = body?.data?.[0];
  let bytes;
  if (image?.b64_json)
    bytes = Buffer.from(image.b64_json, "base64");
  else if (image?.url) {
    const download = await fetch(image.url, { redirect: "error", signal });
    if (download.ok)
      bytes = Buffer.from(await download.arrayBuffer());
  }
  if (!bytes?.length)
    throw new Error("Magpie 没有返回图片。");
  const folder = join4(tmpdir(), "magpie-images");
  await mkdir2(folder, { recursive: true });
  const path = join4(folder, `image-${Date.now()}${extension(bytes)}`);
  await writeFile2(path, bytes);
  return { path, model: body?.model ?? input.model };
};
var markdownImage = (path) => `![image](${/[\s()[\]]/.test(path) ? `<${path}>` : path})`;
var NAMESPACE = "magpie";
var registerImageTools = (editor, connection) => {
  editor.namespace({ name: NAMESPACE, description: "Magpie image generation." });
  const options = { namespace: NAMESPACE, codemode: true };
  editor.add({
    name: "image_list",
    description: "List the image models Magpie can draw with, one provider/model id per line.",
    input: { type: "object", properties: {}, additionalProperties: false },
    options,
    execute: async (_input, context) => {
      const models = await listImageModels(connection, context.signal);
      return {
        content: models.length ? models.map((model) => `${model.id}  ${model.name}`).join(`
`) : "No image model is available in Magpie."
      };
    }
  });
  editor.add({
    name: "image_gen",
    description: "Draw one image through Magpie and save it. Returns a Markdown image and the model used.",
    input: {
      type: "object",
      properties: {
        prompt: { type: "string", minLength: 1 },
        model: {
          type: "string",
          description: "provider/model from image_list; omit for Magpie’s default."
        },
        size: { type: "string", description: "16:9, 9:16, 1:1 or WIDTHxHEIGHT." },
        quality: { type: "string", description: "low, medium, high or auto." }
      },
      required: ["prompt"],
      additionalProperties: false
    },
    options,
    execute: async (input, context) => {
      const { path, model } = await drawImage(connection, input, context.signal);
      return { content: `${markdownImage(path)}${model ? `
(${model})` : ""}` };
    }
  });
};
var IMAGE_SKILL_ID = "magpie-image-generate";
var SKILL = [
  "# Magpie image generation",
  "",
  "`magpie.image_list` lists the image model IDs currently available through the configured gateway.",
  "`magpie.image_gen` accepts prompt, optional model, size and quality; an omitted model uses Magpie’s configured default.",
  "Sizes are provider-dependent: aspect ratios or WIDTHxHEIGHT. Quality values are low, medium, high or auto.",
  "Generation can take minutes and consumes the account’s credits. Provider refusals and quota errors are returned as errors.",
  "A successful result contains a Markdown image pointing to the saved temporary file, followed by the model used."
].join(`
`);
var registerImageSkill = (editor, path) => {
  editor.add({
    id: IMAGE_SKILL_ID,
    name: IMAGE_SKILL_ID,
    description: "Magpie image generation: load before drawing or generating any image, picture, illustration or icon.",
    path,
    content: SKILL
  });
};

// src/index.ts
var plugin = {
  id: "magpie.providers",
  setup: (ctx) => setupPlugin(ctx)
};
var setupPlugin = async (ctx) => {
  if (!ctx.provider)
    throw new Error("Magpie 插件需要 OpenCode V2 provider.transform。");
  const presentation = parsePresentation(ctx.options);
  const modelsDev = ctx.options?.modelsDev === true;
  const connection = await resolveConnection(ctx.options);
  const { baseURL, agentID } = connection;
  const apiURL = new URL(baseURL);
  await connection.ensure();
  let catalog = await loadCatalogCache(false, modelsDev);
  let inventory = buildInventory(await fetchModels(baseURL, connection.token, agentID), baseURL, {
    apiKey: connection.token,
    agentID,
    catalog: catalog.data,
    fastModelIDs: connection.remote ? undefined : await loadFastModelIDs(),
    presentation
  });
  const { track, cleanup } = createTrackedSetup();
  let disposed = false;
  let refreshing = false;
  try {
    await track(ctx.provider.transform((editor) => {
      inventory.forEach((entry) => {
        editor.add(entry);
      });
    }));
    for (const name of ["context", "compaction", "generate", "title"]) {
      await track(ctx.session.hook(name, normalizeOpenAICallIDs, { providerID: "openai" }));
    }
    if (ctx.tool && ctx.skill) {
      await track(ctx.tool.transform((editor) => registerImageTools(editor, connection)));
      await track(ctx.skill.transform((editor) => registerImageSkill(editor, fileURLToPath(new URL("./", import.meta.url)))));
    }
    await track(ctx.session.hook("http.request", async (event) => {
      const url = new URL(event.request.url);
      if (url.origin !== apiURL.origin || !url.pathname.startsWith(`${apiURL.pathname.replace(/\/$/, "")}/`))
        return;
      await connection.ensure();
      if (connection.tokenFile)
        event.request.headers.set("Authorization", `Bearer ${connection.token}`);
      event.request.headers.set("X-Magpie-Session", event.sessionID);
      event.request.headers.set("X-Magpie-Agent", agentID ?? "opencode");
    }));
    await reloadProviderCatalog(ctx);
  } catch (error) {
    await cleanup();
    throw error;
  }
  const apply = async (next) => {
    if (disposed || JSON.stringify(next) === JSON.stringify(inventory))
      return;
    const previous = inventory;
    inventory = next;
    try {
      await reloadProviderCatalog(ctx);
    } catch (error) {
      inventory = previous;
      throw error;
    }
  };
  const refresh = async () => {
    if (disposed || refreshing)
      return;
    refreshing = true;
    try {
      await connection.ensure();
      const rows = await fetchModels(baseURL, connection.token, agentID);
      catalog = await loadCatalogCache(hasUnpricedModel(inventory), modelsDev);
      const next = buildInventory(rows, baseURL, {
        apiKey: connection.token,
        agentID,
        catalog: catalog.data,
        fastModelIDs: connection.remote ? undefined : await loadFastModelIDs(),
        presentation
      });
      await apply(next);
    } catch (error) {
      console.warn("[magpie] 模型刷新失败，保留上次目录：", error instanceof Error ? error.message : String(error));
    } finally {
      refreshing = false;
    }
  };
  const timer = setInterval(() => {
    refresh();
  }, 30000);
  timer.unref();
  return async () => {
    disposed = true;
    clearInterval(timer);
    await cleanup();
  };
};
var src_default = plugin;
export {
  src_default as default
};
