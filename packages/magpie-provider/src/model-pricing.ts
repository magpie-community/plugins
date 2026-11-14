/**
 * Model pricing utilities
 *
 * 模型价格统一以美元 / 百万 tokens 表示。Provider 使用的模型 key 可能不同，
 * 调用 getModelPricing 时会先归一化到规范 key，避免同一模型在多个插件中维护多份价格。
 */

export interface ModelPricing {
  input: number;
  output: number;
  cache?: {
    read?: number;
    write?: number;
  };
  tiers?: (Omit<ModelPricing, 'tiers'> & { tier: { type: 'context'; size: number } })[];
}

export type ModelPricingProvider = 'astra' | 'boxai' | 'codebuddy' | 'cursor' | 'imate' | 'kalm';

interface ModelPricingEntry {
  default: ModelPricing;
  providers?: Partial<Record<ModelPricingProvider, ModelPricing>>;
}

const MODEL_PRICING_ALIASES: Record<string, string> = {
  'claude-opus-4-6': 'claude-opus-4.6',
  'claude-opus-4-7': 'claude-opus-4.7',
  'claude-opus-4-8': 'claude-opus-4.8',
  'claude-opus-5-5': 'claude-opus-5.5',
  'claude-opus-4.6-1m': 'claude-opus-4.6',
  'claude-opus-4.7-1m': 'claude-opus-4.7',
  'claude-opus-4.8-1m': 'claude-opus-4.8',
  'claude-opus-5.5-1m': 'claude-opus-5.5',
  'claude-sonnet-4-6': 'claude-sonnet-4.6',
  'claude-sonnet-4.6-1m': 'claude-sonnet-4.6',
  'claude-sonnet-5-1m': 'claude-sonnet-5',
  'deepseek-v3-2': 'deepseek-v3.2',
  'deepseek-v3-2-volc-ioa': 'deepseek-v3.2',
  'deepseek-v4-flash-external': 'deepseek-v4-flash',
  'deepseek-v4-flash-official': 'deepseek-v4-flash',
  'deepseek-v4-flash-ioa': 'deepseek-v4-flash',
  'deepseek-v4-flash-0731': 'deepseek-v4-flash',
  'deepseek-v4.1-flash': 'deepseek-v4-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-v4-flash',
  'deepseek-v4-pro-external': 'deepseek-v4-pro',
  'deepseek-v4-pro-official': 'deepseek-v4-pro',
  'deepseek-v4-pro-ioa': 'deepseek-v4-pro',
  'gemini-3-1-pro': 'gemini-3.1-pro',
  'gemini-3-5-flash': 'gemini-3.5-flash',
  'glm-5-1': 'glm-5.1',
  'glm-5-2-internal': 'glm-5.2',
  'glm-5-3-internal': 'glm-5.3',
  'glm-5-3-flash-internal': 'glm-5.3-flash',
  'glm-5.1-external': 'glm-5.1',
  'glm-5.2-external': 'glm-5.2',
  'glm-5-1-ioa': 'glm-5.1',
  'glm-5-2-ioa': 'glm-5.2',
  'glm-5.0-ioa': 'glm-5.0',
  'glm-4.6-ioa': 'glm-4.6',
  'glm-4.6v-ioa': 'glm-4.6v',
  'glm-4.7-ioa': 'glm-4.7',
  'glm-5-fp8-ioa': 'glm-5-fp8',
  'glm-5v-turbo-ioa': 'glm-5v-turbo',
  'glm-5-turbo-external': 'glm-5-turbo',
  'glm-5v-turbo': 'glm-5v-turbo',
  'gpt-5-4': 'gpt-5.4',
  'gpt-5-4-mini': 'gpt-5.4-mini',
  'gpt-5-4-nano': 'gpt-5.4-nano',
  'gpt-5-5': 'gpt-5.5',
  'gpt-5-6-sol': 'gpt-5.6-sol',
  'gpt-5-6-terra': 'gpt-5.6-terra',
  'gpt-5-6-luna': 'gpt-5.6-luna',
  'gpt-6-1-sol': 'gpt-6.1-sol',
  'hy3-ioa': 'hy-3',
  hy3: 'hy-3',
  'hy-4-preview': 'hy4-preview',
  'kimi-k2.6-external': 'kimi-k2.6',
  'kimi-k2.6-ioa': 'kimi-k2.6',
  'minimax-m2.5-ioa': 'minimax-m2.5',
  'minimax-m2.7-ioa': 'minimax-m2.7',
  'minimax-m3-external': 'minimax-m3',
  'cursor-grok-4.5': 'grok-4.5',
  'cursor-grok-4.7': 'grok-4.7',
};

