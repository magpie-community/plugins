import { describe, expect, it } from 'bun:test';
import {
  getAllModelPricings,
  getModelPricing,
  resolveModelPricingKey,
} from '../src/model-pricing.js';

describe('getModelPricing', () => {
  it('registers current internal service pricing', () => {
    ['glm-5.3', 'glm-5.3-flash', 'deepseek-v4-pro-0813', 'hy4-preview'].forEach((key) => {
      expect(getModelPricing(key, 'astra')).toEqual({ input: 0, output: 0 });
      expect(getModelPricing(key, 'kalm')).toEqual({ input: 0, output: 0 });
      expect(getModelPricing(key, 'imate')).toEqual({ input: 0, output: 0 });
    });
    expect(resolveModelPricingKey('qwen3.8-27b')).toBe('qwen3.8-27b');
    expect(getModelPricing('qwen3.8-27b', 'astra')).toEqual({
      input: 0,
      output: 0,
    });
    expect(getModelPricing('qwen3.8-27b', 'kalm')).toEqual({
      input: 0,
      output: 0,
    });
    expect(resolveModelPricingKey('qwen3.8-flash-next')).toBe('qwen3.8-flash-next');
    expect(getModelPricing('qwen3.8-flash-next', 'astra')).toEqual({
      input: 0,
      output: 0,
    });
  });

  it('registers official GLM-5.3 family and 2026-09 refresh prices', () => {
    // 智谱官方价（TokenHub 国际 USD，2026-09-25 核对；bigmodel 国内 ¥8/¥28 等同源）
    expect(getModelPricing('glm-5.3', 'codebuddy')).toEqual({
      input: 1.4,
      output: 4.4,
      cache: { read: 0.26 },
    });
    expect(getModelPricing('glm-5.3-flash', 'codebuddy')).toEqual({
      input: 0.15,
      output: 0.5,
      cache: { read: 0.03 },
    });
    // FlashX 2026-09-18 上线，Flash 的 2.5 倍定价
    expect(getModelPricing('glm-5.3-flashx', 'codebuddy')).toEqual({
      input: 0.37,
      output: 1.25,
      cache: { read: 0.075 },
    });
    // 腾讯 TokenHub 官方价
    expect(getModelPricing('hy4-preview', 'codebuddy')).toEqual({
      input: 0.834,
      output: 2.501,
      cache: { read: 0.042 },
    });
    // Moonshot 官方价（TokenHub）
    expect(getModelPricing('kimi-k2.8-preview', 'codebuddy')).toEqual({
      input: 1,
      output: 4,
      cache: { read: 0.25 },
    });
    // OpenAI 官方价（2026-09 降价 50% 后）
    expect(getModelPricing('gpt-6-sol', 'codebuddy')).toEqual({
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
    });
    expect(getModelPricing('gpt-6-luna', 'codebuddy')).toEqual({
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
    });
  });

  it('registers GLM 5.3 Apex and MiMo V2.6 prices', () => {
    // Apex 沿用 GLM-5.3 官方价，astra 内部价 0
    expect(resolveModelPricingKey('apex_glm5d3_w4a8_p800')).toBe('apex_glm5d3_w4a8_p800');
    expect(getModelPricing('apex_glm5d3_w4a8_p800', 'astra')).toEqual({
      input: 0,
      output: 0,
    });
    expect(getModelPricing('apex_glm5d3_w4a8_p800')).toEqual({
      input: 1.4,
      output: 4.4,
      cache: { read: 0.26 },
    });
    // 小米 MiMo-V2.6 官方价；astra / kalm 均复用 default
    expect(getModelPricing('MiMo-V2.6-Pro-RL-astra', 'astra')).toEqual({
      input: 0.435,
      output: 0.87,
      cache: { read: 0.0036 },
    });
    expect(getModelPricing('MiMo-V2.6-Pro-RL-astra', 'kalm')).toEqual({
      input: 0.435,
      output: 0.87,
      cache: { read: 0.0036 },
    });
    expect(getModelPricing('MiMo-V2.6-Flash-RL-astra', 'kalm')).toEqual({
      input: 0.14,
      output: 0.28,
      cache: { read: 0.0028 },
    });
  });

  it('normalizes iMate channel-suffixed keys to canonical pricing', () => {
    expect(resolveModelPricingKey('glm-5-3-internal')).toBe('glm-5.3');
    expect(resolveModelPricingKey('glm-5-3-flash-internal')).toBe('glm-5.3-flash');
    expect(resolveModelPricingKey('hy-4-preview')).toBe('hy4-preview');
    // deepseek 的 "v4" 前缀不满足版本回退解析，须走显式别名
    expect(resolveModelPricingKey('deepseek-v4.1-flash')).toBe('deepseek-v4-flash');
    expect(getModelPricing('deepseek-v4.1-flash', 'codebuddy')).toEqual({
      input: 0.429,
      output: 1.286,
      cache: { read: 0.014 },
    });
    expect(resolveModelPricingKey('gpt-6-astra')).toBe('gpt-6-astra');
    // iMate 消耗速率 5.72x 换算 ≈ 官方 list（sol 2.29x ↔ $4/$20 锚定），直接走 default
    expect(getModelPricing('gpt-6-astra', 'imate')).toEqual({
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
    });
  });

  it('does not price a stale Hy4 Dev alias', () => {
    // hy4-dev 已从所有 provider 的模型表中移除，不应再别名到 hy-3 的付费档；
    // 未注册的 key 一律解析失败，由调用方走自己的 fallback。
    expect(resolveModelPricingKey('hy4-dev')).toBeUndefined();
    expect(getModelPricing('hy4-dev')).toBeUndefined();
  });

  it('normalizes provider-specific GPT keys to canonical pricing', () => {
    expect(getModelPricing('gpt-5-5')).toEqual({
      input: 5,
      output: 30,
      cache: { read: 0.5 },
    });
    expect(getModelPricing('gpt-5-4')).toEqual({
      input: 2.5,
      output: 15,
      cache: { read: 0.25 },
    });
  });

  it('normalizes the CodeBuddy Kimi K3 model ID to official pricing', () => {
    expect(resolveModelPricingKey('kimi-k3-ioa')).toBe('kimi-k3');
    expect(getModelPricing('kimi-k3-ioa', 'codebuddy')).toEqual({
      input: 3,
      output: 15,
      cache: { read: 0.3 },
    });
  });

  it('registers the current GPT-5.6 and GPT-5.4 family prices', () => {
    expect(getAllModelPricings()).toMatchObject({
      'gpt-5.6-sol': {
        input: 4,
        output: 20,
        cache: { read: 0.4, write: 5 },
      },
      'gpt-5.6-terra': {
        input: 2,
        output: 12,
        cache: { read: 0.2, write: 2.5 },
      },
      'gpt-5.6-luna': {
        input: 0.2,
        output: 1.2,
        cache: { read: 0.02, write: 0.25 },
      },
      'gpt-5.6-sol-fast': {
        input: 8,
        output: 40,
        cache: { read: 0.8, write: 10 },
      },
      'gpt-5.6-terra-fast': {
        input: 4,
        output: 24,
        cache: { read: 0.4, write: 5 },
      },
      'gpt-5.6-luna-fast': {
        input: 0.4,
        output: 2.4,
        cache: { read: 0.04, write: 0.5 },
      },
      'gpt-6-astra': {
        input: 10,
        output: 50,
        cache: { read: 1, write: 12.5 },
      },
      'gpt-6-astra-fast': {
        input: 20,
        output: 100,
        cache: { read: 2, write: 25 },
      },
      'gpt-5.5-fast': { input: 12.5, output: 75, cache: { read: 1.25 } },
      'gpt-5.4-fast': { input: 5, output: 30, cache: { read: 0.5 } },
      'gpt-5.4-mini': {
        input: 0.75,
        output: 4.5,
        cache: { read: 0.075 },
      },
      'gpt-5.4-nano': { input: 0.2, output: 1.25 },
    });
  });

  it('normalizes provider keys while preserving provider-specific pricing', () => {
    expect(getModelPricing('deepseek-v4-flash-ioa', 'codebuddy')).toEqual({
      input: 0.429,
      output: 1.286,
      cache: { read: 0.014 },
    });
    expect(getModelPricing('deepseek-v4-flash', 'astra')).toEqual({
      input: 0.429,
      output: 1.286,
      cache: { read: 0.014 },
    });
    expect(getModelPricing('deepseek-v4-flash-0731', 'kalm')).toEqual({
      input: 0.429,
      output: 1.286,
      cache: { read: 0.014 },
    });
    expect(getModelPricing('deepseek-v4-flash-vision-exp', 'astra')).toEqual({
      input: 0.429,
      output: 1.286,
      cache: { read: 0.014 },
    });
    expect(getModelPricing('deepseek-v4-flash-external', 'boxai')).toEqual({
      input: 0.429,
      output: 1.286,
      cache: { read: 0.014 },
    });
  });

  it('normalizes future provider-suffixed model IDs to their model family', () => {
    expect(resolveModelPricingKey('gpt-5.6-ioa')).toBe('gpt-5.6-sol');
    expect(getModelPricing('gpt-5.6-ioa')).toEqual({
      input: 4,
      output: 20,
      cache: { read: 0.4, write: 5 },
    });
  });

  it('falls future model versions back to the newest known family version', () => {
    expect(resolveModelPricingKey('gpt-5.7')).toBe('gpt-5.6-sol');
    expect(resolveModelPricingKey('gpt-5.7-ioa')).toBe('gpt-5.6-sol');
    expect(resolveModelPricingKey('gpt-5.7-fast')).toBe('gpt-5.6-sol-fast');
    expect(resolveModelPricingKey('gpt-5.6-terra')).toBe('gpt-5.6-terra');
  });

  it('keeps fast SKUs separate from their standard model prices', () => {
    expect(resolveModelPricingKey('gpt-5.6-terra-fast-ioa')).toBe('gpt-5.6-terra-fast');
    expect(getModelPricing('gpt-5.6-terra-fast')).toEqual({
      input: 4,
      output: 24,
      cache: { read: 0.4, write: 5 },
    });
    expect(getModelPricing('gpt-5.5-fast')).toEqual({
      input: 12.5,
      output: 75,
      cache: { read: 1.25 },
    });
    expect(getModelPricing('gpt-5.4-mini')).toEqual({
      input: 0.75,
      output: 4.5,
      cache: { read: 0.075 },
    });
  });

  it('falls an unpriced fast capability suffix back to the base model', () => {
    expect(resolveModelPricingKey('deepseek-v4-pro-fast')).toBe('deepseek-v4-pro');
    expect(getModelPricing('deepseek-v4-pro-fast', 'imate')).toEqual({
      input: 1.286,
      output: 3.857,
      cache: { read: 0.043 },
    });
  });

  it('normalizes Cursor model keys with context window suffixes', () => {
    // Anthropic 官方 Opus 5 / 4.5+：$5/$25（非旧版 Opus 4.1 的 $15/$75）
    expect(getModelPricing('claude-opus-5-300k')).toEqual({
      input: 5,
      output: 25,
      cache: { read: 0.5, write: 6.25 },
    });
    expect(getModelPricing('claude-opus-5-1m')).toEqual({
      input: 5,
      output: 25,
      cache: { read: 0.5, write: 6.25 },
    });
    expect(resolveModelPricingKey('claude-opus-5-5-300k')).toBe('claude-opus-5.5');
    expect(getModelPricing('claude-opus-5-5-1m-fast', 'cursor')).toEqual({
      input: 5,
      output: 25,
      cache: { read: 0.75, write: 6.5 },
    });
    expect(getModelPricing('claude-opus-4.5-300k')).toEqual({
      input: 5,
      output: 25,
      cache: { read: 0.5, write: 6.25 },
    });
    expect(getModelPricing('gemini-3.6-flash-300k')).toEqual({
      input: 1.5,
      output: 7.5,
    });
    expect(getModelPricing('cursor-grok-4.5')).toEqual({
      input: 3,
      output: 15,
    });
    expect(getModelPricing('composer-2.5')).toEqual({
      input: 3,
      output: 15,
    });
  });

  it('resolves keys carrying both a context and a capability suffix', () => {
    // `-256k-fast` puts the context window mid-key, where an end-anchored
    // strip cannot reach it; these used to resolve to no pricing at all.
    expect(resolveModelPricingKey('cursor-grok-4.5-256k-fast')).toBe('grok-4.5-fast');
    expect(resolveModelPricingKey('grok-4.5-256k-fast')).toBe('grok-4.5-fast');
    expect(resolveModelPricingKey('cursor-grok-4.5-256k')).toBe('grok-4.5');
    expect(getModelPricing('cursor-grok-4.5-256k-fast')).toEqual({
      input: 3,
      output: 15,
    });
  });

  it('bills Cursor at its own rates without moving the vendor list price', () => {
    // Cursor marks cache reads up over the vendor list and prices Fast
    // variants separately; other providers must keep the list price.
    expect(getModelPricing('claude-opus-5-300k', 'cursor')).toEqual({
      input: 5,
      output: 25,
      cache: { read: 0.75, write: 6.5 },
    });
    expect(getModelPricing('claude-opus-5-300k')).toEqual({
      input: 5,
      output: 25,
      cache: { read: 0.5, write: 6.25 },
    });
    expect(getModelPricing('claude-sonnet-5', 'cursor')?.cache).toEqual({
      read: 0.45,
      write: 2.75,
    });
    expect(getModelPricing('claude-sonnet-5')?.cache).toBeUndefined();
    expect(getModelPricing('claude-sonnet-5', 'boxai')?.cache).toBeUndefined();
    // Sonnet 5.5 显式条目（与 Sonnet 5 同价 $3/$15；倍率同为 x1.33，2026-10-02 实测）
    expect(getModelPricing('claude-sonnet-5.5')).toEqual({
      input: 3,
      output: 15,
    });
    expect(getModelPricing('claude-sonnet-5.5', 'codebuddy')).toEqual({
      input: 3,
      output: 15,
    });
  });

  it('prices Cursor fast variants above their standard tier', () => {
    const standard = getModelPricing('composer-2.5', 'cursor');
    const fast = getModelPricing('composer-2.5-fast', 'cursor');
    if (!standard || !fast) throw new Error('expected Composer pricing');
    expect(fast.input).toBeGreaterThan(standard.input);
    expect(fast.output).toBeGreaterThan(standard.output);
    expect(fast.cache?.read).toBeGreaterThan(standard.cache?.read ?? 0);

    expect(getModelPricing('cursor-grok-4.5-256k-fast', 'cursor')).toEqual({
      input: 2.62,
      output: 14.45,
      cache: { read: 0.588 },
    });
    expect(getModelPricing('cursor-grok-4.5-256k', 'cursor')).toEqual({
      input: 1.53,
      output: 6.88,
      cache: { read: 0.249 },
    });
    expect(getModelPricing('grok-4.7', 'cursor')).toEqual({
      input: 2,
      output: 6,
      cache: { read: 0.5 },
    });
    expect(getModelPricing('grok-4.7-256k-fast', 'cursor')).toEqual({
      input: 4,
      output: 12,
      cache: { read: 1 },
    });
    expect(getModelPricing('cursor-grok-4.7-500k', 'cursor')).toEqual({
      input: 2,
      output: 6,
      cache: { read: 0.5 },
    });
    expect(resolveModelPricingKey('grok-4.7-500k-fast')).toBe('grok-4.7-fast');
    expect(getModelPricing('gemini-3.8-flash', 'cursor')).toEqual({
      input: 0.75,
      output: 3.5,
      cache: { read: 0.075 },
    });
    expect(getModelPricing('gemini-3.8-flash-1m', 'cursor')).toEqual({
      input: 0.75,
      output: 3.5,
      cache: { read: 0.075 },
    });
    expect(getModelPricing('gemini-4-argon', 'cursor')).toEqual({
      input: 2,
      output: 10,
      cache: { read: 0.1 },
    });
    expect(getModelPricing('gemini-4-argon-1m', 'cursor')).toEqual({
      input: 2,
      output: 10,
      cache: { read: 0.1 },
    });
  });

  it('falls Cursor back to the shared default when it has no override', () => {
    expect(getModelPricing('kimi-k3', 'cursor')).toEqual(getModelPricing('kimi-k3'));
  });

  it('returns a copy so callers cannot mutate shared pricing', () => {
    const pricing = getModelPricing('gpt-5.5');
    if (!pricing) throw new Error('expected GPT-5.5 pricing');

    pricing.input = 999;
    expect(getModelPricing('gpt-5.5')?.input).toBe(5);
  });
});
