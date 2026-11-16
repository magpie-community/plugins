// Mirror magpie's selection into PI-Desktop's SQLite database.
//
// magpie writes ~/.pi-desktop/magpie-agent.json; this module keeps the
// provider, its model list and the app's default model in step. PI-Desktop may
// be running at the same time, so every write is one short transaction, the
// connection waits with a busy timeout, and a busy database is retried.
//
// magpie loads a plugin's entry module in Bun and calls every exported
// function as a plugin. Only the default export is a plugin function; helpers
// live on _internal for the tests.

import { Database } from "bun:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LOG_PREFIX = "[magpie-pi-desktop]";
// PI-Desktop deletes provider rows whose owner_plugin_id names a plugin it has
// not loaded, so our rows keep it NULL; the fixed id is the marker instead.
const PLUGIN_PROVIDER_ID = "magpie-pi-desktop";
const DATA_DIR_NAME = ".pi-desktop";
const DEV_DATA_DIR_NAME = ".pi-desktop-dev";
const BACKUP_DIR_NAME = "magpie-backups";
const MAX_BACKUPS = 10;
const BUSY_TIMEOUT_MS = 5000;
const BUSY_RETRY_DELAYS = [100, 300, 600];
const INITIAL_SYNC_DELAY_MS = 500;
const POLL_INTERVAL_MS = 2000;
// PI-Desktop can disable a provider (its model picker then hides it) or reset
// the default model while running, so re-assert our row even without a config
// change.
const HEARTBEAT_MS = 10000;
// Reasons worth one log line when the watcher first hits them; "no-config"
// and "unchanged" are normal steady states and stay quiet.
const NOTABLE_REASONS = new Set([
  "no-db",
  "db-busy",
  "db-error",
  "config-error",
  "invalid-config",
  "invalid-base-url",
  "invalid-provider-config",
  "no-base-url",
]);

// A database is backed up once per process, right before our first write.
const backedUpDatabases = new Set();

const PROVIDER_DEFAULTS = {
  vendorKey: "custom",
  type: "openai_compatible",
  protocol: "openai_compatible",
  apiStyle: "chat_completions",
  authKind: "none",
  enabled: 1,
};

function isLoopbackUrl(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
  } catch {
    return false;
  }
}

function isOurProviderRow(row) {
  if (!row) return false;
  const id = String(row.id ?? "");
  const idMatches = id === PLUGIN_PROVIDER_ID || id.startsWith(`${PLUGIN_PROVIDER_ID}-`);
  if (!idMatches) return false;
  // Older builds of this plugin marked their rows with owner_plugin_id
  // "magpie-agent"; PI-Desktop would delete such a row, so new rows use NULL.
  // A row renamed in PI-Desktop is still ours when it is a no-auth loopback
  // provider under our fixed id.
  return (
    row.name === "magpie" ||
    row.owner_plugin_id === "magpie-agent" ||
    (row.auth_kind === "none" && isLoopbackUrl(row.base_url))
  );
}

function logError(log, message, error) {
  const text = error ? `${message}: ${error?.message ?? error}` : message;
  try {
    if (typeof log === "function") log(text);
    else console.error(`${LOG_PREFIX} ${text}`);
  } catch {
    // Logging must never become the failure.
  }
}

