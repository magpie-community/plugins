/**
 * 模型目录：Token Plan 的聊天模型清单。
 *
 * 事实来源分两层：
 *   1. 官网文档（platform.sensenova.cn/docs）给出「哪些模型能聊天、输入输出是什么」；
 *   2. 活的 `GET /v1/models` 给出当前部署的上下文、输出上限、价格与能力字段。
 *
 * 两者不一致时，**能力以文档为准、上限以接口为准**。原因很具体：
 *   - `/v1/models` 对 `deepseek-flash` 只写 text，但官网明确它支持图片和视频（视频仅 Chat）；
 *   - `/v1/models` 对 `kimi-k3` 只写 text，但官网说它有原生视觉能力；
 *   - `/v1/models` 还会多出 `deepseek-v4.1-flash` 这种实际 403 的杂项。
 *
 * 所以内置清单不是“兜底占位”，而是目录的骨架；接口只用来覆盖上限/价格/描述。
 */

export const NPM = "@ai-sdk/openai-compatible";
export const DEFAULT_BASE_URL = "https://token.sensenova.cn/v1";

const DEFAULT_CONTEXT = 1_048_576;
const DEFAULT_OUTPUT = 65_536;

/**
 * 实测的 `max_tokens` 合法上界（不是营销数字，也不等于模型实际会生成这么长）。
 *
 * 2026-10-29 用真实账号发 `max_tokens: 400000`，接口返回
 * `field MaxTokens invalid, should be in [1, N]`，N 即下表。
 * `/v1/models` 的 `max_output_length` 对这两个模型是 65,536，会把 agent
 * 能请求的输出人为截短；所以实测值优先于 live，Kimi 因持续 429 未测，保持 live。
 */
export const MEASURED_OUTPUT_LIMITS = {
  "deepseek-flash": { value: 393_216, measuredAt: "2026-10-29", evidence: "[1, 393216]" },
  "deepseek-v4-flash": { value: 384_000, measuredAt: "2026-10-29", evidence: "[1, 384000]" },
};

/** 官网模型表里能走 Chat Completions 的模型。 */
export const CHAT_MODELS = [
  {
    id: "sensenova-6.8-flash-lite",
    name: "SenseNova 6.8 Flash Lite",
    contextLength: 262_144,
    maxCompletionTokens: 65_536,
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
    supportsTools: true,
    reasoning: true,
    efforts: ["none", "low", "medium", "high", "max"],
    description:
      "SenseNova 6.8 Flash-Lite is a lightweight multimodal agent model designed for real-world workflows, supporting text conversation and image input understanding.",
  },
  {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    contextLength: 1_048_576,
    maxCompletionTokens: 384_000,
    inputModalities: ["text"],
    outputModalities: ["text"],
    supportsTools: true,
    reasoning: true,
    efforts: ["none", "low", "high", "max"],
    description:
      "DeepSeek V4 Flash is a high-performance conversational model by DeepSeek, supporting thinking/non-thinking modes, 1M context window, and tool calling.",
  },
  {
    id: "deepseek-flash",
    name: "DeepSeek V4.1 Flash",
    contextLength: 1_048_576,
    maxCompletionTokens: 393_216,
    // 官网：文本、图片、视频；视频仅 Chat Completions。
    inputModalities: ["text", "image", "video"],
    outputModalities: ["text"],
    supportsTools: true,
    reasoning: true,
    efforts: ["none", "low", "high", "max"],
    description:
      "DeepSeek V4.1 Flash is a high-performance conversational model by DeepSeek, supporting thinking/non-thinking modes, 1M context window, image/video input (video on Chat), and tool calling.",
  },
  {
    id: "glm-5.2",
    name: "GLM-5.2",
    contextLength: 1_048_576,
    maxCompletionTokens: 131_072,
    inputModalities: ["text"],
    outputModalities: ["text"],
    supportsTools: true,
    reasoning: true,
    efforts: ["none", "low", "high", "max"],
    description:
      "GLM-5.2 is the flagship model for the era of long-horizon tasks, with a 1M context window and thinking/non-thinking modes.",
  },
  {
    id: "kimi-k3",
    name: "Kimi K3",
    contextLength: 1_048_576,
    maxCompletionTokens: 65_536,
    // 官网：原生视觉能力；/v1/models 只写 text，以文档为准。
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
    supportsTools: true,
    reasoning: true,
    efforts: ["none", "low", "high", "max"],
    description:
      "Kimi K3 is a high-performance native multimodal agent model by Kimi, with visual understanding, a 1M context window, and tool calling.",
  },
];

