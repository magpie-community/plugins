import { describe, expect, it } from 'bun:test';
import { buildInventory, type MagpieModel, parsePresentation } from '../src/catalog.js';

const baseURL = 'http://127.0.0.1:3425';
const vendor: MagpieModel = { id: 'cursor/composer-2.5', owned_by: 'cursor' };
const auto: MagpieModel = { ...vendor, id: 'auto/composer-2.5' };

describe('Auto Group model IDs', () => {
  it.each([true, false])('keeps vendor models with auto-first=%s', (autoFirst) => {
    const inventory = buildInventory(autoFirst ? [auto, vendor] : [vendor, auto], baseURL);
    expect(inventory.find((entry) => entry.info.id === 'magpie-cursor')?.models[0]).toMatchObject({
      id: 'composer-2.5',
      modelID: vendor.id,
    });
    expect(inventory.find((entry) => entry.info.id === 'magpie-auto')?.models[0]).toMatchObject({
      id: 'auto-composer-2.5',
      modelID: auto.id,
      cost: [],
    });
  });

  it.each([true, false])('separates local Group and Auto with auto-first=%s', (autoFirst) => {
    const group: MagpieModel = { ...auto, id: 'group/composer-2.5' };
    const rows = autoFirst ? [auto, group, vendor] : [group, auto, vendor];
    const inventory = buildInventory(rows, baseURL);
    expect(inventory).toHaveLength(3);
    for (const [id, name, modelID, wireID] of [
      ['magpie-group', 'Magpie Group', 'composer-2.5', group.id],
      ['magpie-auto', 'Magpie Auto', 'auto-composer-2.5', auto.id],
    ]) {
      const entry = inventory.find((entry) => entry.info.id === id);
      expect(entry?.info.name).toBe(name);
      expect(entry?.info.name.match(/magpie/gi)).toHaveLength(1);
      expect(entry?.models).toHaveLength(1);
      expect(entry?.models[0]).toMatchObject({ id: modelID, modelID: wireID, providerID: id });
    }
    expect(inventory.find((entry) => entry.info.id === 'magpie-cursor')?.info.name).toBe('Cursor');
  });

  it.each([
    undefined,
    { input: 7, output: 21 },
  ])('keeps group pricing and wire IDs for bucketed Fast models (%j)', (magpie_price) => {
    const [entry] = buildInventory(
      [{ ...auto, magpie_price, service_tiers: ['priority'] }],
      baseURL,
      {
        presentation: parsePresentation({
          groups: [{ prefix: 'auto-', id: 'auto', name: 'Auto' }],
          order: { 'magpie-auto': ['composer-2.5'] },
        }),
      },
    );
    expect(entry.info).toMatchObject({ id: 'magpie-auto', name: 'Auto' });
    expect(entry.models).toHaveLength(2);
    expect(entry.models[1]).toMatchObject({
      id: 'composer-2.5-fast',
      modelID: auto.id,
      time: { released: 1000 },
      body: { service_tier: 'priority' },
      cost: entry.models[0].cost,
    });
    if (magpie_price) expect(entry.models[0].cost[0]).toMatchObject(magpie_price);
    else expect(entry.models[0].cost).toEqual([]);
  });

  it('does not use models.dev to guess a routing group price', () => {
    const [entry] = buildInventory([{ id: 'auto/catalog-only', owned_by: 'cursor' }], baseURL, {
      catalog: {
        cursor: {
          models: { 'catalog-only': { id: 'catalog-only', cost: { input: 3, output: 9 } } },
        },
      },
    });
    expect(entry.models[0].cost).toEqual([]);
  });
});
