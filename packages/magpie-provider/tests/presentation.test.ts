import { describe, expect, it } from 'bun:test';
import {
  buildInventory,
  displayName,
  type MagpieModel,
  parsePresentation,
} from '../src/catalog.js';
import plugin from '../src/index.js';
import type { PluginContext } from '../src/opencode.js';

const baseURL = 'http://127.0.0.1:3425';

const group = (id: string, extra: Partial<MagpieModel> = {}): MagpieModel => ({
  id,
  owned_by: 'cursor',
  display_name: id.slice(id.indexOf('/') + 1),
  ...extra,
});

const vendor = (owner: string, model: string, extra: Partial<MagpieModel> = {}): MagpieModel => ({
  id: `${owner}/${model}`,
  owned_by: owner,
  display_name: model,
  magpie_label: `${model} · ${owner === 'cursor' ? 'Cursor' : 'WorkBuddy'}`,
  ...extra,
});

/** The README example. It is a caller's presentation, not a plugin default. */
const example = {
  groups: [
    { prefix: 'adams-', id: 'adams', name: 'Adams' },
    { prefix: 'combo-', id: 'combo', name: 'Combo' },
  ],
  order: {
    'magpie-adams': ['deepseek-v4.1-flash', 'qwen3.8-flash-next'],
    'magpie-combo': ['grok-deepseek', 'sonnet', 'opus'],
    'magpie-cursor': ['grok-4.7@500k', 'claude-haiku-5-5@1m', 'gemini-4-argon'],
    'magpie-workbuddy': ['deepseek-v4.1-flash', 'gpt-6-astra'],
  },
};

const entry = (rows: MagpieModel[], options: unknown, fastModelIDs?: ReadonlySet<string>) =>
  buildInventory(rows, baseURL, {
    presentation: parsePresentation(options),
    fastModelIDs,
  });

const shown = (rows: MagpieModel[], fastModelIDs?: ReadonlySet<string>) =>
  entry(rows, example, fastModelIDs);

const byProvider = (inventory: ReturnType<typeof entry>, id: string) => {
  const found = inventory.find((item) => item.info.id === id);
  if (!found) throw new Error(`missing provider ${id}`);
  return found;
};

describe('display names', () => {
  it('removes the space Magpie puts before a context window', () => {
    expect(displayName('Claude Opus 5.5 @ 1m')).toBe('Claude Opus 5.5 @1m');
    expect(displayName('Grok 4.7 @ 500k')).toBe('Grok 4.7 @500k');
    expect(displayName('Gemini 4 Argon')).toBe('Gemini 4 Argon');
  });

  it('shows the tightened name on vendor models', () => {
    const inventory = buildInventory(
      [vendor('cursor', 'claude-opus-5-5@1m', { display_name: 'Claude Opus 5.5 @ 1m' })],
      baseURL,
    );
    expect(byProvider(inventory, 'magpie-cursor').models[0].name).toBe('Claude Opus 5.5 @1m');
  });
});