function expandHome(value) {
  if (typeof value !== "string") return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

// PI-Desktop resolves its data folder with
//   resolve(join(os.homedir(), ".pi-desktop"))
// on Windows, macOS and Linux alike (its main bundle names
// INSTALLATION_DATA_DIR_NAME=".pi-desktop"; development builds use
// ".pi-desktop-dev"). It also honours PI_DESKTOP_DATA_DIR and PI_DESKTOP_DEV.
// Mirror that here instead of guessing per platform.
function defaultDataDir() {
  const explicit =
    typeof process.env.PI_DESKTOP_DATA_DIR === "string"
      ? process.env.PI_DESKTOP_DATA_DIR.trim()
      : "";
  if (explicit) return path.resolve(expandHome(explicit));
  const home = os.homedir();
  return path.join(home, process.env.PI_DESKTOP_DEV === "1" ? DEV_DATA_DIR_NAME : DATA_DIR_NAME);
}

function resolvePaths(overrides = {}) {
  const home = os.homedir();
  const dataDir = defaultDataDir();
  const dbPath = expandHome(
    overrides.dbPath || process.env.PI_DESKTOP_DB || path.join(dataDir, "pi.sqlite"),
  );
  // magpie writes the sidecar at the agent's `config` path, which this package
  // declares as ~/.pi-desktop/magpie-agent.json; PI_DESKTOP_DATA_DIR moves the
  // database, not that file.
  const configPath = expandHome(
    overrides.configPath ||
      process.env.PI_DESKTOP_AGENT_CONFIG ||
      path.join(home, DATA_DIR_NAME, "magpie-agent.json"),
  );
  return { dbPath: path.resolve(dbPath), configPath: path.resolve(configPath) };
}

function toPositiveInteger(value) {
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
}

function normalizeConfigModels(value) {
  if (!Array.isArray(value)) return [];
  const models = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!id) continue;
    const model = { id };
    if (typeof entry.name === "string" && entry.name.trim()) model.name = entry.name.trim();
    const context = toPositiveInteger(entry.context);
    if (context !== null) model.context = context;
    const output = toPositiveInteger(entry.output);
    if (output !== null) model.output = output;
    models.push(model);
  }
  return models;
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function readConfigFile(configPath) {
  let raw;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch (error) {
    return { error: error?.code === "ENOENT" ? "no-config" : "config-error" };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    return { error: "invalid-config" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "invalid-config" };
  }
  const model = typeof parsed.model === "string" ? parsed.model.trim() : "";
  if (!model) return { error: "no-model" };
  const baseUrl = typeof parsed.baseUrl === "string" ? parsed.baseUrl.trim() : "";
  if (baseUrl && !isHttpUrl(baseUrl)) return { error: "invalid-base-url" };
  return {
    config: {
      model,
      modelName: typeof parsed.modelName === "string" ? parsed.modelName.trim() : "",
      baseUrl,
      providerId: typeof parsed.providerId === "string" ? parsed.providerId.trim() : "",
      // apiKey is deliberately not kept: PI-Desktop reaches magpie on loopback
      // and the gateway needs no key there, and it must never be logged.
      models: normalizeConfigModels(parsed.models),
    },
  };
}

function parseJsonObject(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function canonicalize(value) {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function normalizeBaseUrl(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    // Treat localhost and ::1 as the same loopback host as 127.0.0.1 so a
    // provider already pointing at the gateway is reused, not duplicated.
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host === "[::1]" || host === "::1") {
      url.hostname = "127.0.0.1";
    }
    return url.toString().replace(/\/+$/, "");
  } catch {
    return trimmed;
  }
}

// Merge magpie's models into config_json.models, keeping every existing entry.
function mergeModels(existingConfig, configModels, selectedModel) {
  const nextConfig = { ...existingConfig };
  const models = Array.isArray(nextConfig.models)
    ? nextConfig.models
        .filter((model) => model && typeof model === "object" && !Array.isArray(model))
        .map((model) => ({ ...model }))
    : [];
  const byId = new Map();
  models.forEach((model, index) => {
    if (typeof model.id === "string" && !byId.has(model.id)) byId.set(model.id, index);
  });

  const ensure = (id, info) => {
    const index = byId.get(id);
    if (index === undefined) {
      models.push({
        id,
        contextWindow: info?.context ?? null,
        contextWindowSource: "catalog",
        maxTokens: info?.output ?? null,
        maxTokensSource: "catalog",
        defaultThinkingLevel: null,
        thinkingLevels: [],
      });
      byId.set(id, models.length - 1);
      return;
    }
    const model = models[index];
    model.id = id;
    if (info?.context !== undefined) {
      model.contextWindow = info.context;
      model.contextWindowSource = "catalog";
    }
    if (info?.output !== undefined) {
      model.maxTokens = info.output;
      model.maxTokensSource = "catalog";
    }
  };

  for (const info of configModels) ensure(info.id, info);
  // The selected model must be present even when models[] omitted it.
  ensure(selectedModel, configModels.find((info) => info.id === selectedModel));

  // PI-Desktop takes a provider's default model from config_json.models[0].id,
  // so the selected model has to lead the list.
  const selectedIndex = models.findIndex((model) => model.id === selectedModel);
  if (selectedIndex > 0) {
    const [selected] = models.splice(selectedIndex, 1);
    models.unshift(selected);
  }

  nextConfig.models = models;
  return { config: nextConfig, models };
}