/** 图像生成模型：不进入 Chat 目录（magpie 的 chat provider 不服务 /v1/images/*）。 */
export const IMAGE_MODELS = [
  {
    id: "sensenova-u1.5-lite",
    name: "SenseNova U1.5 Lite",
    contextLength: 262_144,
    maxCompletionTokens: 65_536,
    inputModalities: ["text", "image"],
    outputModalities: ["image"],
    supportsTools: false,
    reasoning: false,
    efforts: [],
  },
  {
    id: "sensenova-u1.5-fast",
    name: "SenseNova U1.5 Fast",
    contextLength: 262_144,
    maxCompletionTokens: 65_536,
    inputModalities: ["text", "image"],
    outputModalities: ["image"],
    supportsTools: false,
    reasoning: false,
    efforts: [],
  },
];

/** `/v1/models` 里会冒出来、但不属于 Token Plan 的 id。 */
export const STRAY_MODEL_IDS = ["deepseek-v4.1-flash"];

/** 兜底清单（登录前 / 拉取失败时）。也叫“骨架清单”。 */
export const FALLBACK_MODELS = [...CHAT_MODELS, ...IMAGE_MODELS];

const positive = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : undefined);
const text = (v) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : undefined);
const bool = (v) => (typeof v === "boolean" ? v : v === "true" ? true : v === "false" ? false : undefined);
const unique = (xs) => [...new Set(xs)];

const known = (id) => CHAT_MODELS.find((m) => m.id === id);
const imageModel = (id) => IMAGE_MODELS.find((m) => m.id === id);

/** 归一化一条模型记录（兼容 snake_case / camelCase 两种拼写）。 */
export function normalizeModel(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = text(raw.id) ?? text(raw.model_id) ?? text(raw.model);
  if (!id) return null;
  const curated = known(id);
  const image = imageModel(id);

  const liveInput = list(raw.input_modalities ?? raw.inputModalities);
  const liveOutput = list(raw.output_modalities ?? raw.outputModalities);
  const features = list(raw.supported_features ?? raw.supportedFeatures) ?? [];

  // 能力取“文档 ∪ 接口”：文档补上接口漏掉的图片/视频，接口补上文档没写的新能力。
  const inputModalities = unique([...(curated?.inputModalities ?? image?.inputModalities ?? []), ...(liveInput ?? [])]);
  const outputModalities = unique([...(curated?.outputModalities ?? image?.outputModalities ?? []), ...(liveOutput ?? [])]);

  const supportsTools =
    bool(raw.supports_tools) ??
    bool(raw.supportsTool) ??
    bool(raw.tool_call) ??
    (features.includes("tools") ? true : undefined) ??
    curated?.supportsTools ??
    false;

  const reasoning =
    bool(raw.reasoning) ??
    bool(raw.supports_reasoning) ??
    (features.includes("reasoning") ? true : undefined) ??
    curated?.reasoning ??
    false;

  const efforts = reasoning ? (curated?.efforts ?? ["none", "low", "high", "max"]) : [];

  const created = positive(raw.created);
  // created 是 unix 秒；毫秒级时间戳或超大值会算出离谱年份甚至 Invalid Date，
  // 直接 toISOString 会抛 RangeError——夹在 2000–2200 年之间，超界就放弃。
  let released = "";
  if (created) {
    const date = new Date(created * 1000);
    const year = date.getUTCFullYear();
    if (Number.isFinite(year) && year > 2000 && year < 2200) released = date.toISOString().slice(0, 10);
  }
  return {
    id,
    name: curated?.name ?? image?.name ?? text(raw.name) ?? text(raw.model_name) ?? id,
    contextLength:
      positive(raw.context_length ?? raw.contextLength ?? raw.max_context_tokens) ??
      curated?.contextLength ??
      DEFAULT_CONTEXT,
    maxCompletionTokens:
      MEASURED_OUTPUT_LIMITS[id]?.value ??
      positive(
        raw.max_output_length ??
          raw.max_output_tokens ??
          raw.maxCompletionTokens ??
          raw.max_completion_tokens ??
          raw.max_output_tokens,
      ) ??
      curated?.maxCompletionTokens ??
      DEFAULT_OUTPUT,
    inputModalities: inputModalities.length ? inputModalities : ["text"],
    outputModalities: outputModalities.length ? outputModalities : ["text"],
    supportsTools,
    reasoning,
    efforts,
    description: text(raw.description) ?? curated?.description ?? "",
    released,
  };
}

/** 从各式信封里取出模型数组（{data:[…]} / {models:[…]} / 裸数组）。
 * 单条坏记录只丢自己，不能让整批清单失败（否则活清单静默变兜底）。 */