const PROVIDER_MODEL_SUFFIXES = ['-external', '-internal', '-ioa', '-official'];
const CAPABILITY_SUFFIXES = ['-fast'];
const CONTEXT_SUFFIX_REGEX = /-(\d+)(k|m)$/i;

const stripContextSuffixes = (key: string): string => key.replace(CONTEXT_SUFFIX_REGEX, '');

/**
 * Cursor 的 `cursor` provider 价格由其自身账单反解得到，不是厂商 list price。
 *
 * Cursor 对缓存读取另有加价（Opus 实测 $0.75/M，Anthropic list 为 $0.50/M），
 * 而缓存读取又占实际 token 量的 95% 以上；沿用 list price 会系统性少算。
 * 这些数字是对 7.5k 条 Cursor usage event 做非负最小二乘拟合的结果，
 * 复算当月账单为实际值的 99%（沿用 list price 时只有 49%）。
 * 缓存读写一律取拟合值；Anthropic 系的 input/output 保留 list price，
 * 因为绝大多数 prompt 都走缓存，拟合无法把 output 与 cache_write 分开。
 */
const MODEL_PRICINGS: Record<string, ModelPricingEntry> = {
  // CodeBuddy 未提供这些模型的价格；集中保留原先的 0 成本 fallback，
  // 以便后续拿到价格时只需更新 shared 注册表。
  'claude-haiku-4.5': {
    default: { input: 1, output: 5 },
    providers: {
      cursor: { input: 1, output: 5.25, cache: { read: 0.35, write: 1.5 } },
    },
  },
  'claude-sonnet-4.6': {
    default: { input: 3, output: 15 },
    providers: {
      boxai: { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
      cursor: { input: 3, output: 15.25, cache: { read: 0.55, write: 4 } },
    },
  },
  'claude-sonnet-5': {
    default: { input: 3, output: 15 },
    providers: {
      cursor: { input: 3, output: 15, cache: { read: 0.45, write: 2.75 } },
    },
  },
  // Sonnet 5.5 与 Sonnet 5 平台倍率同为 x1.33（2026-10-02 /v3/config 目录实测
  // credits 字段一致），显式条目；findVersionFallbackKey 本就回退到 claude-sonnet-5，
  // 此处固定下来避免旗舰价依赖隐式回退。
  'claude-sonnet-5.5': {
    default: { input: 3, output: 15 },
  },
  // Anthropic 官方：Opus 4.5+ / Opus 5 均为 $5/$25；cache read 0.1x、5m write 1.25x
  // 旧 Opus 4 / 4.1 才是 $15/$75，勿再套到 4.5 之后的型号
  'claude-opus-4.5': {
    default: { input: 5, output: 25, cache: { read: 0.5, write: 6.25 } },
  },
  'claude-opus-4.6': {
    default: { input: 5, output: 25, cache: { read: 0.5, write: 6.25 } },
    providers: {
      boxai: { input: 5, output: 25, cache: { read: 0.5, write: 6.25 } },
      cursor: { input: 5, output: 25, cache: { read: 0.75, write: 6.5 } },
    },
  },
  'claude-opus-4.7': {
    default: { input: 5, output: 25, cache: { read: 0.5, write: 6.25 } },
    providers: {
      boxai: { input: 5, output: 25, cache: { read: 0.5, write: 6.25 } },
    },
  },
  'claude-opus-4.8': {
    default: { input: 5, output: 25, cache: { read: 0.5, write: 6.25 } },
    providers: {
      boxai: { input: 5, output: 25, cache: { read: 0.5, write: 6.25 } },
      cursor: { input: 5, output: 25, cache: { read: 0.77, write: 6.59 } },
    },
  },
  'claude-opus-5': {
    default: { input: 5, output: 25, cache: { read: 0.5, write: 6.25 } },
    providers: {
      cursor: { input: 5, output: 25, cache: { read: 0.75, write: 6.5 } },
    },
  },
  // Cursor 2026-09: Opus 5.5 list matches Opus 5; Cursor cache rates not yet
  // re-fit, so reuse Opus 5 Cursor override until usage samples land.
  'claude-opus-5.5': {
    default: { input: 5, output: 25, cache: { read: 0.5, write: 6.25 } },
    providers: {
      cursor: { input: 5, output: 25, cache: { read: 0.75, write: 6.5 } },
    },
  },
  'composer-2.5': {
    default: { input: 3, output: 15 },
    providers: {
      cursor: { input: 0.66, output: 4.5, cache: { read: 0.42 } },
    },
  },
  // Cursor 对 Fast 变体单独计价，约为普通档的 3 倍，必须单列。
  'composer-2.5-fast': {
    default: { input: 3, output: 15 },
    providers: {
      cursor: { input: 2.73, output: 13.23, cache: { read: 0.76 } },
    },
  },
  'deepseek-v3.2': { default: { input: 0.29, output: 0.43 } },
  // DeepSeek 官方 API 高峰价（2026-08-17 起峰谷定价，空闲时段为半价）
  // 高峰北京时间 9:00-12:00、14:00-18:00；人民币价 / 7 换 USD
  // flash 高峰：缓存命中 0.10 / 未命中 3.0 / 输出 9.0 元
  // pro 高峰：缓存命中 0.30 / 未命中 9.0 / 输出 27.0 元
  'deepseek-v4-flash': {
    default: { input: 0.429, output: 1.286, cache: { read: 0.014 } },
  },
  'deepseek-v4-pro': {
    default: { input: 1.286, output: 3.857, cache: { read: 0.043 } },
  },
  'gemini-3.1-pro': { default: { input: 2, output: 12 } },
  'gemini-3.5-flash': {
    default: { input: 1.55, output: 9.45 },
    providers: { boxai: { input: 0.15, output: 0.6 } },
  },
  'gemini-3.6-flash': {
    default: { input: 1.5, output: 7.5 },
    providers: {
      cursor: { input: 1.75, output: 7.75, cache: { read: 0.4 } },
    },
  },
  // Cursor docs 2026-09: $0.75/$3.50, cached input 90% off.
  'gemini-3.8-flash': {
    default: { input: 0.75, output: 3.5, cache: { read: 0.075 } },
    providers: {
      cursor: { input: 0.75, output: 3.5, cache: { read: 0.075 } },
    },
  },
  // Cursor docs 2026-10-14: Gemini 4 Argon $2/$10, cache read $0.1, no cache write.
  // Google intro price through 2026-11-30; list price becomes $4/$0.20/$20 on 2026-12-01.
  'gemini-4-argon': {
    default: { input: 2, output: 10, cache: { read: 0.1 } },
    providers: {
      cursor: { input: 2, output: 10, cache: { read: 0.1 } },
    },
  },
  'gemini-2.5-pro': { default: { input: 0, output: 0 } },
  'glm-4.6': { default: { input: 0, output: 0 } },
  'glm-4.6v': { default: { input: 0, output: 0 } },
  'glm-4.7': { default: { input: 0, output: 0 } },
  'glm-5.0': { default: { input: 0, output: 0 } },
  'glm-5-fp8': {
    default: { input: 1, output: 3.2 },
  },
  'glm-5.1': {
    default: { input: 1.4, output: 4.4 },
    providers: {
      astra: { input: 1, output: 3.2 },
      boxai: { input: 1.4, output: 4.4, cache: { read: 0.26 } },
      kalm: { input: 1, output: 3.2 },
    },
  },
  'glm-5.2': {
    default: { input: 1.4, output: 4.4 },
    providers: {
      astra: { input: 1, output: 3.2 },
      boxai: { input: 1.4, output: 4.4, cache: { read: 0.26 } },
      kalm: { input: 1, output: 3.2 },
    },
  },
  // 智谱官方价（bigmodel 国内 ¥8/¥28、TokenHub 国际 $1.4/$4.4，2026-09-25 核对）。
  // Astra/Kalm/iMate 内部价待补，按既有内部服务惯例显示 0。
  'glm-5.3': {
    default: { input: 1.4, output: 4.4, cache: { read: 0.26 } },
    providers: {
      astra: { input: 0, output: 0 },
      kalm: { input: 0, output: 0 },
      imate: { input: 0, output: 0 },
    },
  },
  'glm-5.3-flash': {
    default: { input: 0.15, output: 0.5, cache: { read: 0.03 } },
    providers: {
      astra: { input: 0, output: 0 },
      kalm: { input: 0, output: 0 },
      imate: { input: 0, output: 0 },
    },
  },
  // 2026-09-18 上线，Flash 的 2.5 倍定价（TokenHub 国际 $0.37/$1.25）。
  'glm-5.3-flashx': {
    default: { input: 0.37, output: 1.25, cache: { read: 0.075 } },
  },
  // GLM 5.3 Apex（Astra App ID apex_glm5d3_w4a8_p800）：GLM-5.3 的 W4A8 量化 +
  // PD 分离部署档，能力与 glm-5.3 一致，价格沿用 GLM-5.3（官方默认 + astra 内部 0）。
  apex_glm5d3_w4a8_p800: {
    default: { input: 1.4, output: 4.4, cache: { read: 0.26 } },
    providers: {
      astra: { input: 0, output: 0 },
    },
  },
  'glm-5-turbo': {
    default: { input: 1.2, output: 4, cache: { read: 0.24 } },
  },
  'glm-5v-turbo': {
    default: { input: 1.2, output: 4, cache: { read: 0.24 } },
  },
  'grok-4.5': {
    default: { input: 3, output: 15 },
    providers: {
      cursor: { input: 1.53, output: 6.88, cache: { read: 0.249 } },
    },
  },
  'grok-4.5-fast': {
    default: { input: 3, output: 15 },
    providers: {
      cursor: { input: 2.62, output: 14.45, cache: { read: 0.588 } },
    },
  },
  // Cursor docs 2026-09-21: standard $2/$6 cache $0.50; Fast 2x.
  // Input above 256k bills 2x standard / Fast at 3x standard; SKU cost
  // stays at the listed rate because billing follows actual input length.
  'grok-4.7': {
    default: { input: 2, output: 6, cache: { read: 0.5 } },
    providers: {
      cursor: { input: 2, output: 6, cache: { read: 0.5 } },
    },
  },
  'grok-4.7-fast': {
    default: { input: 4, output: 12, cache: { read: 1 } },
    providers: {
      cursor: { input: 4, output: 12, cache: { read: 1 } },
    },
  },
  'gpt-5.6-sol': {
    // OpenAI API 2026-08-21 起促销价（原 $5/$30），至少到 2026-11-21
    default: { input: 4, output: 20, cache: { read: 0.4, write: 5 } },
    providers: {
      cursor: { input: 5, output: 29.07, cache: { read: 0.735, write: 6.4 } },
    },
  },
  'gpt-5.6-sol-fast': {
    default: { input: 8, output: 40, cache: { read: 0.8, write: 10 } },
  },
  'gpt-5.6-terra': {
    // OpenAI API 2026-07-30 降价 20%（原 $2.5/$15）
    default: { input: 2, output: 12, cache: { read: 0.2, write: 2.5 } },
    providers: {
      cursor: { input: 2.5, output: 15.25, cache: { read: 0.5, write: 3.375 } },
    },
  },
  'gpt-5.6-terra-fast': {
    default: { input: 4, output: 24, cache: { read: 0.4, write: 5 } },
  },
  'gpt-5.6-luna': {
    // OpenAI API 2026-07-30 降价 80%（原 $1/$6）
    default: { input: 0.2, output: 1.2, cache: { read: 0.02, write: 0.25 } },
  },
  'gpt-5.6-luna-fast': {
    default: { input: 0.4, output: 2.4, cache: { read: 0.04, write: 0.5 } },
  },
  'gpt-6-astra': {
    // OpenAI 2026-09-03 发布；>272K 长上下文整单按 $20/$75 计。
    default: {
      input: 10,
      output: 50,
      cache: { read: 1, write: 12.5 },
      tiers: [
        {
          input: 20,
          output: 75,
          cache: { read: 2, write: 25 },
          tier: { type: 'context', size: 272000 },
        },
      ],
    },
  },
  'gpt-6-astra-fast': {
    default: {
      input: 20,
      output: 100,
      cache: { read: 2, write: 25 },
      tiers: [
        {
          input: 40,
          output: 150,
          cache: { read: 4, write: 50 },
          tier: { type: 'context', size: 272000 },
        },
      ],
    },
  },
  // OpenAI 官方价：上线 $4/$20、$0.2/$1.2，2026-09 降 50% 后 $2/$10、$0.1/$0.5
  // （openai.com/index/introducing-gpt-6-sol-and-luna；developers.openai.com 定价页）。
  'gpt-6-sol': {
    // 网关额度倍率 x1.33
    default: {
      input: 2,
      output: 10,
      cache: { read: 0.2, write: 2.5 },
      tiers: [
        {
          input: 4,
          output: 15,
          cache: { read: 0.4, write: 5 },
          tier: { type: 'context', size: 272000 },
        },
      ],
    },
  },
  'gpt-6-sol-fast': {
    default: {
      input: 4,
      output: 20,
      cache: { read: 0.4, write: 5 },
      tiers: [
        {
          input: 8,
          output: 30,
          cache: { read: 0.8, write: 10 },
          tier: { type: 'context', size: 272000 },
        },
      ],
    },
  },
  'gpt-6-luna': {
    // 网关额度倍率 x0.07
    default: {
      input: 0.1,
      output: 0.5,
      cache: { read: 0.01, write: 0.125 },
      tiers: [
        {
          input: 0.2,
          output: 0.75,
          cache: { read: 0.02, write: 0.25 },
          tier: { type: 'context', size: 272000 },
        },
      ],
    },
  },
  'gpt-6-luna-fast': {
    default: {
      input: 0.2,
      output: 1,
      cache: { read: 0.02, write: 0.25 },
      tiers: [
        {
          input: 0.4,
          output: 1.5,
          cache: { read: 0.04, write: 0.5 },
          tier: { type: 'context', size: 272000 },
        },
      ],
    },
  },
  'gpt-6.1-sol': {
    default: {
      input: 2,
      output: 10,
      cache: { read: 0.1, write: 2.5 },
      tiers: [
        {
          input: 4,
          output: 15,
          cache: { read: 0.2, write: 5 },
          tier: { type: 'context', size: 272000 },
        },
      ],
    },
  },
  'gpt-6.1-sol-fast': {
    default: {
      input: 4,
      output: 20,
      cache: { read: 0.2, write: 5 },
      tiers: [
        {
          input: 8,
          output: 30,
          cache: { read: 0.4, write: 10 },
          tier: { type: 'context', size: 272000 },
        },
      ],
    },
  },
  'gpt-5.5': {
    default: { input: 5, output: 30, cache: { read: 0.5 } },
    providers: {
      cursor: { input: 3.61, output: 13.82, cache: { read: 0.795 } },
    },
  },
  'gpt-5.5-fast': {
    default: { input: 12.5, output: 75, cache: { read: 1.25 } },
  },
  'gpt-5.4': {
    default: { input: 2.5, output: 15, cache: { read: 0.25 } },
  },
  'gpt-5.4-fast': {
    default: { input: 5, output: 30, cache: { read: 0.5 } },
  },
  'gpt-5.4-mini': {
    default: { input: 0.75, output: 4.5, cache: { read: 0.075 } },
  },
  'gpt-5.4-nano': { default: { input: 0.2, output: 1.25 } },
  'gpt-5.3-codex': { default: { input: 0, output: 0 } },
  'gpt-5.1-codex': { default: { input: 0, output: 0 } },
  'gpt-5.1-codex-mini': { default: { input: 0, output: 0 } },
  'hy-3': { default: { input: 0.5, output: 2 } },
  'kimi-k2.5': { default: { input: 0.6, output: 3 } },
  'kimi-k2-thinking': { default: { input: 0, output: 0 } },
  'kimi-k2.6': {
    default: { input: 0.6, output: 3 },
    providers: { boxai: { input: 2, output: 8 } },
  },
  'kimi-k2.7': { default: { input: 0.95, output: 4 } },
  'kimi-k3': { default: { input: 3, output: 15, cache: { read: 0.3 } } },
  // TokenHub 官方价 $1/$4（2026-09-25 核对，与 k2.7 同渠道；网关额度倍率 x0.77）
  'kimi-k2.8-preview': {
    default: { input: 1, output: 4, cache: { read: 0.25 } },
  },
  'minimax-m2.5': { default: { input: 0.3, output: 1.2 } },
  'minimax-m2.7': { default: { input: 0.3, output: 1.2 } },
  'minimax-m3': {
    default: { input: 0.6, output: 2.4, cache: { read: 0.12 } },
    providers: { astra: { input: 0.3, output: 1.2 } },
  },
  'deepseek-v4-pro-0813': { default: { input: 0, output: 0 } },
  // 腾讯 TokenHub 官方价 $0.834/$2.501（2026-09-25 核对）；Astra/Kalm/iMate 内部价待补。
  'hy4-preview': {
    default: { input: 0.834, output: 2.501, cache: { read: 0.042 } },
    providers: {
      astra: { input: 0, output: 0 },
      kalm: { input: 0, output: 0 },
      imate: { input: 0, output: 0 },
    },
  },
  'qwen3.8-27b': { default: { input: 0, output: 0 } },
  'qwen3.8-flash-next': { default: { input: 0, output: 0 } },
  // 小米 MiMo-V2.6（2026-09-22 官方定价）。Pro：$0.435/$0.87，缓存命中 $0.0036；
  // Flash：$0.14/$0.28，缓存命中 $0.0028。key 沿用 Astra App ID，Kalm 侧复用同价。
  'MiMo-V2.6-Flash-RL-astra': {
    default: { input: 0.14, output: 0.28, cache: { read: 0.0028 } },
  },
  'MiMo-V2.6-Pro-RL-astra': {
    default: { input: 0.435, output: 0.87, cache: { read: 0.0036 } },
  },
};

const clonePricing = (pricing: ModelPricing): ModelPricing => ({
  input: pricing.input,
  output: pricing.output,
  ...(pricing.cache ? { cache: { ...pricing.cache } } : {}),
  ...(pricing.tiers
    ? { tiers: pricing.tiers.map((entry) => ({ ...clonePricing(entry), tier: { ...entry.tier } })) }
    : {}),
});

type VersionedModelKey = {
  key: string;
  family: string;
  isFast: boolean;
  major: number;
  minor: number;
};

const stripProviderSuffixes = (key: string): string => {
  const suffix = PROVIDER_MODEL_SUFFIXES.find((candidate) => key.endsWith(candidate));
  return suffix ? stripProviderSuffixes(key.slice(0, -suffix.length)) : key;
};

const normalizeVersionSeparators = (key: string): string =>
  key.replace(/^([a-z]+(?:-[a-z]+)*)-(\d+)-(\d+)(?=-|$)/, '$1-$2.$3');

/** Peel a trailing capability suffix so the base can be normalized on its own. */
const splitCapabilitySuffix = (key: string): { base: string; capability: string } => {
  const suffix = CAPABILITY_SUFFIXES.find((candidate) => key.endsWith(candidate));
  return suffix
    ? { base: key.slice(0, -suffix.length), capability: suffix }
    : { base: key, capability: '' };
};

const normalizeModelPricingKey = (key: string): string => {
  const withoutProviderSuffixes = stripProviderSuffixes(key);
  const withoutContext = stripContextSuffixes(withoutProviderSuffixes);
  const normalizedVersion = normalizeVersionSeparators(withoutContext);
  return (
    MODEL_PRICING_ALIASES[key] ??
    MODEL_PRICING_ALIASES[withoutProviderSuffixes] ??
    MODEL_PRICING_ALIASES[withoutContext] ??
    MODEL_PRICING_ALIASES[normalizedVersion] ??
    normalizedVersion
  );
};

const parseVersionedModelKey = (key: string): VersionedModelKey | undefined => {
  const match = /^([a-z]+(?:-[a-z]+)*)-(\d+)(?:\.(\d+))?(?:-.+)?$/.exec(key);
  if (!match) return undefined;

  return {
    key,
    family: match[1],
    isFast: key.endsWith('-fast'),
    major: Number(match[2]),
    minor: Number(match[3] ?? 0),
  };
};

const compareModelVersions = (left: VersionedModelKey, right: VersionedModelKey): number =>
  left.major === right.major ? left.minor - right.minor : left.major - right.major;

const getFallbackPriority = (candidate: VersionedModelKey): number =>
  candidate.key.includes('-sol') ? 1 : 0;

const findVersionFallbackKey = (key: string): string | undefined => {
  const requested = parseVersionedModelKey(key);
  if (!requested) return undefined;

  const candidates = Object.keys(MODEL_PRICINGS)
    .map(parseVersionedModelKey)
    .filter(
      (candidate): candidate is VersionedModelKey =>
        candidate !== undefined &&
        candidate.family === requested.family &&
        candidate.isFast === requested.isFast &&
        candidate.major === requested.major &&
        compareModelVersions(candidate, requested) <= 0,
    )
    .sort(
      (left, right) =>
        compareModelVersions(right, left) ||
        getFallbackPriority(right) - getFallbackPriority(left) ||
        left.key.localeCompare(right.key),
    );

  return candidates[0]?.key;
};

/**
 * 将 Provider 特有模型 ID 归一化为共享价格 key。
 *
 * 优先级：精确 key → 显式别名 → 去 Provider 后缀 → 同家族同主版本的最近已知版本。
 * 未知 SKU 不会跨主版本猜测价格。
 *
 * 能力后缀（`-fast`）先摘掉再归一化基础 key，否则 `<base>-<context>-fast`
 * 里的 context 位于中间，既剥不掉也命不中别名，整个 SKU 会拿不到价格。
 */
export const resolveModelPricingKey = (key: string): string | undefined => {
  if (MODEL_PRICINGS[key]) return key;
  const { base, capability } = splitCapabilitySuffix(key);
  const normalizedBase = normalizeModelPricingKey(base);
  const candidates = capability
    ? [`${normalizedBase}${capability}`, normalizedBase]
    : [normalizedBase];

  for (const candidate of candidates) {
    if (MODEL_PRICINGS[candidate]) return candidate;
    const versionFallback = findVersionFallbackKey(candidate);
    if (versionFallback) return versionFallback;
  }
  return undefined;
};

/**
 * 获取模型的统一价格；未知模型返回 undefined，调用方保留自己的 fallback。
 */
export const getModelPricing = (
  key: string,
  provider?: ModelPricingProvider,
): ModelPricing | undefined => {
  const resolvedKey = resolveModelPricingKey(key);
  const entry = resolvedKey ? MODEL_PRICINGS[resolvedKey] : undefined;
  const pricing = provider ? (entry?.providers?.[provider] ?? entry?.default) : entry?.default;
  return pricing ? clonePricing(pricing) : undefined;
};

/** 获取模型价格；用于内置模型表，缺失价格属于注册表错误。 */
export const getRequiredModelPricing = (
  key: string,
  provider?: ModelPricingProvider,
): ModelPricing => {
  const pricing = getModelPricing(key, provider);
  if (pricing) return pricing;
  throw new Error(`Missing shared pricing for model: ${key}`);
};

/** 获取已注册的规范模型默认价格，返回副本以避免外部修改共享注册表。 */
export const getAllModelPricings = (): Readonly<Record<string, ModelPricing>> =>
  Object.fromEntries(
    Object.entries(MODEL_PRICINGS).map(([key, entry]) => [key, clonePricing(entry.default)]),
  );