function findProvider(db, config) {
  // Our own fixed id is the strongest match: it survives a gateway port change
  // and never depends on a name the user may have edited.
  const fixed = db.prepare("SELECT * FROM providers WHERE id = ?").get(PLUGIN_PROVIDER_ID);
  if (isOurProviderRow(fixed)) return fixed;

  // An explicit providerId is a deliberate hand-written override. The sync
  // still only rewrites base_url on a row it owns, but honour the choice.
  if (config.providerId) {
    const row = db.prepare("SELECT * FROM providers WHERE id = ?").get(config.providerId);
    if (row) return row;
  }

  const wantedBaseUrl = normalizeBaseUrl(config.baseUrl);
  if (!wantedBaseUrl) return null;

  // Exact base URL only. A loose "name looks like magpie" or substring match
  // could adopt an unrelated provider that happens to sit on a loopback port.
  const rows = db
    .prepare(
      `SELECT * FROM providers
       ORDER BY CASE WHEN id = ? THEN 0 WHEN id LIKE ? THEN 1 ELSE 2 END,
                updated_at DESC, id ASC`,
    )
    .all(PLUGIN_PROVIDER_ID, `${PLUGIN_PROVIDER_ID}-%`);
  return rows.find((row) => normalizeBaseUrl(row.base_url) === wantedBaseUrl) ?? null;
}

// Only these rows may be force-enabled (and have their base_url refreshed):
// ours, a row explicitly named in the sidecar, or a provider that already
// points exactly at the magpie gateway. Everything else is user-owned.
function isManagedProvider(provider, config) {
  if (!provider) return false;
  if (isOurProviderRow(provider)) return true;
  if (config.providerId && provider.id === config.providerId) return true;
  const wantedBaseUrl = normalizeBaseUrl(config.baseUrl);
  return Boolean(wantedBaseUrl) && normalizeBaseUrl(provider.base_url) === wantedBaseUrl;
}

function chooseProviderId(db) {
  const fixed = db.prepare("SELECT * FROM providers WHERE id = ?").get(PLUGIN_PROVIDER_ID);
  if (!fixed) return { id: PLUGIN_PROVIDER_ID, existing: null };
  // Our own row from an earlier run: update it instead of adding a duplicate.
  if (isOurProviderRow(fixed)) return { id: PLUGIN_PROVIDER_ID, existing: fixed };
  for (let suffix = 2; suffix <= 999; suffix += 1) {
    const id = `${PLUGIN_PROVIDER_ID}-${suffix}`;
    const row = db.prepare("SELECT * FROM providers WHERE id = ?").get(id);
    if (!row) return { id, existing: null };
    if (isOurProviderRow(row)) return { id, existing: row };
  }
  throw new Error("no free provider id for magpie");
}

function planProviderUpdate(provider, config, now) {
  const current = parseJsonObject(provider.config_json);
  if (
    current === null &&
    !isOurProviderRow(provider) &&
    typeof provider.config_json === "string" &&
    provider.config_json.trim() !== "" &&
    provider.config_json.trim() !== "{}"
  ) {
    // Refuse to replace a user's unparseable config with a models-only object:
    // that would silently drop whatever the row had in it.
    return { error: "invalid-provider-config" };
  }

  const merged = mergeModels(current ?? {}, config.models, config.model);
  const configJson = JSON.stringify(merged.config);
  const configChanged =
    current === null || canonicalize(current) !== canonicalize(merged.config);
  const modelChanged = provider.default_model_id !== config.model;
  const managed = isManagedProvider(provider, config);
  // A plugin-owned row follows magpie's base URL. A user row is left alone.
  const baseUrlChanged =
    isOurProviderRow(provider) &&
    Boolean(config.baseUrl) &&
    normalizeBaseUrl(provider.base_url) !== normalizeBaseUrl(config.baseUrl);
  // PI-Desktop's model picker drops disabled providers entirely, so a provider
  // magpie is actively using must be on. Never enable unrelated rows.
  const enabledChanged = managed && Number(provider.enabled) !== 1;
  // A row left by an older build may still carry owner_plugin_id; PI-Desktop
  // deletes such rows on startup, so clear the legacy marker when updating it.
  const ownerChanged = isOurProviderRow(provider) && provider.owner_plugin_id != null;
  const update =
    configChanged || modelChanged || baseUrlChanged || enabledChanged || ownerChanged
      ? {
          id: provider.id,
          model: config.model,
          configJson,
          baseUrl: baseUrlChanged ? config.baseUrl : null,
          enable: enabledChanged,
          clearOwner: ownerChanged,
          updatedAt: now,
        }
      : null;
  return { created: false, providerId: provider.id, models: merged.models, update };
}

