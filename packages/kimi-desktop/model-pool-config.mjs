// Only the pool's alias descriptions, default alias and table presence belong
// in a snapshot. Model definitions, providers and credentials stay in the TOML.
// Bun normalizes changed documents; an effective no-op preserves the text.

const SECONDARY_TABLE = 'secondary_model';
const POOL_KEY = 'models';
const DEFAULT_KEY = 'default_model';
const SNAPSHOT_KEYS = ['models', 'defaultModel', 'hasSecondaryTable', 'hasModelsTable'];
const unsupported = () => Error('secondary_config_unsupported');
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function isTable(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function stringMap(value) {
  if (!isTable(value)) throw unsupported();
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string' || typeof value[key] !== 'string')) throw unsupported();
  return Object.fromEntries(keys.map(key => [key, value[key]]));
}

function parseDocument(text) {
  if (typeof text !== 'string') throw unsupported();
  return Bun.TOML.parse(text);
}

function readState(document) {
  const hasSecondaryTable = hasOwn(document, SECONDARY_TABLE);
  const table = hasSecondaryTable ? document[SECONDARY_TABLE] : {};
  if (!isTable(table)) throw unsupported();
  const hasModelsTable = hasOwn(table, POOL_KEY);
  const models = hasModelsTable ? stringMap(table[POOL_KEY]) : null;
  const defaultModel = hasOwn(table, DEFAULT_KEY) ? table[DEFAULT_KEY] : null;
  if (defaultModel !== null && typeof defaultModel !== 'string') throw unsupported();
  return { models, defaultModel, hasSecondaryTable, hasModelsTable };
}

function normalizeSnapshot(snapshot) {
  if (!isTable(snapshot) || Reflect.ownKeys(snapshot).length !== SNAPSHOT_KEYS.length
      || SNAPSHOT_KEYS.some(key => !hasOwn(snapshot, key))) throw unsupported();
  const { models, defaultModel, hasSecondaryTable, hasModelsTable } = snapshot;
  if (models !== null && !isTable(models)) throw unsupported();
  if (defaultModel !== null && typeof defaultModel !== 'string') throw unsupported();
  if (typeof hasSecondaryTable !== 'boolean' || typeof hasModelsTable !== 'boolean') throw unsupported();
  // An existing empty pool is {}, while null always means the pool is absent.
  if (models === null && hasModelsTable) throw unsupported();
  return { models: models === null ? null : stringMap(models), defaultModel,
    hasSecondaryTable, hasModelsTable };
}

function sameState(left, right) {
  if (left.defaultModel !== right.defaultModel || left.hasSecondaryTable !== right.hasSecondaryTable
      || left.hasModelsTable !== right.hasModelsTable) return false;
  if (left.models === null || right.models === null) return left.models === right.models;
  const keys = Object.keys(left.models);
  return keys.length === Object.keys(right.models).length
    && keys.every(key => hasOwn(right.models, key) && left.models[key] === right.models[key]);
}

function applyState(document, target) {
  let table = hasOwn(document, SECONDARY_TABLE) ? document[SECONDARY_TABLE] : null;
  if (table === null) {
    if (!target.hasSecondaryTable && target.models === null && target.defaultModel === null) return;
    table = document[SECONDARY_TABLE] = {};
  }
  if (target.models === null) delete table[POOL_KEY];
  else table[POOL_KEY] = stringMap(target.models);
  if (target.defaultModel === null) delete table[DEFAULT_KEY];
  else table[DEFAULT_KEY] = target.defaultModel;
  if (!target.hasSecondaryTable && Object.keys(table).length === 0) delete document[SECONDARY_TABLE];
}

export function inspectModelPool(text) {
  try {
    return readState(parseDocument(text));
  } catch { throw unsupported(); }
}

export function patchModelPool(text, snapshot) {
  try {
    const document = parseDocument(text);
    const target = normalizeSnapshot(snapshot);
    const current = readState(document);
    if (sameState(current, target)) return text;
    applyState(document, target);
    // Unowned siblings can prevent removal of their parent table. Do not
    // normalize formatting when preserving them made the operation a no-op.
    if (sameState(current, readState(document))) return text;
    return Bun.TOML.stringify(document);
  } catch { throw unsupported(); }
}
