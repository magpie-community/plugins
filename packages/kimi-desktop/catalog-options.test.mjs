import { describe, expect, test } from 'bun:test';
import { normalizeModels } from './catalog.mjs';

// Synthetic catalog rows only. No network, no real user config, no paid tools.
const row = overrides => ({
  id: 'moonshot/kimi-k2.5-options-synthetic',
  display_name: 'Kimi K2.5 Synthetic',
  ...overrides,
});

const modelFor = overrides => normalizeModels({ data: [row(overrides)] })[0];

describe('catalog independent options capability metadata', () => {
  test('exposes explicit known efforts and explicit context_window', () => {
    const model = modelFor({
      context_window: 262144,
      supported_reasoning_levels: [
        { effort: 'low' },
        { effort: 'high' },
        { effort: 'low' },
        { effort: 'experimental-unknown' },
        {},
      ],
    });
    expect(model.options).toEqual({ reasoningEfforts: ['low', 'high'], contextWindow: 262144 });
  });

  test('uses explicit valid context_length only when context_window is absent', () => {
    const model = modelFor({
      context_length: 200000,
      supported_reasoning_levels: [{ effort: 'medium' }],
    });
    expect(model.options).toEqual({ reasoningEfforts: ['medium'], contextWindow: 200000 });
  });

  test('keeps unknown context and unknown efforts conservative, never 131072', () => {
    const model = modelFor({
      supported_reasoning_levels: [{ effort: 'mystery' }, {}, { effort: '' }],
    });
    expect(model.options).toEqual({ reasoningEfforts: [], contextWindow: null });
  });

  test('reasoning=false offers no thinking effort even when levels are advertised', () => {
    const model = modelFor({
      reasoning: false,
      context_window: 131072,
      supported_reasoning_levels: [{ effort: 'high' }, { effort: 'low' }],
    });
    expect(model.options).toEqual({ reasoningEfforts: [], contextWindow: 131072 });
  });

  test('valid context_window wins over a valid context_length', () => {
    const model = modelFor({ context_window: 32000, context_length: 64000 });
    expect(model.options).toEqual({ reasoningEfforts: [], contextWindow: 32000 });
  });

  test('unknown options context leaves the existing runtime fallback untouched', () => {
    const model = modelFor({});
    expect(model.options).toEqual({ reasoningEfforts: [], contextWindow: null });
    expect(model.runtime.maxContextSize).toBe(131072);
  });

  test('non-positive or non-safe-integer declared contexts are unknown for both context fields', () => {
    for (const field of ['context_window', 'context_length']) {
      for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        const model = modelFor({ [field]: value });
        expect(model.options.contextWindow).toBe(null);
      }
    }
  });

  test('invalid context_window falls through to a valid context_length', () => {
    const model = modelFor({
      context_window: -1,
      context_length: 64000,
    });
    expect(model.options).toEqual({ reasoningEfforts: [], contextWindow: 64000 });
  });

  test('options has exactly the two independent capability keys, no invented default effort', () => {
    const model = modelFor({
      context_window: 100000,
      supported_reasoning_levels: [{ effort: 'high' }, { effort: 'medium' }],
    });
    expect(model.options).toEqual({ reasoningEfforts: ['high', 'medium'], contextWindow: 100000 });
  });
});