function planProvider(db, config, now) {
  const found = findProvider(db, config);
  if (found) return planProviderUpdate(found, config, now);

  if (!config.baseUrl) return { error: "no-base-url" };
  const chosen = chooseProviderId(db);
  if (chosen.existing) return planProviderUpdate(chosen.existing, config, now);

  const merged = mergeModels({}, config.models, config.model);
  return {
    created: true,
    providerId: chosen.id,
    models: merged.models,
    insert: {
      id: chosen.id,
      name: "magpie",
      baseUrl: config.baseUrl,
      model: config.model,
      configJson: JSON.stringify(merged.config),
      createdAt: now,
      updatedAt: now,
    },
  };
}

function planModelRow(db, providerId, config, mergedModels, now, log) {
  let existing = null;
  try {
    existing =
      db
        .prepare("SELECT * FROM models WHERE provider_id = ? AND model_id = ?")
        .get(providerId, config.model) ?? null;
  } catch (error) {
    logError(log, "models table unavailable; skipped", error);
    return { write: null };
  }

  const info = config.models.find((model) => model.id === config.model);
  const merged = mergedModels.find((model) => model.id === config.model);
  const displayName = info?.name || config.modelName || existing?.display_name || config.model;

  if (!existing) {
    return {
      write: {
        kind: "insert",
        providerId,
        modelId: config.model,
        displayName,
        contextWindow: info?.context ?? merged?.contextWindow ?? null,
        maxOutputTokens: info?.output ?? merged?.maxTokens ?? null,
        updatedAt: now,
      },
    };
  }

  const displayChanged = existing.display_name !== displayName;
  const sourceChanged = existing.source !== "user";
  const contextChanged = info?.context !== undefined && existing.context_window !== info.context;
  const outputChanged = info?.output !== undefined && existing.max_output_tokens !== info.output;
  if (!displayChanged && !sourceChanged && !contextChanged && !outputChanged) {
    return { write: null };
  }
  return {
    write: {
      kind: "update",
      providerId,
      modelId: config.model,
      displayName,
      contextWindow: contextChanged ? info.context : null,
      maxOutputTokens: outputChanged ? info.output : null,
      updatedAt: now,
    },
  };
}

function planKv(db, providerId, model, log, options = {}) {
  let row = null;
  try {
    row =
      db.prepare("SELECT value_json, updated_at FROM kv WHERE ns = 'app' AND key = 'app'").get() ??
      null;
  } catch (error) {
    logError(log, "kv table unavailable; skipped", error);
    return { write: null };
  }

  if (!row) {
    return {
      write: {
        kind: "insert",
        valueJson: JSON.stringify({ defaultProviderId: providerId, defaultModelId: model }),
        updatedAt: Date.now(),
      },
    };
  }

  const current = parseJsonObject(row.value_json);
  if (!current) {
    logError(log, "kv app/app is not a JSON object; skipped");
    return { write: null };
  }
  const currentProvider = current.defaultProviderId;
  const providerMissing =
    typeof currentProvider !== "string" ||
    currentProvider === "" ||
    !db.prepare("SELECT 1 AS found FROM providers WHERE id = ?").get(currentProvider);
  // Take over a dangling default, our current row, or any older row id from
  // this plugin's namespace (a fixed id may have been freed since).
  const currentIsOurs =
    currentProvider === providerId ||
    currentProvider === PLUGIN_PROVIDER_ID ||
    (typeof currentProvider === "string" &&
      currentProvider.startsWith(`${PLUGIN_PROVIDER_ID}-`));
  // The first time magpie's provider is created, the user has just picked a
  // model for PI-Desktop in magpie. Leaving another provider as the app
  // default would mean new PI-Desktop sessions keep the old model, so the
  // selection would appear to do nothing. Take the default over once; after
  // that the row exists, so a later choice of default inside PI-Desktop is
  // left alone (the heartbeat never steals a live foreign default).
  const ours = providerMissing || currentIsOurs || options.created === true;
  const nextProvider = ours ? providerId : currentProvider;
  if (!ours || (current.defaultModelId === model && current.defaultProviderId === nextProvider)) {
    return { write: null };
  }

  return {
    write: {
      kind: "update",
      valueJson: JSON.stringify({
        ...current,
        defaultProviderId: nextProvider,
        defaultModelId: model,
      }),
      // Keep the app's stamp as it was; the sync is not a user edit.
      updatedAt: Number.isFinite(row.updated_at) ? row.updated_at : Date.now(),
    },
  };
}

