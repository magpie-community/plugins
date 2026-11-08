import { describe, expect, test } from 'bun:test';
import { normalizeModels } from './catalog.mjs';
import { applyReasoningOptions, validateModelOptions } from './model-options.mjs';

// Synthetic data only. No provider call, no paid finance/database path.
const capabilities = {
  reasoningEfforts: ['none', 'low', 'medium', 'high'],
  contextWindow: 200000,
};

const expectFixedError = (run, code) => {
  let caught;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect(caught.code).toBe(code);
  expect(caught.message).toBe(code);
};

const makePayload = () => {
  const messages = [{ role: 'user', content: 'synthetic request' }];
  const financeTool = { type: 'function', function: { name: 'synthetic_finance_query' } };
  const databaseTool = { type: 'function', function: { name: 'synthetic_database_query' } };
  const authorization = { scope: 'synthetic-authorization' };
  const billing = { plan: 'synthetic-billing' };
  return {
    payload: {
      model: 'synthetic/model',
      thinking: 'high',
      reasoning: 'high',
      reasoning_effort: 'high',
      max_tokens: 4096,
      messages,
      tools: [financeTool, databaseTool],
      authorization,
      billing,
    },
    messages,
    financeTool,
    databaseTool,
    authorization,
    billing,
  };
};

describe('validateModelOptions', () => {
  test('missing fields normalize to provider default and catalog cap', () => {
    expect(() => validateModelOptions({}, capabilities)).not.toThrow();
    expect(validateModelOptions({}, capabilities)).toEqual({ reasoningEffort: '', contextTokens: null });
  });

  test('accepts explicit null contextTokens as the catalog cap', () => {
    expect(() => validateModelOptions({ reasoningEffort: '', contextTokens: null }, capabilities)).not.toThrow();
    expect(validateModelOptions({ reasoningEffort: '', contextTokens: null }, capabilities))
      .toEqual({ reasoningEffort: '', contextTokens: null });
  });

  test('accepts explicit effort and context at the exact catalog maximum', () => {
    expect(validateModelOptions({ reasoningEffort: 'high', contextTokens: 200000 }, capabilities))
      .toEqual({ reasoningEffort: 'high', contextTokens: 200000 });
  });

  test('rejects effort outside the explicitly declared list', () => {
    expectFixedError(
      () => validateModelOptions({ reasoningEffort: 'xhigh' }, capabilities),
      'unsupported_reasoning_effort',
    );
    expectFixedError(
      () => validateModelOptions({ reasoningEffort: 'high' }, { reasoningEfforts: [], contextWindow: null }),
      'unsupported_reasoning_effort',
    );
  });

  test('rejects context when the catalog cap is unknown', () => {
    expectFixedError(
      () => validateModelOptions({ contextTokens: 1000 }, { reasoningEfforts: [], contextWindow: null }),
      'unsupported_context_length',
    );
  });

  test('rejects context above the known catalog cap', () => {
    expectFixedError(
      () => validateModelOptions({ contextTokens: 200001 }, capabilities),
      'unsupported_context_length',
    );
  });

  test('rejects malformed option shapes with the fixed code', () => {
    expectFixedError(() => validateModelOptions(null, capabilities), 'invalid_model_options');
    expectFixedError(() => validateModelOptions(42, capabilities), 'invalid_model_options');
    expectFixedError(() => validateModelOptions([], capabilities), 'invalid_model_options');
    expectFixedError(() => validateModelOptions({ reasoningEffort: 42 }, capabilities), 'invalid_model_options');
    expectFixedError(() => validateModelOptions({ contextTokens: 0 }, capabilities), 'invalid_model_options');
    expectFixedError(() => validateModelOptions({ contextTokens: -1 }, capabilities), 'invalid_model_options');
    expectFixedError(() => validateModelOptions({ contextTokens: 1.5 }, capabilities), 'invalid_model_options');
    expectFixedError(() => validateModelOptions({ contextTokens: Number.MAX_SAFE_INTEGER + 1 }, capabilities), 'invalid_model_options');
    expectFixedError(() => validateModelOptions({ contextTokens: '1000' }, capabilities), 'invalid_model_options');
  });

  test('returns only the two normalized keys even with extra input keys', () => {
    expect(validateModelOptions({ reasoningEffort: 'low', contextTokens: 1000, defaultEffort: 'high' }, capabilities))
      .toEqual({ reasoningEffort: 'low', contextTokens: 1000 });
  });
});

