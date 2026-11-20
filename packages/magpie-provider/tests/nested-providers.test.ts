import { describe, expect, it } from 'bun:test';
import { buildInventory, type MagpieModel } from '../src/catalog.js';

const rows: MagpieModel[] = [
  ['astra', 'Astra'],
  ['cursor', 'Cursor'],
  ['workbuddy', 'WorkBuddy'],
  ['auto', 'routing group'],
  ['group', 'routing group'],
].map(([source, label]) => ({
  id: `remote-magpie/${source}/gpt-6-astra`,
  owned_by: 'remote-magpie',
  display_name: 'GPT-6-Astra',
  magpie_label: `GPT-6-Astra · ${label} · Remote magpie`,
}));

describe('nested gateway providers', () => {
  it.each([
    false,
    true,
  ])('separates upstream sources regardless of row order (reverse=%s)', (reverse) => {
    const inventory = buildInventory(
      reverse ? [...rows].reverse() : rows,
      'http://localhost:3425/v1',
    );
    expect(inventory).toHaveLength(5);
    for (const row of rows) {
      const source = row.id.split('/')[1];
      const entry = inventory.find((item) => item.info.id === `magpie-remote-magpie%2F${source}`);
      const names: Record<string, string> = {
        astra: 'Astra · Remote Magpie',
        cursor: 'Cursor · Remote Magpie',
        workbuddy: 'WorkBuddy · Remote Magpie',
        auto: 'Auto · Remote Magpie',
        group: 'Group · Remote Magpie',
      };
      expect(entry?.info.name).toBe(names[source]);
      expect(entry?.models[0]).toMatchObject({
        id: `${source}/gpt-6-astra`,
        name: 'GPT-6-Astra',
        modelID: row.id,
      });
    }
  });

  it.each(['group', 'auto'])('names remote %s independently of gateway labels', (source) => {
    const labels = [
      undefined,
      'GPT-6-Astra',
      'GPT-6-Astra · Remote magpie',
      'GPT-6-Astra · routing group · Remote magpie',
      'GPT-6-Astra · Magpie · Remote Magpie',
    ];
    const models: MagpieModel[] = labels.map((magpie_label, index) => ({
      id: `remote-magpie/${source}/model-${index}`,
      owned_by: 'remote-magpie',
      magpie_label,
      service_tiers: ['priority'],
    }));
    for (const rows of [models, [...models].reverse()]) {
      const [entry] = buildInventory(rows, 'http://localhost:3425/v1');
      expect(entry.info).toMatchObject({
        id: `magpie-remote-magpie%2F${source}`,
        name: `${source === 'group' ? 'Group' : 'Auto'} · Remote Magpie`,
      });
      expect(entry.info.name.match(/magpie/gi)).toHaveLength(1);
      expect(entry.models).toHaveLength(models.length * 2);
      for (const row of rows) {
        const wireModels = entry.models.filter((model) => model.modelID === row.id);
        expect(wireModels).toHaveLength(2);
        expect(wireModels.map((model) => model.id)).toEqual([
          row.id.slice('remote-magpie/'.length),
          `${row.id.slice('remote-magpie/'.length)}-fast`,
        ]);
      }
    }
  });

  it('retains context SKU and Fast wire IDs with older gateway labels', () => {
    const row: MagpieModel = {
      id: 'remote-magpie/cursor/gpt-5.6-terra@272k',
      owned_by: 'remote-magpie',
      magpie_label: 'cursor/gpt-5.6-terra@272k · Remote magpie',
      service_tiers: ['priority'],
    };
    const [entry] = buildInventory([row], 'http://localhost:3425/v1');
    expect(entry.info.name).toBe('Cursor · Remote Magpie');
    expect(entry.models.map((model) => model.modelID)).toEqual([row.id, row.id]);
    expect(entry.models[0].id).toBe('cursor/gpt-5.6-terra@272k');
  });
});
