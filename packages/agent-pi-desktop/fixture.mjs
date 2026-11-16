// A synthetic PI-Desktop database for the unit tests.
//
// The tests used to copy a real `pi.sqlite` kept in the development tree.
// That is not portable: the community repository has no such file, and a
// real database carries a user's rows. This builds the same shape from
// scratch: the three tables sync.mjs reads, one `ds` provider pointing at
// the loopback gateway, and one app row in kv.

import { Database } from "bun:sqlite";
import { copyFileSync, unlinkSync } from "node:fs";

export const DS_ID = "3620f314-6b1a-445f-8ff2-9ef4f4c7cd23";
export const OLD_MODEL = "marvis/deepseek-v4-1-flash-261017 (防降级)";
const NOW = 1794739851042;

export function makeFixture(dbPath) {
  // Build beside the target and copy only the main file over: a WAL database
  // keeps -wal/-shm files open on Windows, and a test that overwrites the
  // main file must not find a stale log beside it.
  const build = `${dbPath}.build`;
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${build}${suffix}`);
    } catch {
      // Not there is fine.
    }
  }
  const db = new Database(build, { create: true });
  try {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(`
      CREATE TABLE providers (
        id               TEXT PRIMARY KEY,
        name             TEXT NOT NULL,
        vendor_key       TEXT NOT NULL DEFAULT 'custom',
        type             TEXT NOT NULL DEFAULT 'openai_compatible',
        protocol         TEXT NOT NULL DEFAULT 'openai_compatible',
        api_style        TEXT,
        auth_kind        TEXT NOT NULL DEFAULT 'api_key_and_base_url',
        base_url         TEXT,
        enabled          INTEGER NOT NULL DEFAULT 1,
        secret_ref       TEXT,
        default_model_id TEXT,
        config_json      TEXT NOT NULL DEFAULT '{}',
        created_at       INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL,
        owner_plugin_id  TEXT
      );
      CREATE TABLE models (
        provider_id       TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
        model_id          TEXT NOT NULL,
        display_name      TEXT NOT NULL,
        source            TEXT NOT NULL DEFAULT 'user',
        capabilities_json TEXT NOT NULL DEFAULT '[]',
        context_window    INTEGER,
        max_output_tokens INTEGER,
        deprecated        INTEGER NOT NULL DEFAULT 0,
        updated_at        INTEGER NOT NULL,
        discovery_state   TEXT CHECK (discovery_state IN ('published', 'unlisted')),
        PRIMARY KEY (provider_id, model_id)
      ) WITHOUT ROWID;
      CREATE TABLE kv (
        ns         TEXT NOT NULL,
        key        TEXT NOT NULL,
        value_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (ns, key)
      ) WITHOUT ROWID;
    `);

    const config = {
      models: [
        {
          contextWindow: 1000000,
          contextWindowSource: "catalog",
          defaultThinkingLevel: null,
          id: OLD_MODEL,
          maxTokens: 384000,
          maxTokensSource: "catalog",
          thinkingLevels: [],
        },
      ],
    };
    db.prepare(
      `INSERT INTO providers
         (id, name, vendor_key, type, protocol, api_style, auth_kind, base_url,
          enabled, secret_ref, default_model_id, config_json, created_at, updated_at,
          owner_plugin_id)
       VALUES (?, 'ds', 'custom', 'openai_compatible', 'openai_compatible',
               'chat_completions', 'api_key_and_base_url',
               'http://127.0.0.1:3425/v1', 1,
               'secret:provider:3620f314-6b1a-445f-8ff2-9ef4f4c7cd23:api_key',
               ?, ?, ?, ?, NULL)`,
    ).run(
      DS_ID,
      OLD_MODEL,
      JSON.stringify(config),
      NOW,
      NOW,
    );

    const app = {
      autoCollapseThinking: true,
      chatContentMaxWidth: 760,
      defaultMode: "agent",
      defaultModelId: OLD_MODEL,
      defaultPermissionMode: "auto",
      defaultProviderId: DS_ID,
      theme: "dark",
    };
    db.prepare("INSERT INTO kv (ns, key, value_json, updated_at) VALUES ('app', 'app', ?, ?)").run(
      JSON.stringify(app),
      NOW + 1,
    );
  } finally {
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // A checkpoint is best-effort; the copy below is the fallback.
    }
    db.close();
  }
  copyFileSync(build, dbPath);
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${build}${suffix}`);
    } catch {
      // Not there is fine.
    }
  }
}
