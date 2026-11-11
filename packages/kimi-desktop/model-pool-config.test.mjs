import { describe, expect, test } from 'bun:test';
import { inspectModelPool, patchModelPool } from './model-pool-config.mjs';

// Synthetic credentials exist only to verify that snapshots and errors omit
// every unrelated configuration field.
const CANARY = 'synthetic-pool-auth-canary';
const NONE = { models: null, defaultModel: null, hasSecondaryTable: false, hasModelsTable: false };
const parse = text => Bun.TOML.parse(text);
const saved = text => JSON.parse(JSON.stringify(inspectModelPool(text)));
const globalConfig = [
  'default_model = "primary-alias"',
  'tags = ["keep", "all"]',
  '',
  '[auth]',
  `token = "${CANARY}"`,
  '',
  '[providers.acme]',
  'type = "openai"',
  'base_url = "https://synthetic.invalid/v1"',
  `api_key = "${CANARY}"`,
  '',
  '[models.primary-alias]',
  'model = "wire-primary"',
  'provider = "acme"',
  '',
  '[models.secondary-alias]',
  'model = "wire-secondary"',
  'provider = "acme"',
  '',
].join('\n');

function unrelated(text) {
  const document = parse(text);
  if (document.secondary_model) {
    delete document.secondary_model.models;
    delete document.secondary_model.default_model;
    if (Object.keys(document.secondary_model).length === 0) delete document.secondary_model;
  }
  return document;
}

