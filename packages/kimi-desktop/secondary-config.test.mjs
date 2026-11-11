import { describe, expect, test } from 'bun:test';

import { inspectSecondary, patchSecondary } from './secondary-config.mjs';

// All fixtures below are synthetic. The canary is used only to prove that
// unsupported input does not leak document contents through the fixed error.
const CANARY = 'sk-synthetic-0f4a9c-canary';
const UNSUPPORTED = 'secondary_config_unsupported';

const NO_SETTINGS = {
  model: null,
  enabled: null,
  hasSecondaryTable: false,
  hasExperimentalTable: false,
};

function parse(text) {
  return Bun.TOML.parse(text);
}

/** Snapshot exactly as the caller would persist it (JSON, non-credential state). */
function snapshotOf(text) {
  return JSON.parse(JSON.stringify(inspectSecondary(text)));
}

/**
 * Deep, order-independent view of parsed TOML. Temporal values (dates/times)
 * become their TOML text so two documents can be compared as plain data.
 */
function canonical(value) {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (value !== null && typeof value === 'object') {
    if (typeof value.toJSON === 'function') {
      return value.toJSON();
    }
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = canonical(value[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Canonical parsed document with the two managed scalars removed, plus any
 * section left empty by that removal. Everything else must survive a rewrite.
 */
function unrelatedConfig(text) {
  const document = canonical(parse(text));
  for (const [tableName, scalarName] of [
    ['secondary_model', 'model'],
    ['experimental', 'secondary-model'],
  ]) {
    const table = document[tableName];
    if (table === undefined) {
      continue;
    }
    delete table[scalarName];
    if (Object.keys(table).length === 0) {
      delete document[tableName];
    }
  }
  return document;
}

/**
 * Assert the operation fails with the single fixed error and return it so the
 * caller can inspect what it does (or does not) expose.
 */
function expectUnsupported(operation) {
  let error;
  try {
    operation();
  } catch (caught) {
    error = caught;
  }

  expect(error).toBeInstanceOf(Error);
  expect(error.constructor).toBe(Error);
  expect(error.message).toBe(UNSUPPORTED);
  expect(error.cause).toBeUndefined();
  return error;
}

function expectNoCanary(error) {
  const exposed = JSON.stringify({
    name: error.name,
    message: error.message,
    stack: error.stack,
    cause: error.cause ?? null,
  });
  expect(exposed).not.toContain(CANARY);
}

describe('inspectSecondary', () => {
  test('reports missing settings as nulls with table presence flags', () => {
    expect(inspectSecondary('default_model = "primary"\n')).toEqual(NO_SETTINGS);
    expect(inspectSecondary('')).toEqual(NO_SETTINGS);
  });

  test('distinguishes an absent scalar from an explicit false flag', () => {
    expect(inspectSecondary('[experimental]\nsecondary-model = false\n').enabled).toBe(false);
    expect(inspectSecondary('[experimental]\nsecondary-model = true\n').enabled).toBe(true);

    const emptyFlagTable = inspectSecondary('[experimental]\n');
    expect(emptyFlagTable.enabled).toBeNull();
    expect(emptyFlagTable.hasExperimentalTable).toBe(true);

    const emptyModelTable = inspectSecondary('[secondary_model]\n');
    expect(emptyModelTable.model).toBeNull();
    expect(emptyModelTable.hasSecondaryTable).toBe(true);
  });

  test('reads the hyphenated experimental key and ignores the underscored spelling', () => {
    expect(inspectSecondary('[experimental]\n"secondary-model" = false\n').enabled).toBe(false);
    expect(inspectSecondary('[experimental]\nsecondary_model = true\n').enabled).toBeNull();
  });
});

describe('patchSecondary', () => {
  test('adds both settings to a config that has neither table', () => {
    const original = [
      '# synthetic fixture',
      'default_model = "primary-alias"',
      '',
      '[providers.acme]',
      'api_key = "sk-synthetic-provider-key"',
      'base_url = "https://acme.invalid/v1"',
      '',
      '[models.primary-alias]',
      'model = "wire-primary"',
      'provider = "acme"',
      '',
    ].join('\n');

    expect(inspectSecondary(original)).toEqual(NO_SETTINGS);

    const patched = patchSecondary(original, {
      model: 'primary-alias',
      enabled: true,
      hasSecondaryTable: false,
      hasExperimentalTable: false,
    });

    expect(inspectSecondary(patched)).toEqual({
      model: 'primary-alias',
      enabled: true,
      hasSecondaryTable: true,
      hasExperimentalTable: true,
    });

    const parsed = parse(patched);
    expect(parsed.providers.acme.api_key).toBe('sk-synthetic-provider-key');
    expect(parsed.models['primary-alias'].model).toBe('wire-primary');
    expect(parsed.default_model).toBe('primary-alias');

    // An idle tick that re-applies the inspected snapshot must not rewrite.
    expect(patchSecondary(patched, snapshotOf(patched))).toBe(patched);
  });

  test('round-trips a non-default model and disabled flag through a JSON snapshot', () => {
    const original = [
      'default_model = "primary-alias"',
      '',
      '[secondary_model]',
      'model = "secondary-slow"',
      'default_effort = "max"',
      'capabilities = ["thinking", "tool_use"]',
      '',
      '[experimental]',
      'secondary-model = false',
      'keep-me = 1',
      '',
      '[providers.acme]',
      'api_key = "sk-synthetic-provider-key"',
      'base_url = "https://acme.invalid/v1"',
      '',
      '[models.primary-alias]',
      'model = "wire-primary"',
      '',
      '[models.secondary-slow]',
      'model = "wire-secondary"',
      'max_context_size = 131072',
      '',
    ].join('\n');

    const snapshot = snapshotOf(original);
    expect(snapshot).toEqual({
      model: 'secondary-slow',
      enabled: false,
      hasSecondaryTable: true,
      hasExperimentalTable: true,
    });
    const snapshotBefore = JSON.stringify(snapshot);

    const modified = patchSecondary(original, {
      model: 'primary-alias',
      enabled: true,
      hasSecondaryTable: true,
      hasExperimentalTable: true,
    });

    expect(inspectSecondary(modified)).toEqual({
      model: 'primary-alias',
      enabled: true,
      hasSecondaryTable: true,
      hasExperimentalTable: true,
    });
    // Sibling keys in the same two tables must survive the rewrite.
    expect(parse(modified).secondary_model.default_effort).toBe('max');
    expect(parse(modified).secondary_model.capabilities).toEqual(['thinking', 'tool_use']);
    expect(parse(modified).experimental['keep-me']).toBe(1);

    const restored = patchSecondary(modified, snapshot);
    expect(canonical(parse(restored))).toEqual(canonical(parse(original)));
    expect(inspectSecondary(restored)).toEqual(snapshot);
    expect(JSON.stringify(snapshot)).toBe(snapshotBefore);
  });

  test('removes only sections it created when the snapshot says they were absent', () => {
    const original = 'default_model = "primary"\n\n[models.primary]\nmodel = "wire"\n';
    const withSecondary = patchSecondary(original, {
      model: 'primary',
      enabled: true,
      hasSecondaryTable: false,
      hasExperimentalTable: false,
    });

    expect(parse(withSecondary).secondary_model).toEqual({ model: 'primary' });
    expect(parse(withSecondary).experimental).toEqual({ 'secondary-model': true });

    const restored = patchSecondary(withSecondary, snapshotOf(original));
    const parsed = parse(restored);

    expect('secondary_model' in parsed).toBe(false);
    expect('experimental' in parsed).toBe(false);
    expect(parsed).toEqual(parse(original));
    expect(restored).not.toContain('[secondary_model]');
    expect(restored).not.toContain('[experimental]');
  });

  test('keeps target sections that still hold unrelated keys', () => {
    const original = [
      '[secondary_model]',
      'model = "slow"',
      'default_effort = "high"',
      '',
      '[experimental]',
      'secondary-model = true',
      'nested = { retries = 2 }',
      '',
    ].join('\n');

    const cleared = patchSecondary(original, NO_SETTINGS);
    const parsed = parse(cleared);

    expect('model' in parsed.secondary_model).toBe(false);
    expect(parsed.secondary_model.default_effort).toBe('high');
    expect('secondary-model' in parsed.experimental).toBe(false);
    expect(parsed.experimental.nested).toEqual({ retries: 2 });

    expect(inspectSecondary(cleared)).toEqual({
      model: null,
      enabled: null,
      hasSecondaryTable: true,
      hasExperimentalTable: true,
    });
  });

  test('preserves empty tables recorded by the snapshot and recreates them when missing', () => {
    const emptyTables = '[secondary_model]\n\n[experimental]\n';
    const emptySnapshot = {
      model: null,
      enabled: null,
      hasSecondaryTable: true,
      hasExperimentalTable: true,
    };

    // Both sections already exist and are empty: return the exact bytes.
    expect(patchSecondary(emptyTables, emptySnapshot)).toBe(emptyTables);

    // The snapshot remembers empty sections that the current text lacks.
    const noTables = 'default_model = "primary"\n';
    const created = patchSecondary(noTables, emptySnapshot);
    expect(inspectSecondary(created)).toEqual(emptySnapshot);
    expect(patchSecondary(created, emptySnapshot)).toBe(created);
  });

  test('returns the original text untouched when the snapshot already matches', () => {
    const text = [
      '# keep my formatting',
      'default_model   =   "primary"',
      '',
      '[ experimental ]   # inline comment',
      'secondary-model    =   false',
      '',
      '[secondary_model]',
      'model    =    "slow"   # trailing comment',
      '',
    ].join('\n');

    const snapshot = snapshotOf(text);
    expect(snapshot).toEqual({
      model: 'slow',
      enabled: false,
      hasSecondaryTable: true,
      hasExperimentalTable: true,
    });
    expect(patchSecondary(text, snapshot)).toBe(text);
    expect(patchSecondary(text, JSON.parse(JSON.stringify(snapshot)))).toBe(text);

    const absent = 'default_model = "primary"\n';
    expect(patchSecondary(absent, NO_SETTINGS)).toBe(absent);
  });

  test('preserves every unrelated TOML value across a rewrite', () => {
    const original = [
      'default_model = "primary-alias"',
      'created = 2026-11-07T00:00:00Z',
      'ratio = 0.125',
      '"quoted key" = "value"',
      'tags = ["alpha", "beta"]',
      'inline = { retries = 2, mode = "safe" }',
      '',
      '[experimental]',
      'secondary-model = false',
      'other_flag = true',
      '',
      '[secondary_model]',
      'model = "secondary-slow"',
      'default_effort = "max"',
      '',
      '[providers.acme]',
      'api_key = "sk-synthetic-provider-key"',
      'base_url = "https://acme.invalid/v1"',
      '',
      '[models.primary-alias]',
      'model = "wire-primary"',
      'provider = "acme"',
      'max_context_size = 262144',
      '',
      '[[models.primary-alias.capabilities]]',
      'name = "thinking"',
      '',
      '[[models.primary-alias.capabilities]]',
      'name = "tool_use"',
      '',
    ].join('\n');

    const patched = patchSecondary(original, {
      model: 'primary-alias',
      enabled: true,
      hasSecondaryTable: true,
      hasExperimentalTable: true,
    });

    expect(inspectSecondary(patched)).toEqual({
      model: 'primary-alias',
      enabled: true,
      hasSecondaryTable: true,
      hasExperimentalTable: true,
    });
    expect(unrelatedConfig(patched)).toEqual(unrelatedConfig(original));
    expect(canonical(parse(patched).created)).toBe('2026-11-07T00:00:00Z');
    expect(parse(patched).inline).toEqual({ retries: 2, mode: 'safe' });
  });

  test('normalizes every unsupported shape to one fixed, content-free error', () => {
    const validText = 'default_model = "primary"\n';

    const invalidDocuments = [
      // section name already used by a scalar
      `secondary_model = "primary"\n\n[providers.${CANARY}]\napi_key = "${CANARY}"\n`,
      // array of tables instead of a table
      `[[secondary_model]]\nmodel = "primary"\n\n[providers.${CANARY}]\napi_key = "${CANARY}"\n`,
      // model present but not a string
      `[secondary_model]\nmodel = 7\n\n[providers.${CANARY}]\napi_key = "${CANARY}"\n`,
      // model used as a nested table
      `[secondary_model.model]\nname = "primary"\n\n[providers.${CANARY}]\napi_key = "${CANARY}"\n`,
      // experimental section is not a table
      `experimental = true\n\n[providers.${CANARY}]\napi_key = "${CANARY}"\n`,
      `[[experimental]]\nsecondary-model = true\n\n[providers.${CANARY}]\napi_key = "${CANARY}"\n`,
      // flag present but not a boolean
      `[experimental]\nsecondary-model = "true"\n\n[providers.${CANARY}]\napi_key = "${CANARY}"\n`,
      `[experimental]\nsecondary-model = 0\n\n[providers.${CANARY}]\napi_key = "${CANARY}"\n`,
      // parse error whose native message would name the synthetic provider key
      `[providers.${CANARY}]\napi_key = "${CANARY}"\n[providers.${CANARY}]\n`,
      // parse error with an unterminated array after the canary
      `api_key = "${CANARY}"\nbroken = [1,\n`,
    ];

    for (const document of invalidDocuments) {
      for (const operation of [
        () => inspectSecondary(document),
        () => patchSecondary(document, NO_SETTINGS),
      ]) {
        expectNoCanary(expectUnsupported(operation));
      }
    }

    const invalidSnapshots = [
      null,
      [],
      { model: 7, enabled: true, hasSecondaryTable: false, hasExperimentalTable: false },
      { model: null, enabled: 'true', hasSecondaryTable: false, hasExperimentalTable: false },
      { model: null, enabled: null, hasSecondaryTable: false },
      { model: undefined, enabled: null, hasSecondaryTable: false, hasExperimentalTable: false },
    ];
    for (const snapshot of invalidSnapshots) {
      expectNoCanary(expectUnsupported(() => patchSecondary(validText, snapshot)));
    }

    expectUnsupported(() => inspectSecondary(42));
    expectUnsupported(() => inspectSecondary(null));
    expectUnsupported(() => patchSecondary(null, NO_SETTINGS));
  });
});
