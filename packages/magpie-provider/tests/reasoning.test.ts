import { describe, expect, it } from 'bun:test';
import { buildInventory } from '../src/catalog.js';

// Shape returned by the installed Magpie gateway, which predates reasoning_levels.
const cursor = {
  id: 'cursor/gpt-5.5@272k',
  owned_by: 'cursor',
  reasoning: true,
  supported_reasoning_levels: ['none', 'low', 'medium', 'high', 'xhigh'].map((effort) => ({
    effort,
  })),
  native_endpoints: ['/v1/chat/completions'],
  magpie_price: { input: 5, output: 30 },
};

describe('Magpie reasoning controls', () => {
  it('discovers effort choices from the installed gateway response', () => {
    const model = buildInventory([cursor], 'http://localhost:3425')[0].models[0];
    expect(model.variants).toEqual(
      ['none', 'low', 'medium', 'high', 'xhigh'].map((id) => ({
        id,
        settings: { reasoningEffort: id },
      })),
    );
    expect(model.modelID).toBe('cursor/gpt-5.5@272k');
  });

  it('keeps context-window SKUs selectable using their base model pricing', () => {
    const model = buildInventory(
      [{ ...cursor, magpie_price: undefined }],
      'http://localhost:3425',
    )[0].models[0];
    expect(model.enabled).toBe(true);
    expect(model.cost.length).toBeGreaterThan(0);
    expect(model.modelID).toBe('cursor/gpt-5.5@272k');
    expect(model.variants.map((variant) => variant.id)).toContain('high');
  });

  it('uses OpenAI semantic options for Responses too', () => {
    const row = { ...cursor, native_endpoints: ['/v1/responses'] };
    const model = buildInventory([row], 'http://localhost:3425')[0].models[0];
    expect(model.variants.find((variant) => variant.id === 'high')?.settings).toEqual({
      reasoningEffort: 'high',
    });
  });

  it('enables Anthropic thinking and uses its effort option instead of reasoningEffort', () => {
    const row = {
      ...cursor,
      id: 'claude/claude-opus-4-6',
      owned_by: 'claude',
      native_endpoints: ['/v1/messages'],
    };
    const model = buildInventory([row], 'http://localhost:3425')[0].models[0];
    expect(model.variants.find((variant) => variant.id === 'high')?.settings).toEqual({
      thinking: { type: 'adaptive' },
      effort: 'high',
    });
    expect(model.variants.find((variant) => variant.id === 'none')?.settings).toEqual({
      thinking: { type: 'disabled' },
    });
  });

  it('honors the newer flat list, removes duplicates and leaves default to the provider', () => {
    const row = { ...cursor, reasoning_levels: ['default', 'high', 'high', 'max'] };
    const model = buildInventory([row], 'http://localhost:3425')[0].models[0];
    expect(model.variants.map((variant) => variant.id)).toEqual(['high', 'max']);
  });

  it('does not invent effort choices for reasoning-only or explicitly disabled models', () => {
    [
      { ...cursor, reasoning_levels: [] },
      { ...cursor, supported_reasoning_levels: [], reasoning: true },
      { ...cursor, reasoning: false, reasoning_levels: ['high'] },
    ].forEach((row) => {
      expect(buildInventory([row], 'http://localhost:3425')[0].models[0].variants).toEqual([]);
    });
  });

  it('accepts string-form supported levels and retains routing-group choices', () => {
    const row = { ...cursor, id: 'group/fast', supported_reasoning_levels: ['low', 'high'] };
    const entry = buildInventory([row], 'http://localhost:3425')[0];
    expect(entry.info.name).toBe('Magpie Group');
    expect(entry.models[0].modelID).toBe('group/fast');
    expect(entry.models[0].variants.map((variant) => variant.id)).toEqual(['low', 'high']);
  });
});
