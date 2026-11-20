import { describe, expect, it } from 'bun:test';
import { buildInventory } from '../src/catalog.js';
import { catalogPrice } from '../src/catalog-cache.js';
import { getModelPricing } from '../src/model-pricing.js';
import { normalizeModelCosts } from '../src/opencode.js';

describe('context price tiers', () => {
  it.each([
    ['gpt-6-sol', 2, 10, 0.2, 2.5],
    ['gpt-6-luna', 0.1, 0.5, 0.01, 0.125],
    ['gpt-6.1-sol', 2, 10, 0.1, 2.5],
  ] as const)('registers %s Standard and derived Fast at official short/long rates', (id, input, output, read, write) => {
    const models = buildInventory(
      [{ id: `openai/${id}`, owned_by: 'openai', service_tiers: ['priority'] }],
      'http://localhost:3425',
    )[0].models;
    for (const [index, multiplier] of [
      [0, 1],
      [1, 2],
    ] as const) {
      const expected = [
        {
          input: input * multiplier,
          output: output * multiplier,
          cache: { read: read * multiplier, write: write * multiplier },
        },
        {
          input: input * 2 * multiplier,
          output: output * 1.5 * multiplier,
          cache: { read: read * 2 * multiplier, write: write * 2 * multiplier },
          tier: { type: 'context', size: 272000 },
        },
      ];
      expect(models[index].cost).toEqual(expected);
      expect(normalizeModelCosts(getModelPricing(`${id}${index ? '-fast' : ''}`))).toEqual(
        expected,
      );
      expect(
        normalizeModelCosts(
          getModelPricing(`${id.replace('6.1', '6-1')}${index ? '-fast' : ''}`, 'codebuddy'),
        ),
      ).toEqual(expected);
    }
  });

  it('registers Astra standard and Fast whole-request tiers with OpenCode', () => {
    for (const [id, multiplier] of [
      ['gpt-6-astra', 1],
      ['gpt-6-astra-fast', 2],
    ] as const) {
      const inventory = buildInventory(
        [{ id: `openai/${id}`, owned_by: 'openai' }],
        'http://localhost:3425',
      );
      expect(inventory[0].models[0].cost).toEqual([
        {
          input: 10 * multiplier,
          output: 50 * multiplier,
          cache: { read: multiplier, write: 12.5 * multiplier },
        },
        {
          input: 20 * multiplier,
          output: 75 * multiplier,
          cache: { read: 2 * multiplier, write: 25 * multiplier },
          tier: { type: 'context', size: 272000 },
        },
      ]);
    }
  });

  it('retains models.dev tiers through both catalog conversions', () => {
    const price = catalogPrice({
      input: 10,
      output: 50,
      cache_read: 1,
      cache_write: 12.5,
      tiers: [
        {
          input: 20,
          output: 75,
          cache_read: 2,
          cache_write: 25,
          tier: { type: 'context', size: 272000 },
        },
      ],
    });
    expect(normalizeModelCosts(price)).toHaveLength(2);
    expect(normalizeModelCosts(price)[1]).toEqual({
      input: 20,
      output: 75,
      cache: { read: 2, write: 25 },
      tier: { type: 'context', size: 272000 },
    });
  });

  it('uses the explicit Astra Fast tariff for an automatically derived priority model', () => {
    const inventory = buildInventory(
      [{ id: 'openai/gpt-6-astra', owned_by: 'openai', service_tiers: ['priority'] }],
      'http://localhost:3425',
    );
    const fast = inventory[0].models.find((model) => model.id === 'gpt-6-astra-fast');
    expect(fast?.body).toEqual({ service_tier: 'priority' });
    expect(fast?.cost).toEqual(normalizeModelCosts(getModelPricing('gpt-6-astra-fast')));
  });

  it('isolates returned tier objects from the built-in price table', () => {
    const tier = getModelPricing('gpt-6-astra')?.tiers?.[0];
    if (!tier?.cache) throw new Error('Astra context tier is missing');
    tier.tier.size = 1;
    tier.cache.read = 999;
    expect(getModelPricing('gpt-6-astra')?.tiers?.[0]).toEqual({
      input: 20,
      output: 75,
      cache: { read: 2, write: 25 },
      tier: { type: 'context', size: 272000 },
    });
  });

  it('preserves Magpie above tiers, inherits missing rates and rejects invalid tiers', () => {
    const costs = normalizeModelCosts({
      input: 10,
      output: 50,
      cache_read: 1,
      cache_write: 12.5,
      tiers: [
        { above: 272000, input: 20, cache_read: 0 },
        { tier: { type: 'time', size: 100 }, input: 99 },
        { above: -1, input: 99 },
        { above: 300000, output: -1 },
      ],
    });
    expect(costs).toEqual([
      { input: 10, output: 50, cache: { read: 1, write: 12.5 } },
      {
        input: 20,
        output: 50,
        cache: { read: 0, write: 12.5 },
        tier: { type: 'context', size: 272000 },
      },
    ]);
    expect(normalizeModelCosts(undefined)).toEqual([]);
  });
});
