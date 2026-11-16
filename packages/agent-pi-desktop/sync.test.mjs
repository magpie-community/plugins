// Run with: bun test
//
// Every case builds a fresh PI-Desktop-shaped database in a temp directory
// (fixture.mjs), so a real ~/.pi-desktop is never opened or changed.

import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeFixture } from "./fixture.mjs";

process.env.PI_DESKTOP_SYNC_DISABLE = "1";
const { _internal } = await import("./sync.mjs");
const syncOnce = _internal.syncOnce;

const DS_ID = "3620f314-6b1a-445f-8ff2-9ef4f4c7cd23";
const OLD_MODEL = "marvis/deepseek-v4-1-flash-261017 (防降级)";
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-pi-sync-"));
let caseNumber = 0;

const BASE_CONFIG = {
  model: "deepseek/deepseek-chat",
  baseUrl: "http://127.0.0.1:3425/v1",
  apiKey: "test-key-not-real",
  models: [
    { id: "deepseek/deepseek-chat", name: "DeepSeek Chat", context: 128000, output: 8192 },
    { id: "deepseek/deepseek-reasoner", name: "DeepSeek Reasoner", context: 65536, output: 8192 },
  ],
};

function makeCase(label) {
  caseNumber += 1;
  const dir = path.join(ROOT, `${String(caseNumber).padStart(2, "0")}-${label}`);
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "pi.sqlite");
  makeFixture(dbPath);
  return {
    dir,
    dbPath,
    configPath: path.join(dir, "magpie-agent.json"),
    backupDir: path.join(dir, "magpie-backups"),
  };
}