describe('catalog options integration', () => {
  test('reasoning=false exposes no efforts and validation rejects any explicit effort', () => {
    const model = normalizeModels({
      data: [{
        id: 'synthetic/no-reasoning',
        reasoning: false,
        context_window: 64000,
        supported_reasoning_levels: [{ effort: 'high' }],
      }],
    })[0];
    expect(model.options).toEqual({ reasoningEfforts: [], contextWindow: 64000 });
    expectFixedError(
      () => validateModelOptions({ reasoningEffort: 'high' }, model.options),
      'unsupported_reasoning_effort',
    );
  });

  test('same model primary and secondary settings stay independent', () => {
    const model = normalizeModels({
      data: [{
        id: 'synthetic/shared-model',
        context_window: 200000,
        supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }],
      }],
    })[0];
    const primary = validateModelOptions({ reasoningEffort: 'low', contextTokens: 64000 }, model.options);
    const secondary = validateModelOptions({ reasoningEffort: 'high', contextTokens: 128000 }, model.options);

    expect(primary).toEqual({ reasoningEffort: 'low', contextTokens: 64000 });
    expect(secondary).toEqual({ reasoningEffort: 'high', contextTokens: 128000 });
    expect(primary).not.toBe(secondary);

    const { payload, messages } = makePayload();
    const primaryPayload = applyReasoningOptions(payload, primary);
    const secondaryPayload = applyReasoningOptions(payload, secondary);
    expect(primaryPayload.reasoning_effort).toBe('low');
    expect(secondaryPayload.reasoning_effort).toBe('high');
    expect(primaryPayload.messages).toBe(messages);
    expect(secondaryPayload.messages).toBe(messages);
  });
});

describe('applyReasoningOptions', () => {
  test('null and undefined options are exact legacy identity, including sentinel references', () => {
    const { payload, messages, financeTool, databaseTool, authorization, billing } = makePayload();

    expect(applyReasoningOptions(payload, null)).toBe(payload);
    expect(applyReasoningOptions(payload, undefined)).toBe(payload);

    expect(payload.reasoning_effort).toBe('high');
    expect(payload.thinking).toBe('high');
    expect(payload.reasoning).toBe('high');
    expect(payload.messages).toBe(messages);
    expect(payload.tools[0]).toBe(financeTool);
    expect(payload.tools[1]).toBe(databaseTool);
    expect(payload.authorization).toBe(authorization);
    expect(payload.billing).toBe(billing);
  });

  test('present config overrides Kimi menu thinking values with the plugin effort', () => {
    const { payload, messages, financeTool, databaseTool, authorization, billing } = makePayload();
    const normalized = validateModelOptions({ reasoningEffort: 'low', contextTokens: 64000 }, capabilities);
    const applied = applyReasoningOptions(payload, normalized);

    expect(applied).not.toBe(payload);
    expect(applied.reasoning_effort).toBe('low');
    expect('thinking' in applied).toBe(false);
    expect('reasoning' in applied).toBe(false);
    expect(applied.messages).toBe(messages);
    expect(applied.tools).toBe(payload.tools);
    expect(applied.tools[0]).toBe(financeTool);
    expect(applied.tools[1]).toBe(databaseTool);
    expect(applied.authorization).toBe(authorization);
    expect(applied.billing).toBe(billing);
    expect(applied.max_tokens).toBe(4096);

    expect(payload.reasoning_effort).toBe('high');
    expect(payload.thinking).toBe('high');
  });

  test('empty effort strips Kimi thinking controls and adds no effort', () => {
    const { payload } = makePayload();
    const applied = applyReasoningOptions(payload, validateModelOptions({}, capabilities));

    expect(applied).not.toBe(payload);
    expect('reasoning_effort' in applied).toBe(false);
    expect('thinking' in applied).toBe(false);
    expect('reasoning' in applied).toBe(false);
    expect(applied.max_tokens).toBe(4096);
  });

  test('does not add max_tokens or context fields when applying explicit context', () => {
    const { payload } = makePayload();
    const normalized = validateModelOptions({ reasoningEffort: 'high', contextTokens: 100000 }, capabilities);
    const applied = applyReasoningOptions(payload, normalized);

    expect(applied.reasoning_effort).toBe('high');
    expect('context' in applied).toBe(false);
    expect('contextWindow' in applied).toBe(false);
    expect('contextTokens' in applied).toBe(false);
    expect(applied.max_tokens).toBe(4096);
  });
});