describe('catalog presentation', () => {
  it('leaves every manual routing group on Magpie Group when options are empty', () => {
    const rows = [group('group/adams-x'), group('group/combo-y')];
    for (const inventory of [
      buildInventory(rows, baseURL),
      entry(rows, undefined),
      entry(rows, {}),
    ]) {
      expect(inventory).toHaveLength(1);
      expect(inventory[0].info).toMatchObject({ id: 'magpie-group', name: 'Magpie Group' });
      expect(inventory[0].models.map((model) => model.id)).toEqual(['adams-x', 'combo-y']);
      expect(inventory[0].models.map((model) => model.modelID)).toEqual([
        'group/adams-x',
        'group/combo-y',
      ]);
    }
  });

  it('buckets the example groups and drops their prefix', () => {
    const inventory = shown([
      group('group/adams-deepseek-v4.1-flash', { display_name: 'DeepSeek V4.1 Flash' }),
      group('group/combo-grok-deepseek', { display_name: undefined }),
      group('group/auto'),
    ]);
    const adams = byProvider(inventory, 'magpie-adams');
    const combo = byProvider(inventory, 'magpie-combo');
    const magpie = byProvider(inventory, 'magpie-group');
    expect(adams.info.name).toBe('Adams');
    expect(combo.info.name).toBe('Combo');
    expect(adams.models[0]).toMatchObject({
      id: 'deepseek-v4.1-flash',
      modelID: 'group/adams-deepseek-v4.1-flash',
      name: 'DeepSeek V4.1 Flash',
    });
    expect(combo.models[0]).toMatchObject({
      id: 'grok-deepseek',
      modelID: 'group/combo-grok-deepseek',
      name: 'grok-deepseek',
    });
    expect(magpie.info.name).toBe('Magpie Group');
    expect(magpie.models[0].id).toBe('auto');
  });

  it('lets a longer prefix win over a shorter one declared first', () => {
    const inventory = entry([group('group/adams-fast-route')], {
      groups: [
        { prefix: 'adams-', id: 'adams', name: 'Adams' },
        { prefix: 'adams-fast-', id: 'adams-fast', name: 'Adams Fast' },
      ],
    });
    expect(inventory).toHaveLength(1);
    expect(inventory[0].info).toMatchObject({ id: 'magpie-adams-fast', name: 'Adams Fast' });
    expect(inventory[0].models[0]).toMatchObject({
      id: 'route',
      modelID: 'group/adams-fast-route',
    });
  });

  it('keeps every model enabled, including unpriced ones', () => {
    const inventory = shown([
      group('group/adams-x'),
      group('group/combo-grok-deepseek'),
      vendor('cursor', 'unknown-model'),
    ]);
    const models = inventory.flatMap((item) => item.models);
    expect(models.every((model) => model.enabled)).toBe(true);
    const unpriced = byProvider(inventory, 'magpie-cursor').models[0];
    expect(unpriced.cost).toEqual([]);
    expect(unpriced.name).toBe('unknown-model');
  });

  it('writes a descending release time and lets a fast clone inherit it', () => {
    const inventory = shown([
      vendor('cursor', 'gemini-4-argon', { service_tiers: ['priority'] }),
      vendor('cursor', 'grok-4.7@500k', { service_tiers: ['priority'] }),
      vendor('cursor', 'other-model', { service_tiers: ['priority'] }),
    ]);
    const models = byProvider(inventory, 'magpie-cursor').models;
    expect(models.map((model) => [model.id, model.time.released])).toEqual([
      ['gemini-4-argon', 980],
      ['gemini-4-argon-fast', 980],
      ['grok-4.7@500k', 1000],
      ['grok-4.7@500k-fast', 1000],
      ['other-model', 0],
      ['other-model-fast', 0],
    ]);
  });

  it('does not rebucket vendor models and keeps their order on the vendor provider', () => {
    const inventory = shown([
      vendor('cursor', 'adams-lookalike'),
      vendor('workbuddy', 'deepseek-v4.1-flash'),
      vendor('workbuddy', 'gpt-6-astra'),
      group('group/adams-deepseek-v4.1-flash'),
    ]);
    expect(byProvider(inventory, 'magpie-cursor').models.map((model) => model.id)).toEqual([
      'adams-lookalike',
    ]);
    expect(
      byProvider(inventory, 'magpie-workbuddy').models.map((model) => [
        model.id,
        model.time.released,
      ]),
    ).toEqual([
      ['deepseek-v4.1-flash', 1000],
      ['gpt-6-astra', 990],
    ]);
    expect(byProvider(inventory, 'magpie-adams').models[0].id).toBe('deepseek-v4.1-flash');
  });

  it('does not match a prefix that would leave an empty model id', () => {
    const inventory = shown([group('group/adams-')]);
    expect(inventory[0].info.id).toBe('magpie-group');
    expect(inventory[0].models[0].id).toBe('adams-');
  });

  it('fails plugin setup on invalid options before reaching the gateway', async () => {
    const ctx = {
      options: { groups: 'adams' },
      provider: { transform: async () => ({ dispose: async () => {} }), reload: async () => {} },
      session: { hook: async () => ({ dispose: async () => {} }) },
    } as unknown as PluginContext;
    await expect(plugin.setup(ctx)).rejects.toThrow('options.groups');
  });

  it('rejects options that are not the documented shape and names the path', () => {
    expect(() => parsePresentation([])).toThrow('options');
    expect(() => parsePresentation({ groups: [{ prefix: 'a-', id: 'a' }] })).toThrow(
      'options.groups[0].name',
    );
    expect(() => parsePresentation({ order: { 'magpie-cursor': [1] } })).toThrow(
      'options.order.magpie-cursor[0]',
    );
    // Hiding belongs to Magpie; an old config that still says hidden fails loudly.
    expect(() => parsePresentation({ hidden: ['group/x'] })).toThrow('options.hidden');
    expect(() => parsePresentation({ order: { 'magpie-cursor': 'gpt' } })).toThrow(
      'options.order.magpie-cursor',
    );
    expect(() => parsePresentation({ extra: true })).toThrow('options.extra');
  });
});