function applyProvider(db, plan) {
  if (plan.insert) {
    const insert = plan.insert;
    db.prepare(
      `INSERT INTO providers
         (id, name, vendor_key, type, protocol, api_style, auth_kind, base_url,
          enabled, secret_ref, default_model_id, config_json, created_at, updated_at,
          owner_plugin_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL)`,
    ).run(
      insert.id,
      insert.name,
      PROVIDER_DEFAULTS.vendorKey,
      PROVIDER_DEFAULTS.type,
      PROVIDER_DEFAULTS.protocol,
      PROVIDER_DEFAULTS.apiStyle,
      PROVIDER_DEFAULTS.authKind,
      insert.baseUrl,
      PROVIDER_DEFAULTS.enabled,
      insert.model,
      insert.configJson,
      insert.createdAt,
      insert.updatedAt,
    );
    return;
  }

  const update = plan.update;
  if (!update) return;
  // Build the update from the fields that actually change, so a user-owned row
  // keeps its auth, secret_ref, vendor_key and enabled state.
  const sets = ["default_model_id = ?", "config_json = ?", "updated_at = ?"];
  const values = [update.model, update.configJson, update.updatedAt];
  if (update.baseUrl) {
    sets.push("base_url = ?");
    values.push(update.baseUrl);
  }
  if (update.enable) sets.push("enabled = 1");
  if (update.clearOwner) sets.push("owner_plugin_id = NULL");
  values.push(update.id);
  db.prepare(`UPDATE providers SET ${sets.join(", ")} WHERE id = ?`).run(...values);
}

function applyModel(db, write) {
  if (write.kind === "insert") {
    db.prepare(
      `INSERT INTO models
         (provider_id, model_id, display_name, source, capabilities_json,
          context_window, max_output_tokens, deprecated, updated_at, discovery_state)
       VALUES (?, ?, ?, 'user', '[]', ?, ?, 0, ?, 'published')`,
    ).run(
      write.providerId,
      write.modelId,
      write.displayName,
      write.contextWindow,
      write.maxOutputTokens,
      write.updatedAt,
    );
    return;
  }
  // COALESCE keeps columns magpie did not give a value for.
  db.prepare(
    `UPDATE models
     SET display_name = ?, source = 'user',
         context_window = COALESCE(?, context_window),
         max_output_tokens = COALESCE(?, max_output_tokens),
         updated_at = ?
     WHERE provider_id = ? AND model_id = ?`,
  ).run(
    write.displayName,
    write.contextWindow,
    write.maxOutputTokens,
    write.updatedAt,
    write.providerId,
    write.modelId,
  );
}

function applyKv(db, write) {
  if (write.kind === "insert") {
    db.prepare(
      "INSERT INTO kv (ns, key, value_json, updated_at) VALUES ('app', 'app', ?, ?)",
    ).run(write.valueJson, write.updatedAt);
    return;
  }
  db.prepare("UPDATE kv SET value_json = ?, updated_at = ? WHERE ns = 'app' AND key = 'app'").run(
    write.valueJson,
    write.updatedAt,
  );
}

function backupStamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(
    date.getHours(),
  )}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function pruneBackups(dir, base, log) {
  try {
    const prefix = `${base}.`;
    const backups = fs
      .readdirSync(dir)
      .filter(
        (name) =>
          name.startsWith(prefix) &&
          /^\d{8}-\d{6}(-\d+)?\.bak$/.test(name.slice(prefix.length)),
      )
      .sort();
    if (backups.length <= MAX_BACKUPS) return;
    for (const name of backups.slice(0, backups.length - MAX_BACKUPS)) {
      try {
        fs.rmSync(path.join(dir, name), { force: true });
      } catch (error) {
        logError(log, `could not remove old backup ${name}`, error);
      }
    }
  } catch (error) {
    logError(log, "backup cleanup failed", error);
  }
}