function expectUnsupported(operation) {
  let error;
  try { operation(); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(Error);
  expect(error.message).toBe('secondary_config_unsupported');
  expect(error.cause).toBeUndefined();
  expect(JSON.stringify({ message: error.message, stack: error.stack, cause: error.cause })).not.toContain(CANARY);
}

describe('inspectModelPool', () => {
  test('distinguishes missing nested models, an empty pool and the unrelated global models table', () => {
    expect(inspectModelPool('')).toEqual(NONE);
    expect(inspectModelPool(globalConfig)).toEqual(NONE);
    expect(inspectModelPool('[secondary_model]\n')).toEqual({
      models: null, defaultModel: null, hasSecondaryTable: true, hasModelsTable: false,
    });
    expect(inspectModelPool('[secondary_model.models]\n')).toEqual({
      models: {}, defaultModel: null, hasSecondaryTable: true, hasModelsTable: true,
    });
    expect(inspectModelPool('[secondary_model]\ndefault_model = "external-default"\n')).toEqual({
      models: null, defaultModel: 'external-default', hasSecondaryTable: true, hasModelsTable: false,
    });
  });

  test('returns only four fields and string descriptions, including aliases outside the catalog', () => {
    const text = globalConfig + [
      '[secondary_model]',
      'model = "legacy-alias"',
      'default_model = "external/default"',
      'extra = { retries = 3 }',
      '',
      '[secondary_model.models]',
      'secondary-alias = "Secondary description"',
      '"external/default" = "An unknown alias still belongs to Kimi"',
      '',
    ].join('\n');
    const snapshot = saved(text);
    expect(snapshot).toEqual({ models: { 'secondary-alias': 'Secondary description',
      'external/default': 'An unknown alias still belongs to Kimi' }, defaultModel: 'external/default',
    hasSecondaryTable: true, hasModelsTable: true });
    expect(Object.keys(snapshot).sort()).toEqual(['defaultModel', 'hasModelsTable', 'hasSecondaryTable', 'models']);
    expect(JSON.stringify(snapshot)).not.toContain(CANARY);
    expect(JSON.stringify(snapshot)).not.toContain('wire-secondary');
    expect(JSON.stringify(snapshot)).not.toContain('legacy-alias');
    expect(JSON.stringify(snapshot)).not.toContain('base_url');
  });
});

describe('patchModelPool', () => {
  test('adds the pool and default without copying global definitions, then restores table absence', () => {
    const target = { models: { 'secondary-alias': 'Secondary description' }, defaultModel: 'secondary-alias',
      hasSecondaryTable: false, hasModelsTable: false };
    const patched = patchModelPool(globalConfig, target);
    expect(inspectModelPool(patched)).toEqual({ ...target, hasSecondaryTable: true, hasModelsTable: true });
    expect(parse(patched).secondary_model).toEqual({ default_model: 'secondary-alias', models: target.models });
    expect(unrelated(patched)).toEqual(parse(globalConfig));
    expect(patchModelPool(patched, target)).toBe(patched);

    const restored = patchModelPool(patched, saved(globalConfig));
    expect(inspectModelPool(restored)).toEqual(NONE);
    expect(parse(restored)).toEqual(parse(globalConfig));
    expect(restored).not.toContain('[secondary_model');
  });

  test('round-trips an existing pool and default while preserving legacy and every extra field', () => {
    const original = globalConfig + [
      '[secondary_model]',
      'model = "legacy-model-kept"',
      'default_model = "outside-catalog"',
      'default_effort = "high"',
      'extra = { count = 4, enabled = false }',
      '',
      '[secondary_model.models]',
      'outside-catalog = "Existing description"',
      '"unknown.alias" = "Also keep this when restoring"',
      '',
      '[experimental]',
      'secondary-model = false',
      'other = [1, 2, 3]',
      '',
    ].join('\n');
    const baseline = saved(original);
    const changed = patchModelPool(original, { models: { 'secondary-alias': 'New description' },
      defaultModel: 'secondary-alias', hasSecondaryTable: true, hasModelsTable: true });
    expect(inspectModelPool(changed).models).toEqual({ 'secondary-alias': 'New description' });
    expect(unrelated(changed)).toEqual(unrelated(original));
    expect(parse(changed).secondary_model.model).toBe('legacy-model-kept');

    const restored = patchModelPool(changed, baseline);
    expect(parse(restored)).toEqual(parse(original));
    expect(inspectModelPool(restored)).toEqual(baseline);
  });

  test('restores an existing empty parent and distinguishes an empty pool from an absent one', () => {
    const emptyParent = '[secondary_model]\n';
    const baseline = saved(emptyParent);
    const emptyPool = { models: {}, defaultModel: null, hasSecondaryTable: true, hasModelsTable: true };
    const created = patchModelPool('', emptyPool);
    expect(inspectModelPool(created)).toEqual(emptyPool);
    expect(parse(created).secondary_model.models).toEqual({});
    expect(patchModelPool(created, emptyPool)).toBe(created);

    const restoredParent = patchModelPool(created, baseline);
    expect(inspectModelPool(restoredParent)).toEqual(baseline);
    expect(parse(restoredParent).secondary_model).toEqual({});
    expect(inspectModelPool(patchModelPool(created, NONE))).toEqual(NONE);
    expect(inspectModelPool(patchModelPool('', baseline))).toEqual(baseline);
  });

  test('clears only the two owned fields and retains legacy values and sibling tables', () => {
    const text = [
      '[secondary_model]',
      'model = "legacy-value"',
      'default_model = "pool-default"',
      'other = { nested = "keep" }',
      '',
      '[secondary_model.models]',
      'pool-default = "Description"',
      '',
    ].join('\n');
    const cleared = patchModelPool(text, NONE);
    expect(parse(cleared).secondary_model).toEqual({ model: 'legacy-value', other: { nested: 'keep' } });
    expect(inspectModelPool(cleared)).toEqual({ ...NONE, hasSecondaryTable: true });
    expect(patchModelPool(cleared, NONE)).toBe(cleared);
  });

  test('returns unchanged comments, line endings and map order byte for byte', () => {
    const text = [
      '# preserve this formatting',
      '[ secondary_model ]  # inline comment',
      'default_model   =   "second"',
      '',
      '[ secondary_model.models ]',
      'first = "First"  # trailing comment',
      'second   =   "Second"',
      '',
    ].join('\r\n');
    const snapshot = saved(text);
    expect(patchModelPool(text, snapshot)).toBe(text);
    expect(patchModelPool(text, { ...snapshot, models: { second: 'Second', first: 'First' } })).toBe(text);
    const legacyOnly = '# still unchanged\n[secondary_model]\nmodel = "legacy"  # leave me\n';
    expect(patchModelPool(legacyOnly, NONE)).toBe(legacyOnly);
  });

  test('never mutates the caller snapshot or its pool, including frozen input', () => {
    const models = Object.freeze({ 'outside-catalog': 'Preserve arbitrary alias descriptions' });
    const snapshot = Object.freeze({ models, defaultModel: 'outside-catalog',
      hasSecondaryTable: true, hasModelsTable: true });
    const before = JSON.stringify(snapshot);
    const patched = patchModelPool(globalConfig, snapshot);
    expect(inspectModelPool(patched)).toEqual(snapshot);
    expect(JSON.stringify(snapshot)).toBe(before);
    expect(snapshot.models).toBe(models);
    expect(parse(patched).auth.token).toBe(CANARY);
  });

  test('rejects unsupported TOML types and parsing errors with a fixed content-free error', () => {
    const invalidDocuments = [
      'secondary_model = false\n',
      'secondary_model = []\n',
      '[[secondary_model]]\ndefault_model = "alias"\n',
      '[secondary_model]\ndefault_model = false\n',
      '[secondary_model]\ndefault_model = ["alias"]\n',
      '[secondary_model.default_model]\nname = "alias"\n',
      '[secondary_model]\nmodels = false\n',
      '[secondary_model]\nmodels = []\n',
      '[secondary_model]\nmodels = "alias"\n',
      '[[secondary_model.models]]\nalias = "description"\n',
      '[secondary_model.models]\nalias = false\n',
      '[secondary_model.models]\nalias = 42\n',
      '[secondary_model.models]\nalias = ["description"]\n',
      '[secondary_model.models.alias]\nmodel = "wire"\n',
      `broken = ["${CANARY}",\n`,
    ];
    for (const document of invalidDocuments) {
      const text = `synthetic_auth_token = "${CANARY}"\n` + document;
      expectUnsupported(() => inspectModelPool(text));
      expectUnsupported(() => patchModelPool(text, NONE));
    }
    expectUnsupported(() => inspectModelPool(null));
    expectUnsupported(() => patchModelPool(42, NONE));
  });

  test('accepts only the four snapshot fields and a plain string map', () => {
    const valid = { models: { alias: 'Description' }, defaultModel: 'alias',
      hasSecondaryTable: true, hasModelsTable: true };
    const invalidSnapshots = [
      null, [], false, new Date(),
      { ...valid, models: false },
      { ...valid, models: [] },
      { ...valid, models: new Map([['alias', 'Description']]) },
      { ...valid, models: { alias: 1 } },
      { ...valid, models: { alias: false } },
      { ...valid, models: { alias: ['Description'] } },
      { ...valid, models: { alias: { model: 'wire', provider: 'acme', api_key: CANARY } } },
      { ...valid, models: null },
      { ...valid, defaultModel: false },
      { ...valid, defaultModel: ['alias'] },
      { ...valid, defaultModel: undefined },
      { ...valid, hasSecondaryTable: 1 },
      { ...valid, hasModelsTable: 'true' },
      { models: null, defaultModel: null, hasSecondaryTable: false },
      { ...valid, auth: { token: CANARY } },
    ];
    for (const snapshot of invalidSnapshots) expectUnsupported(() => patchModelPool(globalConfig, snapshot));
  });
});