export function extractModels(payload) {
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.models)
        ? payload.models
        : [];
  return rows
    .map((row) => {
      try {
        return normalizeModel(row);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/** 只保留能走 Chat Completions 的模型：有文本输出、不是图像模型、不是杂项 id。 */
export function isChatModel(m) {
  if (!m || typeof m !== "object") return false;
  if (STRAY_MODEL_IDS.includes(m.id)) return false;
  const outputs = m.outputModalities ?? ["text"];
  return outputs.includes("text");
}

export function chatModels(models) {
  return (models ?? []).filter(isChatModel);
}

/** 图像生成模型：output 含 image；magpie 的 Drawers 会从 provider.models 里挑。 */
export function isImageModel(m) {
  if (!m || typeof m !== "object") return false;
  const outputs = m.outputModalities ?? [];
  return outputs.includes("image") && !outputs.includes("text");
}

/**
 * provider.models / config 的目录：聊天 +（宿主支持时）图像，杂项 id 仍过滤。
 * OpenCode 的 provider 不列 image-only 模型（上游惯例），magpie 的 Drawers 需要它们。
 */
export function catalogModels(models, { images = true } = {}) {
  return (models ?? []).filter(
    (m) => !STRAY_MODEL_IDS.includes(m?.id) && (isChatModel(m) || (images && isImageModel(m))),
  );
}

/**
 * 收窄到控制台计划池覆盖的模型。covered 为空集时返回空数组（计划明确说没有可调用的模型）：
 * 
 */
export function filterByPlan(models, covered) {
  const ids = covered instanceof Set ? covered : new Set(Array.isArray(covered) ? covered : []);
  // An empty set means the plan names no models: nothing is listed, not everything.
  return (models ?? []).filter((m) => ids.has(m?.id));
}

/**
 * 拉一次、按账号缓存一段时间的模型目录。
 *
 * 缓存必须按 API Key 分桶：provider.models 是按账号调用的，A 账号的清单
 * 不能给 B 账号用 6 小时；并发请求也不该 join 另一个账号的 in-flight。
 * 失败时保留该账号上次成功的清单；空清单做 30 秒负缓存，避免新 Key 生效前风暴。
 */
export function createCatalog({ baseURL = DEFAULT_BASE_URL, timeoutMs = 15_000, refreshMs = 6 * 3600_000, fetchImpl } = {}) {
  const root = baseURL.replace(/\/+$/, "");
  const doFetch = fetchImpl ?? fetch;
  let lastCached = null;
  const buckets = new Map();

  const bucketFor = (apiKey) => {
    let bucket = buckets.get(apiKey);
    if (!bucket) {
      bucket = { cached: null, fetchedAt: 0, inflight: null, emptyAt: 0 };
      buckets.set(apiKey, bucket);
    }
    return bucket;
  };

  return {
    baseURL: root,
    /** 最近一次任意账号成功列表（没有则 null）；只用于登录前的 config 播种。 */
    peek: () => lastCached,
    async raw(apiKey) {
      await this.load(apiKey);
      const b = bucketFor(apiKey);
      return b.raw ?? [];
    },
    async load(apiKey) {
      if (!apiKey) throw new Error("没有 API Key");
      const bucket = bucketFor(apiKey);
      const now = Date.now();
      if (bucket.cached && now - bucket.fetchedAt < refreshMs) return bucket.cached;
      if (bucket.inflight) return bucket.inflight;
      if (bucket.emptyAt && now - bucket.emptyAt < 30_000) return bucket.cached ?? [];

      bucket.inflight = (async () => {
        try {
          const res = await doFetch(`${root}/models`, {
            headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (!res.ok) {
            const err = new Error(`GET /models → HTTP ${res.status}`);
            err.status = res.status;
            throw err;
          }
          const body = await res.json();
          // raw rows keep the catalogue as authority for the listing path;
          // normalized rows (curated ∪ live) stay for the bootstrap config.
          const rawRows = (Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : []).filter(Boolean);
          const models = extractModels(body);
          if (models.length) {
            bucket.cached = models;
            bucket.raw = rawRows;
            bucket.fetchedAt = Date.now();
            bucket.emptyAt = 0;
            lastCached = models;
          } else {
            bucket.emptyAt = Date.now();
          }
          return models.length ? models : (bucket.cached ?? []);
        } catch (e) {
          // 瞬时失败保留上次成功清单；没有就交给调用方兜底。
          if (bucket.cached) return bucket.cached;
          throw e;
        } finally {
          bucket.inflight = null;
        }
      })();

      return bucket.inflight;
    },
  };
}

/* ------------------------------------------------------- magpie 对象形状 */

const hasNonTextInput = (m) => (m.inputModalities ?? []).some((modality) => modality !== "text");

function modalityFlags(modalities) {
  const l = list(modalities) ?? ["text"];
  return {
    text: l.includes("text"),
    image: l.includes("image"),
    audio: l.includes("audio"),
    video: l.includes("video"),
    pdf: l.includes("pdf"),
  };
}

/**
 * 推理档位：每个 key 是档位，value 是该协议真正要发的参数。
 * Chat 用 reasoningEffort；Anthropic 用 thinking/output_config；Responses 只留 none。
 */
function variantsOf(m, protocol = "chat") {
  if (m.reasoning !== true) return {};
  const efforts = Array.isArray(m.efforts) && m.efforts.length ? m.efforts : ["none", "low", "high"];
  const out = {};
  for (const level of efforts.filter((x) => ["none", "low", "high"].includes(x))) {
    if (protocol === "responses") {
      if (level === "none") out[level] = { reasoningEffort: "none" };
      continue;
    }
    if (protocol === "anthropic") {
      out[level] =
        level === "none"
          ? { thinking: { type: "disabled" } }
          : { thinking: { type: "enabled" }, output_config: { effort: level } };
      continue;
    }
    out[level] = { reasoningEffort: level };
  }
  return out;
}

/** 按 wire 协议裁掉视频：只有 Chat Completions 支持视频。 */
function inputsFor(m, video) {
  const inputs = m.inputModalities ?? ["text"];
  return video === false ? inputs.filter((x) => x !== "video") : inputs;
}

/** `config` 里声明一条模型。 */
export function toConfigModel(m, { video = true, protocol = "chat" } = {}) {
  const inputs = inputsFor(m, video);
  const out = {
    name: m.name,
    reasoning: m.reasoning === true,
    tool_call: m.supportsTools === true,
    attachment: hasNonTextInput({ inputModalities: inputs }),
    modalities: { input: inputs, output: m.outputModalities },
    limit: { context: m.contextLength, output: m.maxCompletionTokens },
  };
  const variants = variantsOf(m, protocol);
  if (Object.keys(variants).length) out.variants = variants;
  return out;
}

/** `provider.models` 返回的一条模型。 */
export function toProviderModel(m, providerID, { baseURL = DEFAULT_BASE_URL, npm = NPM, video = true, protocol = "chat" } = {}) {
  const inputs = inputsFor(m, video);
  return {
    id: m.id,
    providerID,
    name: m.name,
    api: { id: m.id, url: baseURL.replace(/\/+$/, ""), npm },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: m.contextLength, output: m.maxCompletionTokens },
    capabilities: {
      temperature: true,
      reasoning: m.reasoning === true,
      attachment: hasNonTextInput({ inputModalities: inputs }),
      toolcall: m.supportsTools === true,
      input: modalityFlags(inputs),
      output: modalityFlags(m.outputModalities),
      interleaved: false,
    },
    release_date: m.released ?? "",
    variants: variantsOf(m, protocol),
  };
}

/**
 * 给“用回了兜底清单”的返回打标记：magpie 据此在界面上说明
 * "这是插件自己的缺省清单，不是这家现在给你的清单"。
 */
export function fellBack(map) {
  const out = { ...map };
  out[Symbol.for("magpie.fellBack")] = true;
  return out;
}

/**
 * A catalogue row as the provider lists it (the shape api.test.mjs reads).
 * The reasoning tiers are the catalogue's own supported_features gate: a model
 * that stops reasoning stops offering tiers. The tier set is deliberately the
 * common three (none/low/high): the platform publishes no per-model list, and
 * a wrong tier is answered loudly with a 400 rather than silently.
 */
export function modelOf(row) {
  const r = row ?? {};
  const features = Array.isArray(r.supported_features) ? r.supported_features : [];
  const reasoning = r.reasoning !== undefined ? r.reasoning === true : features.includes("reasoning");
  const image = Array.isArray(r.input_modalities) ? r.input_modalities.includes("image") : false;
  const out = {
    id: r.id,
    name: r.name || r.id,
    limit: { context: r.context ?? 0, output: r.output ?? 0 },
    reasoning,
    tool_call: features.includes("tools"),
    modalities: { input: image ? ["text", "image"] : ["text"], output: ["text"] },
    capabilities: {
      reasoning,
      toolcall: true,
      attachment: image,
      input: { text: true, image },
      output: { text: true },
    },
    ...(reasoning ? { variants: { none: { reasoningEffort: "none" }, low: { reasoningEffort: "low" }, high: { reasoningEffort: "high" } } } : {}),
  };
  return out;
}