function backupDatabase(db, dbPath, log) {
  const key = path.resolve(dbPath);
  if (backedUpDatabases.has(key)) return;

  const dir = path.join(path.dirname(key), BACKUP_DIR_NAME);
  const base = path.basename(key);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const prefix = `${base}.${backupStamp()}`;
    let target = path.join(dir, `${prefix}.bak`);
    for (let suffix = 1; fs.existsSync(target); suffix += 1) {
      target = path.join(dir, `${prefix}-${suffix}.bak`);
    }

    let written = false;
    try {
      if (typeof db.serialize === "function") {
        const bytes = db.serialize();
        fs.writeFileSync(
          target,
          bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
          { mode: 0o600 },
        );
        written = true;
      }
    } catch (error) {
      logError(log, "consistent backup failed; copying the database file", error);
    }
    if (!written) {
      fs.copyFileSync(key, target);
      try {
        fs.chmodSync(target, 0o600);
      } catch {
        // chmod is a no-op or unsupported on some platforms; the copy is still
        // a valid fallback backup.
      }
    }
    // Remember only a backup that was actually written, so a transient disk
    // failure is retried before the next write.
    backedUpDatabases.add(key);
    pruneBackups(dir, base, log);
  } catch (error) {
    // A missing safety copy is worth a warning, not a failed sync.
    logError(log, "database backup failed; continuing", error);
  }
}

function isBusyError(error) {
  const text = `${error?.code ?? ""} ${error?.message ?? ""}`;
  return /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database table is locked/i.test(text);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withBusyRetry(db, write, retryDelays = BUSY_RETRY_DELAYS) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        write();
        db.exec("COMMIT");
        return;
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // The transaction may already have ended.
        }
        throw error;
      }
    } catch (error) {
      if (!isBusyError(error) || attempt >= retryDelays.length) throw error;
      await sleep(retryDelays[attempt]);
    }
  }
}

async function syncOnce(options = {}) {
  const { dbPath, configPath } = resolvePaths(options);
  const log = options.log;
  const busyTimeoutMs =
    Number.isFinite(options.busyTimeoutMs) && options.busyTimeoutMs >= 0
      ? Math.floor(options.busyTimeoutMs)
      : BUSY_TIMEOUT_MS;
  const retryDelays = Array.isArray(options.busyRetryDelays)
    ? options.busyRetryDelays
    : BUSY_RETRY_DELAYS;

  const loaded = readConfigFile(configPath);
  if (loaded.error) return { changed: false, reason: loaded.error };
  const config = loaded.config;

  if (!fs.existsSync(dbPath)) {
    return { changed: false, reason: "no-db", model: config.model };
  }

  let db = null;
  try {
    db = new Database(dbPath, { readwrite: true, create: false });
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    // Read the existing mode without changing it; PI-Desktop usually uses WAL.
    db.prepare("PRAGMA journal_mode").get();

    // Check first so an unchanged sync neither writes nor makes a backup.
    const now = Date.now();
    const checkProvider = planProvider(db, config, now);
    if (checkProvider.error) {
      return { changed: false, reason: checkProvider.error, model: config.model };
    }
    const checkModel = planModelRow(
      db,
      checkProvider.providerId,
      config,
      checkProvider.models,
      now,
      log,
    );
    const checkKv = planKv(db, checkProvider.providerId, config.model, log, {
      created: checkProvider.created,
    });
    const looksChanged =
      Boolean(checkProvider.created) ||
      Boolean(checkProvider.update) ||
      Boolean(checkModel.write) ||
      Boolean(checkKv.write);

    if (!looksChanged) {
      return {
        changed: false,
        providerId: checkProvider.providerId,
        model: config.model,
        created: false,
        reason: "unchanged",
      };
    }

    backupDatabase(db, dbPath, log);
    let result = null;
    await withBusyRetry(db, () => {
      // Plan again inside the write transaction: PI-Desktop may have changed
      // the same rows since the check above, and planning outside the lock
      // could write a stale kv or config_json snapshot back.
      const freshNow = Date.now();
      const providerPlan = planProvider(db, config, freshNow);
      if (providerPlan.error) {
        result = { changed: false, reason: providerPlan.error, model: config.model };
        return;
      }
      const modelPlan = planModelRow(
        db,
        providerPlan.providerId,
        config,
        providerPlan.models,
        freshNow,
        log,
      );
      const kvPlan = planKv(db, providerPlan.providerId, config.model, log, {
        created: providerPlan.created,
      });
      const changed =
        Boolean(providerPlan.created) ||
        Boolean(providerPlan.update) ||
        Boolean(modelPlan.write) ||
        Boolean(kvPlan.write);

      applyProvider(db, providerPlan);
      if (modelPlan.write) {
        try {
          applyModel(db, modelPlan.write);
        } catch (error) {
          logError(log, "models row not updated", error);
        }
      }
      if (kvPlan.write) {
        try {
          applyKv(db, kvPlan.write);
        } catch (error) {
          logError(log, "kv app/app not updated", error);
        }
      }

      result = {
        changed,
        providerId: providerPlan.providerId,
        model: config.model,
        created: Boolean(providerPlan.created),
        ...(changed ? {} : { reason: "unchanged" }),
      };
    }, retryDelays);

    return result ?? { changed: false, reason: "db-error", model: config.model };
  } catch (error) {
    logError(log, "sync failed", error);
    return {
      changed: false,
      reason: isBusyError(error) ? "db-busy" : "db-error",
      error: String(error?.message ?? error),
      model: config.model,
    };
  } finally {
    try {
      db?.close();
    } catch {
      // Closing a connection that failed to open must not mask the result.
    }
  }
}