function writeConfig(configPath, config) {
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

function withDb(dbPath, fn) {
  const db = new Database(dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function readProvider(dbPath, id) {
  return withDb(dbPath, (db) => db.prepare("SELECT * FROM providers WHERE id = ?").get(id));
}

function readModel(dbPath, providerId, modelId) {
  return withDb(dbPath, (db) =>
    db.prepare("SELECT * FROM models WHERE provider_id = ? AND model_id = ?").get(providerId, modelId),
  );
}

function readKv(dbPath) {
  const row = withDb(dbPath, (db) =>
    db.prepare("SELECT value_json, updated_at FROM kv WHERE ns = 'app' AND key = 'app'").get(),
  );
  return { row, json: JSON.parse(row.value_json) };
}

function backupNames(c) {
  return fs
    .readdirSync(c.backupDir)
    .filter((name) => name.endsWith(".bak"))
    .sort();
}

afterAll(async () => {
  // Windows can hold a SQLite handle for a moment after close; retry, then
  // leave the temp directory rather than failing an otherwise green suite.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      fs.rmSync(ROOT, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
});

test("updates the existing ds provider and merges model metadata", async () => {
  const c = makeCase("existing");
  writeConfig(c.configPath, BASE_CONFIG);
  const before = readProvider(c.dbPath, DS_ID);
  const beforeKv = readKv(c.dbPath);

  const result = await syncOnce({ dbPath: c.dbPath, configPath: c.configPath });

  expect(result.changed).toBe(true);
  expect(result.created).toBe(false);
  expect(result.providerId).toBe(DS_ID);
  expect(result.model).toBe(BASE_CONFIG.model);

  const after = readProvider(c.dbPath, DS_ID);
  expect(after.default_model_id).toBe(BASE_CONFIG.model);
  expect(after.base_url).toBe(BASE_CONFIG.baseUrl);
  expect(after.vendor_key).toBe(before.vendor_key);
  expect(after.type).toBe(before.type);
  expect(after.protocol).toBe(before.protocol);
  expect(after.api_style).toBe(before.api_style);
  expect(after.auth_kind).toBe("api_key_and_base_url");
  expect(after.secret_ref).toBe(before.secret_ref);
  expect(after.enabled).toBe(1);
  expect(after.owner_plugin_id).toBeNull();
  expect(after.updated_at).toBeGreaterThan(before.updated_at);

  const models = JSON.parse(after.config_json).models;
  const ids = models.map((model) => model.id);
  expect(models[0].id).toBe(BASE_CONFIG.model);
  expect(ids).toContain(OLD_MODEL);
  expect(ids).toContain("deepseek/deepseek-chat");
  expect(ids).toContain("deepseek/deepseek-reasoner");
  expect(models.find((model) => model.id === OLD_MODEL)).toEqual(
    JSON.parse(before.config_json).models[0],
  );
  expect(models.find((model) => model.id === "deepseek/deepseek-chat")).toEqual({
    id: "deepseek/deepseek-chat",
    contextWindow: 128000,
    contextWindowSource: "catalog",
    maxTokens: 8192,
    maxTokensSource: "catalog",
    defaultThinkingLevel: null,
    thinkingLevels: [],
  });

  const modelRow = readModel(c.dbPath, DS_ID, "deepseek/deepseek-chat");
  expect(modelRow.display_name).toBe("DeepSeek Chat");
  expect(modelRow.source).toBe("user");
  expect(modelRow.capabilities_json).toBe("[]");
  expect(modelRow.context_window).toBe(128000);
  expect(modelRow.max_output_tokens).toBe(8192);
  expect(modelRow.deprecated).toBe(0);
  expect(modelRow.discovery_state).toBe("published");

  const afterKv = readKv(c.dbPath);
  expect(afterKv.json.defaultProviderId).toBe(DS_ID);
  expect(afterKv.json.defaultModelId).toBe(BASE_CONFIG.model);
  expect(afterKv.row.updated_at).toBe(beforeKv.row.updated_at);

  expect(
    withDb(c.dbPath, (db) => db.prepare("PRAGMA journal_mode").get().journal_mode),
  ).toBe("wal");
  expect(backupNames(c)).toHaveLength(1);

  // The backup is a usable snapshot of the database before the first write.
  const backupPath = path.join(c.backupDir, backupNames(c)[0]);
  const backupProvider = readProvider(backupPath, DS_ID);
  expect(backupProvider.default_model_id).toBe(OLD_MODEL);
  expect(JSON.parse(backupProvider.config_json).models.map((model) => model.id)).not.toContain(
    BASE_CONFIG.model,
  );
});

test("turns a disabled provider back on so the model picker lists it", async () => {
  const c = makeCase("disabled");
  withDb(c.dbPath, (db) =>
    db.prepare("UPDATE providers SET enabled = 0 WHERE id = ?").run(DS_ID),
  );
  writeConfig(c.configPath, BASE_CONFIG);

  const result = await syncOnce({ dbPath: c.dbPath, configPath: c.configPath });

  expect(result.changed).toBe(true);
  expect(readProvider(c.dbPath, DS_ID).enabled).toBe(1);
});

test("is idempotent: a second run writes nothing and takes no new backup", async () => {
  const c = makeCase("idempotent");
  writeConfig(c.configPath, BASE_CONFIG);
  const first = await syncOnce({ dbPath: c.dbPath, configPath: c.configPath });
  expect(first.changed).toBe(true);

  const providerBefore = readProvider(c.dbPath, DS_ID);
  const modelBefore = readModel(c.dbPath, DS_ID, BASE_CONFIG.model);
  const kvBefore = readKv(c.dbPath);
  const backupsBefore = backupNames(c);

  await new Promise((resolve) => setTimeout(resolve, 20));

  const second = await syncOnce({ dbPath: c.dbPath, configPath: c.configPath });
  expect(second.changed).toBe(false);
  expect(second.reason).toBe("unchanged");
  expect(second.providerId).toBe(DS_ID);
  expect(second.model).toBe(BASE_CONFIG.model);
  expect(second.created).toBe(false);

  expect(readProvider(c.dbPath, DS_ID)).toEqual(providerBefore);
  expect(readModel(c.dbPath, DS_ID, BASE_CONFIG.model)).toEqual(modelBefore);
  expect(readKv(c.dbPath)).toEqual(kvBefore);
  expect(backupNames(c)).toEqual(backupsBefore);
});

test("creates the fixed magpie-pi-desktop provider when no row is left", async () => {
  const c = makeCase("create");
  withDb(c.dbPath, (db) => {
    db.exec("DELETE FROM models");
    db.exec("DELETE FROM providers");
  });
  writeConfig(c.configPath, BASE_CONFIG);

  const result = await syncOnce({ dbPath: c.dbPath, configPath: c.configPath });

  expect(result.changed).toBe(true);
  expect(result.created).toBe(true);
  expect(result.providerId).toBe("magpie-pi-desktop");

  const row = readProvider(c.dbPath, "magpie-pi-desktop");
  expect(row.name).toBe("magpie");
  expect(row.vendor_key).toBe("custom");
  expect(row.type).toBe("openai_compatible");
  expect(row.protocol).toBe("openai_compatible");
  expect(row.api_style).toBe("chat_completions");
  expect(row.auth_kind).toBe("none");
  expect(row.base_url).toBe(BASE_CONFIG.baseUrl);
  expect(row.secret_ref).toBeNull();
  expect(row.enabled).toBe(1);
  expect(row.owner_plugin_id).toBeNull();
  expect(row.default_model_id).toBe(BASE_CONFIG.model);
  expect(typeof row.created_at).toBe("number");
  expect(row.updated_at).toBeGreaterThanOrEqual(row.created_at);
  expect(JSON.parse(row.config_json).models.map((model) => model.id)).toEqual([
    "deepseek/deepseek-chat",
    "deepseek/deepseek-reasoner",
  ]);

  const modelRow = readModel(c.dbPath, "magpie-pi-desktop", BASE_CONFIG.model);
  expect(modelRow.display_name).toBe("DeepSeek Chat");
  expect(modelRow.source).toBe("user");

  // The old app default points at the deleted ds row, so it is repointed at
  // ours; otherwise new sessions would fall back unpredictably.
  const kv = readKv(c.dbPath);
  expect(kv.json.defaultProviderId).toBe("magpie-pi-desktop");
  expect(kv.json.defaultModelId).toBe(BASE_CONFIG.model);
});

test("a newly created provider takes over a live third-party app default", async () => {
  const c = makeCase("create-takes-default");
  const gatewayConfig = { ...BASE_CONFIG, baseUrl: "http://127.0.0.1:3498/v1" };
  writeConfig(c.configPath, gatewayConfig);
  const dsBefore = readProvider(c.dbPath, DS_ID);
  const kvBefore = readKv(c.dbPath);
  expect(kvBefore.json.defaultProviderId).toBe(DS_ID);

  const result = await syncOnce({ dbPath: c.dbPath, configPath: c.configPath });

  expect(result.changed).toBe(true);
  expect(result.created).toBe(true);
  expect(result.providerId).toBe("magpie-pi-desktop");

  // The live ds provider is user-owned: only its own provider row matters,
  // and the sync must not rewrite it to get the selected model active.
  expect(readProvider(c.dbPath, DS_ID)).toEqual(dsBefore);

  // PI-Desktop's app default follows the first provider magpie creates,
  // otherwise a new session keeps the old model and the selection looks
  // like it did nothing. Other app keys and the app's stamp are preserved.
  const kvAfter = readKv(c.dbPath);
  expect(kvAfter.json.defaultProviderId).toBe("magpie-pi-desktop");
  expect(kvAfter.json.defaultModelId).toBe(gatewayConfig.model);
  expect(kvAfter.row.updated_at).toBe(kvBefore.row.updated_at);
  for (const key of Object.keys(kvBefore.json)) {
    if (key === "defaultProviderId" || key === "defaultModelId") continue;
    expect(kvAfter.json[key]).toEqual(kvBefore.json[key]);
  }

  // Taking the default over is a one-off for the creation; the next sync is
  // a no-op and must not fight a later default choice in PI-Desktop.
  const second = await syncOnce({ dbPath: c.dbPath, configPath: c.configPath });
  expect(second.changed).toBe(false);
  expect(second.reason).toBe("unchanged");
});

test("one syncOnce re-enables a disabled magpie-pi-desktop row immediately", async () => {
  const c = makeCase("reenable-fixed");
  withDb(c.dbPath, (db) => {
    db.exec("DELETE FROM models");
    db.exec("DELETE FROM providers");
  });
  writeConfig(c.configPath, BASE_CONFIG);
  const first = await syncOnce({ dbPath: c.dbPath, configPath: c.configPath });
  expect(first.created).toBe(true);
  const backupsAfterCreate = backupNames(c);
  expect(backupsAfterCreate).toHaveLength(1);

  withDb(c.dbPath, (db) =>
    db
      .prepare("UPDATE providers SET enabled = 0, updated_at = 7 WHERE id = ?")
      .run("magpie-pi-desktop"),
  );
  expect(readProvider(c.dbPath, "magpie-pi-desktop").enabled).toBe(0);

  // This is the same code the 10s watcher heartbeat calls; it must not need
  // a sidecar change or a long-lived host to put the row back.
  const second = await syncOnce({ dbPath: c.dbPath, configPath: c.configPath });
  expect(second.changed).toBe(true);
  expect(second.providerId).toBe("magpie-pi-desktop");
  const row = readProvider(c.dbPath, "magpie-pi-desktop");
  expect(row.enabled).toBe(1);
  expect(row.default_model_id).toBe(BASE_CONFIG.model);
  expect(JSON.parse(row.config_json).models[0].id).toBe(BASE_CONFIG.model);
  expect(row.updated_at).toBeGreaterThan(7);
  expect(backupNames(c)).toEqual(backupsAfterCreate);
});

test("does not adopt a user provider whose URL is only a prefix of the gateway", async () => {
  const c = makeCase("no-prefix-match");
  const gatewayConfig = { ...BASE_CONFIG, baseUrl: "http://127.0.0.1:3498/v1" };
  withDb(c.dbPath, (db) => {
    db.prepare(
      `INSERT INTO providers
         (id, name, vendor_key, type, protocol, api_style, auth_kind, base_url,
          enabled, secret_ref, default_model_id, config_json, created_at, updated_at,
          owner_plugin_id)
       VALUES (?, ?, 'custom', 'openai_compatible', 'openai_compatible',
               'chat_completions', 'api_key_and_base_url', ?, 0, ?, ?, ?, 1, 2, NULL)`,
    ).run(
      "user-prefix",
      "magpie",
      `${gatewayConfig.baseUrl}/extra`,
      "user-secret",
      "user/model",
      '{"models":[{"id":"user/model","name":"User Model"}],"userKey":true}',
    );
  });
  const before = readProvider(c.dbPath, "user-prefix");
  writeConfig(c.configPath, gatewayConfig);

  const result = await syncOnce({ dbPath: c.dbPath, configPath: c.configPath });

  expect(result.created).toBe(true);
  expect(result.providerId).toBe("magpie-pi-desktop");
  // The lookalike row (name "magpie", URL one path segment longer) is left
  // exactly as it was, including disabled and its secret reference.
  expect(readProvider(c.dbPath, "user-prefix")).toEqual(before);
  // Only the newly created magpie provider becomes the app default.
  expect(readKv(c.dbPath).json.defaultProviderId).toBe("magpie-pi-desktop");
});

test("suffixes the fixed provider id when a foreign row already owns it", async () => {
  const c = makeCase("provider-id-conflict");
  withDb(c.dbPath, (db) => {
    db.exec("DELETE FROM models");
    db.exec("DELETE FROM providers");
    db.prepare(
      `INSERT INTO providers
         (id, name, vendor_key, type, protocol, api_style, auth_kind, base_url,
          enabled, secret_ref, default_model_id, config_json, created_at, updated_at,
          owner_plugin_id)
       VALUES ('magpie-pi-desktop', 'Not ours', 'custom', 'openai_compatible',
               'openai_compatible', 'chat_completions', 'api_key_and_base_url',
               'https://example.invalid/v1', 1, NULL, 'other-model', '{}', 1, 2, NULL)`,
    ).run();
  });
  writeConfig(c.configPath, BASE_CONFIG);

  const result = await syncOnce({ dbPath: c.dbPath, configPath: c.configPath });

  expect(result.changed).toBe(true);
  expect(result.created).toBe(true);
  expect(result.providerId).toBe("magpie-pi-desktop-2");
  expect(readProvider(c.dbPath, "magpie-pi-desktop").name).toBe("Not ours");
  expect(readProvider(c.dbPath, "magpie-pi-desktop-2").name).toBe("magpie");
});

test("reuses the plugin-owned fixed id and refreshes its base URL", async () => {
  const c = makeCase("provider-id-reuse");
  withDb(c.dbPath, (db) => {
    db.exec("DELETE FROM models");
    db.exec("DELETE FROM providers");
    db.prepare(
      `INSERT INTO providers
         (id, name, vendor_key, type, protocol, api_style, auth_kind, base_url,
          enabled, secret_ref, default_model_id, config_json, created_at, updated_at,
          owner_plugin_id)
       VALUES ('magpie-pi-desktop', 'old-magpie', 'custom', 'openai_compatible',
               'openai_compatible', 'chat_completions', 'none',
               'http://127.0.0.1:9999/v1', 1, NULL, 'stale-model', '{}', 1, 2,
               'magpie-agent')`,
    ).run();
  });
  writeConfig(c.configPath, BASE_CONFIG);

  const result = await syncOnce({ dbPath: c.dbPath, configPath: c.configPath });

  expect(result.changed).toBe(true);
  expect(result.created).toBe(false);
  expect(result.providerId).toBe("magpie-pi-desktop");
  const row = readProvider(c.dbPath, "magpie-pi-desktop");
  expect(row.base_url).toBe(BASE_CONFIG.baseUrl);
  expect(row.default_model_id).toBe(BASE_CONFIG.model);
  // The legacy owner marker is cleared so PI-Desktop will not delete the row.
  expect(row.owner_plugin_id).toBeNull();

  const second = await syncOnce({ dbPath: c.dbPath, configPath: c.configPath });
  expect(second.changed).toBe(false);
  expect(second.providerId).toBe("magpie-pi-desktop");
});

test("returns a reason for missing or invalid inputs instead of throwing", async () => {
  const c = makeCase("reasons");

  const noConfig = await syncOnce({
    dbPath: c.dbPath,
    configPath: path.join(c.dir, "missing.json"),
  });
  expect(noConfig).toEqual({ changed: false, reason: "no-config" });

  fs.writeFileSync(c.configPath, "{ not json");
  const invalid = await syncOnce({ dbPath: c.dbPath, configPath: c.configPath });
  expect(invalid).toEqual({ changed: false, reason: "invalid-config" });

  writeConfig(c.configPath, { baseUrl: BASE_CONFIG.baseUrl, models: BASE_CONFIG.models });
  const noModel = await syncOnce({ dbPath: c.dbPath, configPath: c.configPath });
  expect(noModel).toEqual({ changed: false, reason: "no-model" });

  writeConfig(c.configPath, { ...BASE_CONFIG, baseUrl: "not a URL" });
  const badBaseUrl = await syncOnce({ dbPath: c.dbPath, configPath: c.configPath });
  expect(badBaseUrl).toEqual({ changed: false, reason: "invalid-base-url" });

  writeConfig(c.configPath, BASE_CONFIG);
  const missingDbPath = path.join(c.dir, "missing.sqlite");
  const noDb = await syncOnce({ dbPath: missingDbPath, configPath: c.configPath });
  expect(noDb.changed).toBe(false);
  expect(noDb.reason).toBe("no-db");
  expect(noDb.model).toBe(BASE_CONFIG.model);
  expect(fs.existsSync(missingDbPath)).toBe(false);
  expect(fs.existsSync(c.backupDir)).toBe(false);
});

test("moves kv.app.defaultModelId for our provider and keeps other keys and its stamp", async () => {
  const c = makeCase("kv-follow");
  const original = readKv(c.dbPath);
  expect(original.json.defaultProviderId).toBe(DS_ID);
  const edited = { ...original.json, defaultModelId: "old/model" };
  withDb(c.dbPath, (db) =>
    db
      .prepare("UPDATE kv SET value_json = ? WHERE ns = 'app' AND key = 'app'")
      .run(JSON.stringify(edited)),
  );
  writeConfig(c.configPath, { ...BASE_CONFIG, model: "deepseek/deepseek-reasoner" });

  const result = await syncOnce({ dbPath: c.dbPath, configPath: c.configPath });
  expect(result.changed).toBe(true);

  const after = readKv(c.dbPath);
  expect(after.json.defaultModelId).toBe("deepseek/deepseek-reasoner");
  expect(after.json.defaultProviderId).toBe(DS_ID);
  expect(after.row.updated_at).toBe(original.row.updated_at);
  for (const key of Object.keys(original.json)) {
    if (key === "defaultModelId") continue;
    expect(after.json[key]).toEqual(original.json[key]);
  }
});

test("honours config.providerId and leaves another provider's kv default alone", async () => {
  const c = makeCase("provider-id");
  withDb(c.dbPath, (db) => {
    db.prepare(
      `INSERT INTO providers
         (id, name, vendor_key, type, protocol, api_style, auth_kind, base_url,
          enabled, secret_ref, default_model_id, config_json, created_at, updated_at,
          owner_plugin_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "other-provider",
      "Other",
      "custom",
      "openai_compatible",
      "openai_compatible",
      "chat_completions",
      "api_key_and_base_url",
      "https://example.invalid/v1",
      1,
      null,
      "other-model",
      "{}",
      1,
      2,
      null,
    );
  });
  const original = readKv(c.dbPath);
  const edited = {
    ...original.json,
    defaultProviderId: "other-provider",
    defaultModelId: "other/model",
  };
  withDb(c.dbPath, (db) =>
    db
      .prepare("UPDATE kv SET value_json = ? WHERE ns = 'app' AND key = 'app'")
      .run(JSON.stringify(edited)),
  );
  writeConfig(c.configPath, { ...BASE_CONFIG, providerId: DS_ID });

  const result = await syncOnce({ dbPath: c.dbPath, configPath: c.configPath });
  expect(result.changed).toBe(true);
  expect(result.providerId).toBe(DS_ID);
  expect(readProvider(c.dbPath, DS_ID).default_model_id).toBe(BASE_CONFIG.model);

  const after = readKv(c.dbPath);
  expect(after.json.defaultProviderId).toBe("other-provider");
  expect(after.json.defaultModelId).toBe("other/model");
  expect(after.row.updated_at).toBe(original.row.updated_at);
});

test("leaves unrelated providers, model rows and kv keys untouched", async () => {
  const c = makeCase("unrelated");
  withDb(c.dbPath, (db) => {
    db.prepare(
      `INSERT INTO providers
         (id, name, vendor_key, type, protocol, api_style, auth_kind, base_url,
          enabled, secret_ref, default_model_id, config_json, created_at, updated_at,
          owner_plugin_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "other-provider",
      "Other",
      "custom",
      "openai_compatible",
      "openai_compatible",
      "chat_completions",
      "api_key_and_base_url",
      "https://example.invalid/v1",
      1,
      null,
      "other-model",
      "{}",
      1,
      2,
      null,
    );
    db.prepare(
      `INSERT INTO models
         (provider_id, model_id, display_name, source, capabilities_json,
          context_window, max_output_tokens, deprecated, updated_at, discovery_state)
       VALUES (?, ?, ?, 'user', '[]', ?, ?, 0, ?, 'published')`,
    ).run("other-provider", "other-model", "Other Model", 1000, 100, 2);
  });

  const providersBefore = withDb(c.dbPath, (db) =>
    db.prepare("SELECT * FROM providers ORDER BY id").all(),
  );
  const modelsBefore = withDb(c.dbPath, (db) =>
    db.prepare("SELECT * FROM models ORDER BY provider_id, model_id").all(),
  );
  const kvBefore = withDb(c.dbPath, (db) => db.prepare("SELECT * FROM kv ORDER BY ns, key").all());

  writeConfig(c.configPath, BASE_CONFIG);
  const result = await syncOnce({ dbPath: c.dbPath, configPath: c.configPath });
  expect(result.changed).toBe(true);

  const providersAfter = withDb(c.dbPath, (db) =>
    db.prepare("SELECT * FROM providers ORDER BY id").all(),
  );
  expect(providersAfter.filter((row) => row.id !== DS_ID)).toEqual(
    providersBefore.filter((row) => row.id !== DS_ID),
  );

  const modelsAfter = withDb(c.dbPath, (db) =>
    db.prepare("SELECT * FROM models ORDER BY provider_id, model_id").all(),
  );
  const unrelatedModels = (rows) =>
    rows.filter((row) => !(row.provider_id === DS_ID && row.model_id === BASE_CONFIG.model));
  expect(unrelatedModels(modelsAfter)).toEqual(unrelatedModels(modelsBefore));

  const kvAfter = withDb(c.dbPath, (db) =>
    db.prepare("SELECT * FROM kv ORDER BY ns, key").all(),
  );
  for (const row of kvBefore) {
    if (row.ns === "app" && row.key === "app") continue;
    expect(kvAfter.find((candidate) => candidate.ns === row.ns && candidate.key === row.key)).toEqual(
      row,
    );
  }
  const appBefore = JSON.parse(
    kvBefore.find((row) => row.ns === "app" && row.key === "app").value_json,
  );
  const appAfter = JSON.parse(
    kvAfter.find((row) => row.ns === "app" && row.key === "app").value_json,
  );
  for (const key of Object.keys(appBefore)) {
    if (key === "defaultModelId") continue;
    expect(appAfter[key]).toEqual(appBefore[key]);
  }
  expect(appAfter.defaultModelId).toBe(BASE_CONFIG.model);
});

test("uses the sidecar modelName when models[] has no name", async () => {
  const c = makeCase("model-name");
  writeConfig(c.configPath, {
    model: "deepseek/deepseek-chat",
    modelName: "Chat From Sidecar",
    baseUrl: BASE_CONFIG.baseUrl,
    apiKey: "test-key-not-real",
    models: [{ id: "deepseek/deepseek-chat", context: 32000, output: 4096 }],
  });

  const result = await syncOnce({ dbPath: c.dbPath, configPath: c.configPath });
  expect(result.changed).toBe(true);

  const row = readModel(c.dbPath, DS_ID, "deepseek/deepseek-chat");
  expect(row.display_name).toBe("Chat From Sidecar");
  expect(row.context_window).toBe(32000);
  expect(row.max_output_tokens).toBe(4096);
});

test("keeps at most ten timestamped backups", async () => {
  const c = makeCase("backup-retention");
  fs.mkdirSync(c.backupDir, { recursive: true });
  const oldNames = [];
  for (let index = 0; index < 12; index += 1) {
    const name = `pi.sqlite.20200101-${String(index).padStart(6, "0")}.bak`;
    fs.writeFileSync(path.join(c.backupDir, name), "old");
    oldNames.push(name);
  }

  writeConfig(c.configPath, BASE_CONFIG);
  const result = await syncOnce({ dbPath: c.dbPath, configPath: c.configPath });
  expect(result.changed).toBe(true);

  const backups = backupNames(c);
  expect(backups).toHaveLength(10);
  expect(backups).not.toContain(oldNames[0]);
  expect(backups).not.toContain(oldNames[1]);
  expect(backups).not.toContain(oldNames[2]);
});

test("normalizes loopback base URLs when matching", async () => {
  const c = makeCase("loopback-normalize");
  withDb(c.dbPath, (db) =>
    db
      .prepare("UPDATE providers SET base_url = ? WHERE id = ?")
      .run("http://localhost:3425/v1/", DS_ID),
  );
  writeConfig(c.configPath, BASE_CONFIG);

  const result = await syncOnce({ dbPath: c.dbPath, configPath: c.configPath });

  expect(result.changed).toBe(true);
  expect(result.created).toBe(false);
  expect(result.providerId).toBe(DS_ID);
  expect(readProvider(c.dbPath, DS_ID).default_model_id).toBe(BASE_CONFIG.model);
});

test("does not adopt a provider by name or by a loopback prefix", async () => {
  const c = makeCase("no-fuzzy-match");
  withDb(c.dbPath, (db) => {
    db.exec("DELETE FROM models");
    db.exec("DELETE FROM providers");
    db.prepare(
      `INSERT INTO providers
         (id, name, vendor_key, type, protocol, api_style, auth_kind, base_url,
          enabled, secret_ref, default_model_id, config_json, created_at, updated_at,
          owner_plugin_id)
       VALUES (?, ?, 'custom', 'openai_compatible', 'openai_compatible',
               'chat_completions', 'api_key_and_base_url', ?, 1, ?, ?, ?, 1, 2, NULL)`,
    ).run(
      "user-loopback",
      "ds",
      "http://127.0.0.1:34250/v1",
      "keep-secret",
      "user/model",
      '{"models":[{"id":"user/model","name":"User Model"}],"userKey":true}',
    );
    db.prepare(
      `INSERT INTO providers
         (id, name, vendor_key, type, protocol, api_style, auth_kind, base_url,
          enabled, secret_ref, default_model_id, config_json, created_at, updated_at,
          owner_plugin_id)
       VALUES (?, ?, 'custom', 'openai_compatible', 'openai_compatible',
               'chat_completions', 'none', ?, 0, NULL, ?, '{}', 1, 2, NULL)`,
    ).run("user-off", "Other", "https://example.invalid/v1", "other-model");
  });
  const before = withDb(c.dbPath, (db) =>
    db.prepare("SELECT * FROM providers ORDER BY id").all(),
  );
  writeConfig(c.configPath, BASE_CONFIG);

  const result = await syncOnce({ dbPath: c.dbPath, configPath: c.configPath });

  expect(result.changed).toBe(true);
  expect(result.created).toBe(true);
  expect(result.providerId).toBe("magpie-pi-desktop");
  const after = withDb(c.dbPath, (db) =>
    db.prepare("SELECT * FROM providers ORDER BY id").all(),
  );
  expect(after.filter((row) => row.id !== "magpie-pi-desktop")).toEqual(before);
  expect(after.find((row) => row.id === "user-loopback")).toEqual(
    before.find((row) => row.id === "user-loopback"),
  );
  expect(after.find((row) => row.id === "user-off").enabled).toBe(0);
});

test("honours an explicit providerId without rewriting a user row's base URL", async () => {
  const c = makeCase("explicit-provider-id");
  withDb(c.dbPath, (db) => {
    db.exec("DELETE FROM models");
    db.exec("DELETE FROM providers");
    db.prepare(
      `INSERT INTO providers
         (id, name, vendor_key, type, protocol, api_style, auth_kind, base_url,
          enabled, secret_ref, default_model_id, config_json, created_at, updated_at,
          owner_plugin_id)
       VALUES (?, ?, 'custom', 'openai_compatible', 'openai_compatible',
               'chat_completions', 'api_key_and_base_url', ?, 0, ?, ?, ?, 1, 2, NULL)`,
    ).run(
      "other-provider",
      "Other",
      "https://example.invalid/v1",
      "user-secret",
      "other-model",
      '{"models":[{"id":"other-model","name":"Other Model"}],"customKey":"keep"}',
    );
  });
  writeConfig(c.configPath, { ...BASE_CONFIG, providerId: "other-provider" });

  const result = await syncOnce({ dbPath: c.dbPath, configPath: c.configPath });

  expect(result.changed).toBe(true);
  expect(result.providerId).toBe("other-provider");
  const row = readProvider(c.dbPath, "other-provider");
  expect(row.base_url).toBe("https://example.invalid/v1");
  expect(row.auth_kind).toBe("api_key_and_base_url");
  expect(row.secret_ref).toBe("user-secret");
  expect(row.enabled).toBe(1);
  expect(row.default_model_id).toBe(BASE_CONFIG.model);
  const config = JSON.parse(row.config_json);
  expect(config.customKey).toBe("keep");
  expect(config.models[0].id).toBe(BASE_CONFIG.model);
  expect(config.models.some((model) => model.id === "other-model")).toBe(true);
});

test("preserves models table columns and keeps the selected model first", async () => {
  const c = makeCase("model-columns-order");
  withDb(c.dbPath, (db) => {
    db.prepare(
      `INSERT INTO models
         (provider_id, model_id, display_name, source, capabilities_json,
          context_window, max_output_tokens, deprecated, updated_at, discovery_state)
       VALUES (?, ?, ?, 'discovered', '["vision"]', 1000, 100, 1, 5, 'unlisted')`,
    ).run(DS_ID, "deepseek/deepseek-chat", "Old Name");
  });
  writeConfig(c.configPath, {
    model: "deepseek/deepseek-chat",
    baseUrl: BASE_CONFIG.baseUrl,
    models: [
      { id: "deepseek/deepseek-reasoner", name: "Reasoner", context: 65536, output: 8192 },
      { id: "deepseek/deepseek-chat", name: "Chat" },
    ],
  });

  const result = await syncOnce({ dbPath: c.dbPath, configPath: c.configPath });
  expect(result.changed).toBe(true);

  const merged = JSON.parse(readProvider(c.dbPath, DS_ID).config_json).models;
  expect(merged[0].id).toBe("deepseek/deepseek-chat");
  expect(merged.slice(1).map((model) => model.id)).toEqual([
    OLD_MODEL,
    "deepseek/deepseek-reasoner",
  ]);
  expect(merged.find((model) => model.id === "deepseek/deepseek-reasoner").contextWindow).toBe(
    65536,
  );

  const row = readModel(c.dbPath, DS_ID, "deepseek/deepseek-chat");
  expect(row.display_name).toBe("Chat");
  expect(row.source).toBe("user");
  // Columns the sync has no value for survive the upsert.
  expect(row.capabilities_json).toBe('["vision"]');
  expect(row.context_window).toBe(1000);
  expect(row.max_output_tokens).toBe(100);
  expect(row.deprecated).toBe(1);
  expect(row.discovery_state).toBe("unlisted");
  expect(row.updated_at).toBeGreaterThan(5);
});

test("refuses to overwrite a user provider's unparseable config_json", async () => {
  const c = makeCase("invalid-provider-config");
  withDb(c.dbPath, (db) => {
    db.exec("DELETE FROM models");
    db.exec("DELETE FROM providers");
    db.prepare(
      `INSERT INTO providers
         (id, name, vendor_key, type, protocol, api_style, auth_kind, base_url,
          enabled, secret_ref, default_model_id, config_json, created_at, updated_at,
          owner_plugin_id)
       VALUES (?, ?, 'custom', 'openai_compatible', 'openai_compatible',
               'chat_completions', 'api_key_and_base_url', ?, 1, ?, ?, ?, 1, 2, NULL)`,
    ).run(
      "user-bad-config",
      "Bad Config",
      BASE_CONFIG.baseUrl,
      "user-secret",
      "old/model",
      "{ not json",
    );
  });
  writeConfig(c.configPath, BASE_CONFIG);

  const result = await syncOnce({ dbPath: c.dbPath, configPath: c.configPath });

  expect(result).toEqual({
    changed: false,
    reason: "invalid-provider-config",
    model: BASE_CONFIG.model,
  });
  expect(readProvider(c.dbPath, "user-bad-config").config_json).toBe("{ not json");
  expect(readProvider(c.dbPath, "user-bad-config").default_model_id).toBe("old/model");
});

test("reports a corrupt database instead of throwing", async () => {
  const c = makeCase("corrupt-db");
  fs.writeFileSync(c.dbPath, "this is not a sqlite database");
  writeConfig(c.configPath, BASE_CONFIG);

  const result = await syncOnce({
    dbPath: c.dbPath,
    configPath: c.configPath,
    log: () => {},
  });

  expect(result.changed).toBe(false);
  expect(["db-error", "db-busy"]).toContain(result.reason);
  expect(typeof result.error).toBe("string");
  expect(result.model).toBe(BASE_CONFIG.model);
});

test("reports db-busy while another connection holds the write lock, then succeeds", async () => {
  const c = makeCase("busy");
  writeConfig(c.configPath, BASE_CONFIG);
  const holder = new Database(c.dbPath);
  holder.exec("PRAGMA busy_timeout = 0");
  holder.exec("BEGIN IMMEDIATE");
  try {
    const busy = await syncOnce({
      dbPath: c.dbPath,
      configPath: c.configPath,
      busyTimeoutMs: 20,
      busyRetryDelays: [5, 5],
      log: () => {},
    });
    expect(busy.changed).toBe(false);
    expect(busy.reason).toBe("db-busy");
  } finally {
    holder.exec("ROLLBACK");
    holder.close();
  }

  const retry = await syncOnce({ dbPath: c.dbPath, configPath: c.configPath });
  expect(retry.changed).toBe(true);
  expect(readProvider(c.dbPath, DS_ID).default_model_id).toBe(BASE_CONFIG.model);
});

test("withBusyRetry retries a transient SQLITE_BUSY", async () => {
  const statements = [];
  let begins = 0;
  let writes = 0;
  const fakeDb = {
    exec(sql) {
      statements.push(sql);
      if (sql !== "BEGIN IMMEDIATE") return;
      begins += 1;
      if (begins === 1) {
        const error = new Error("database is locked");
        error.code = "SQLITE_BUSY";
        throw error;
      }
    },
  };

  await _internal.withBusyRetry(
    fakeDb,
    () => {
      writes += 1;
    },
    [1],
  );

  expect(begins).toBe(2);
  expect(writes).toBe(1);
  expect(statements).toContain("COMMIT");
});

test("never logs the sidecar apiKey", async () => {
  const apiKey = "sk-live-DO-NOT-LOG-123456";
  const c = makeCase("no-key-log");
  writeConfig(c.configPath, { ...BASE_CONFIG, apiKey });
  const messages = [];
  const result = await syncOnce({
    dbPath: c.dbPath,
    configPath: c.configPath,
    log: (message) => messages.push(String(message)),
  });
  expect(result.changed).toBe(true);
  expect(messages.join("\n")).not.toContain(apiKey);

  const broken = makeCase("no-key-log-error");
  fs.writeFileSync(broken.dbPath, "not a database");
  writeConfig(broken.configPath, { ...BASE_CONFIG, apiKey });
  const errorMessages = [];
  const failed = await syncOnce({
    dbPath: broken.dbPath,
    configPath: broken.configPath,
    log: (message) => errorMessages.push(String(message)),
  });
  expect(failed.changed).toBe(false);
  expect(errorMessages.join("\n")).not.toContain(apiKey);
});

test("resolvePaths follows PI-Desktop's data-dir rules", () => {
  const saved = {
    dataDir: process.env.PI_DESKTOP_DATA_DIR,
    dev: process.env.PI_DESKTOP_DEV,
    db: process.env.PI_DESKTOP_DB,
    config: process.env.PI_DESKTOP_AGENT_CONFIG,
  };
  const restore = (key, value) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  try {
    delete process.env.PI_DESKTOP_DB;
    delete process.env.PI_DESKTOP_AGENT_CONFIG;
    delete process.env.PI_DESKTOP_DATA_DIR;
    delete process.env.PI_DESKTOP_DEV;
    expect(_internal.resolvePaths().dbPath).toBe(
      path.join(os.homedir(), ".pi-desktop", "pi.sqlite"),
    );

    process.env.PI_DESKTOP_DEV = "1";
    expect(_internal.resolvePaths().dbPath).toBe(
      path.join(os.homedir(), ".pi-desktop-dev", "pi.sqlite"),
    );

    const explicit = path.join(os.tmpdir(), "pi-data-explicit");
    process.env.PI_DESKTOP_DATA_DIR = explicit;
    const paths = _internal.resolvePaths();
    expect(paths.dbPath).toBe(path.join(explicit, "pi.sqlite"));
    // The sidecar stays where the agent descriptor tells magpie to write it.
    expect(paths.configPath).toBe(
      path.join(os.homedir(), ".pi-desktop", "magpie-agent.json"),
    );
  } finally {
    restore("PI_DESKTOP_DATA_DIR", saved.dataDir);
    restore("PI_DESKTOP_DEV", saved.dev);
    restore("PI_DESKTOP_DB", saved.db);
    restore("PI_DESKTOP_AGENT_CONFIG", saved.config);
  }
});

test("repoints a stale defaultProviderId from this plugin's namespace", async () => {
  const c = makeCase("kv-suffix");
  withDb(c.dbPath, (db) => {
    db.exec("DELETE FROM models");
    db.exec("DELETE FROM providers");
    db.prepare(
      `INSERT INTO providers
         (id, name, vendor_key, type, protocol, api_style, auth_kind, base_url,
          enabled, secret_ref, default_model_id, config_json, created_at, updated_at,
          owner_plugin_id)
       VALUES ('magpie-pi-desktop', 'magpie', 'custom', 'openai_compatible',
               'openai_compatible', 'chat_completions', 'none', ?, 1, NULL,
               'old/model', '{}', 1, 2, NULL)`,
    ).run(BASE_CONFIG.baseUrl);
    db.prepare(
      `INSERT INTO providers
         (id, name, vendor_key, type, protocol, api_style, auth_kind, base_url,
          enabled, secret_ref, default_model_id, config_json, created_at, updated_at,
          owner_plugin_id)
       VALUES ('magpie-pi-desktop-2', 'magpie', 'custom', 'openai_compatible',
               'openai_compatible', 'chat_completions', 'none',
               'http://127.0.0.1:9999/v1', 1, NULL, 'older/model', '{}', 1, 2, NULL)`,
    ).run();
    db.prepare(
      "UPDATE kv SET value_json = ? WHERE ns = 'app' AND key = 'app'",
    ).run(
      JSON.stringify({
        defaultProviderId: "magpie-pi-desktop-2",
        defaultModelId: "older/model",
      }),
    );
  });
  writeConfig(c.configPath, BASE_CONFIG);

  const result = await syncOnce({ dbPath: c.dbPath, configPath: c.configPath });

  expect(result.changed).toBe(true);
  expect(result.providerId).toBe("magpie-pi-desktop");
  expect(readKv(c.dbPath).json.defaultProviderId).toBe("magpie-pi-desktop");
  expect(readKv(c.dbPath).json.defaultModelId).toBe(BASE_CONFIG.model);
});
