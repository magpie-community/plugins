// Read and patch only the two secondary-model scalars. Snapshots contain
// their values and original table presence, never the rest of the config.
// Bun reserializes changed documents; unchanged text is returned verbatim.

const SECONDARY_TABLE = 'secondary_model';
const EXPERIMENTAL_TABLE = 'experimental';
const MODEL_KEY = 'model';
const FLAG_KEY = 'secondary-model';

const UNSUPPORTED_MESSAGE = 'secondary_config_unsupported';

function unsupported() {
  return new Error(UNSUPPORTED_MESSAGE);
}

function isTable(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function parseDocument(text) {
  if (typeof text !== 'string') {
    throw unsupported();
  }
  return Bun.TOML.parse(text);
}

function readState(document) {
  const hasSecondaryTable = hasOwn(document, SECONDARY_TABLE);
  let model = null;
  if (hasSecondaryTable) {
    const table = document[SECONDARY_TABLE];
    if (!isTable(table)) {
      throw unsupported();
    }
    if (hasOwn(table, MODEL_KEY)) {
      if (typeof table[MODEL_KEY] !== 'string') {
        throw unsupported();
      }
      model = table[MODEL_KEY];
    }
  }

  const hasExperimentalTable = hasOwn(document, EXPERIMENTAL_TABLE);
  let enabled = null;
  if (hasExperimentalTable) {
    const table = document[EXPERIMENTAL_TABLE];
    if (!isTable(table)) {
      throw unsupported();
    }
    if (hasOwn(table, FLAG_KEY)) {
      if (typeof table[FLAG_KEY] !== 'boolean') {
        throw unsupported();
      }
      enabled = table[FLAG_KEY];
    }
  }

  return { model, enabled, hasSecondaryTable, hasExperimentalTable };
}

function normalizeSnapshot(snapshot) {
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw unsupported();
  }

  const { model, enabled, hasSecondaryTable, hasExperimentalTable } = snapshot;
  if (model !== null && typeof model !== 'string') {
    throw unsupported();
  }
  if (enabled !== null && typeof enabled !== 'boolean') {
    throw unsupported();
  }
  if (typeof hasSecondaryTable !== 'boolean' || typeof hasExperimentalTable !== 'boolean') {
    throw unsupported();
  }

  return { model, enabled, hasSecondaryTable, hasExperimentalTable };
}

function applyState(document, target) {
  if (target.model === null) {
    const table = hasOwn(document, SECONDARY_TABLE) ? document[SECONDARY_TABLE] : null;
    if (table !== null) {
      delete table[MODEL_KEY];
      if (!target.hasSecondaryTable && Object.keys(table).length === 0) {
        delete document[SECONDARY_TABLE];
      }
    } else if (target.hasSecondaryTable) {
      document[SECONDARY_TABLE] = {};
    }
  } else {
    if (!hasOwn(document, SECONDARY_TABLE)) {
      document[SECONDARY_TABLE] = {};
    }
    document[SECONDARY_TABLE][MODEL_KEY] = target.model;
  }

  if (target.enabled === null) {
    const table = hasOwn(document, EXPERIMENTAL_TABLE) ? document[EXPERIMENTAL_TABLE] : null;
    if (table !== null) {
      delete table[FLAG_KEY];
      if (!target.hasExperimentalTable && Object.keys(table).length === 0) {
        delete document[EXPERIMENTAL_TABLE];
      }
    } else if (target.hasExperimentalTable) {
      document[EXPERIMENTAL_TABLE] = {};
    }
  } else {
    if (!hasOwn(document, EXPERIMENTAL_TABLE)) {
      document[EXPERIMENTAL_TABLE] = {};
    }
    document[EXPERIMENTAL_TABLE][FLAG_KEY] = target.enabled;
  }
}

export function inspectSecondary(text) {
  try {
    return readState(parseDocument(text));
  } catch {
    throw unsupported();
  }
}

export function patchSecondary(text, snapshot) {
  try {
    const document = parseDocument(text);
    const target = normalizeSnapshot(snapshot);
    const current = readState(document);

    if (
      current.model === target.model &&
      current.enabled === target.enabled &&
      current.hasSecondaryTable === target.hasSecondaryTable &&
      current.hasExperimentalTable === target.hasExperimentalTable
    ) {
      return text;
    }

    applyState(document, target);
    return Bun.TOML.stringify(document);
  } catch {
    throw unsupported();
  }
}