let watcher = null;

function startWatcher() {
  if (process.env.PI_DESKTOP_SYNC_DISABLE === "1") return null;
  if (watcher) return watcher;

  const { dbPath, configPath } = resolvePaths();
  let lastHash = null;
  let lastMtime = null;
  let lastSize = null;
  let lastResult = null;
  let lastReason = null;
  let lastRunAt = 0;
  let running = false;

  const readState = () => {
    let stat;
    try {
      stat = fs.statSync(configPath);
    } catch {
      const changed = lastHash !== null;
      lastHash = null;
      lastMtime = null;
      lastSize = null;
      return { changed };
    }
    if (lastMtime !== null && stat.mtimeMs === lastMtime && stat.size === lastSize) {
      return { changed: false };
    }
    let raw;
    try {
      raw = fs.readFileSync(configPath);
    } catch {
      const changed = lastHash !== null;
      lastHash = null;
      lastMtime = null;
      lastSize = null;
      return { changed };
    }
    const hash = crypto.createHash("sha256").update(raw).digest("hex");
    const changed = hash !== lastHash;
    lastHash = hash;
    lastMtime = stat.mtimeMs;
    lastSize = stat.size;
    return { changed };
  };

  const run = async (force) => {
    if (running) return;
    running = true;
    try {
      const state = readState();
      const dbAppeared = lastResult?.reason === "no-db" && fs.existsSync(dbPath);
      const stale = Date.now() - lastRunAt >= HEARTBEAT_MS;
      if (!force && !state.changed && !dbAppeared && !stale) return;
      lastResult = await syncOnce({
        dbPath,
        configPath,
        log: (message) => console.error(`${LOG_PREFIX} ${message}`),
      });
      lastRunAt = Date.now();
      // Say why the watcher is idle once, not on every heartbeat.
      if (NOTABLE_REASONS.has(lastResult.reason)) {
        if (lastResult.reason !== lastReason) {
          logError(null, `sync skipped: ${lastResult.reason}`, lastResult.error);
        }
        lastReason = lastResult.reason;
      } else {
        lastReason = null;
      }
    } catch (error) {
      logError(null, "watcher sync failed", error);
    } finally {
      running = false;
    }
  };

  const initial = setTimeout(() => void run(true), INITIAL_SYNC_DELAY_MS);
  const interval = setInterval(() => void run(false), POLL_INTERVAL_MS);
  if (typeof initial?.unref === "function") initial.unref();
  if (typeof interval?.unref === "function") interval.unref();

  watcher = { initial, interval, run };
  return watcher;
}

function stopWatcher() {
  if (!watcher) return;
  clearTimeout(watcher.initial);
  clearInterval(watcher.interval);
  watcher = null;
}

try {
  startWatcher();
} catch (error) {
  logError(null, "watcher failed to start", error);
}

// The one plugin function magpie calls. The sync itself is driven by the
// watcher and does not need anything from the host.
export default async () => ({});

export const _internal = {
  syncOnce,
  startWatcher,
  stopWatcher,
  resolvePaths,
  defaultDataDir,
  readConfigFile,
  normalizeBaseUrl,
  mergeModels,
  canonicalize,
  isBusyError,
  isManagedProvider,
  withBusyRetry,
  backupDatabase,
  pruneBackups,
};
