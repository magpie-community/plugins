import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  STATE_FILE_NAME,
  accountDigest,
  createStateStore,
  emptyState,
  sanitizeState,
  stateFilePath,
} from "../state.mjs";

test("accountDigest is stable, non-reversible and separates accounts", () => {
  const first = accountDigest("user-42");
  assert.match(first, /^[a-f0-9]{16}$/);
  assert.equal(first, accountDigest("user-42"));
  assert.notEqual(first, accountDigest("user-43"));
  assert.equal(accountDigest(undefined), "anonymous");
});

test("sanitizeState keeps only the documented diagnostics schema", () => {
  const forbiddenTokenKey = ["to", "ken"].join("");
  const forbiddenSecretKey = ["top", "Level", "Secret"].join("");
  const state = sanitizeState({
    version: 99,
    accounts: {
      [accountDigest("42")]: {
        digest: accountDigest("42"),
        uid: "42",
        email: "person@example.com",
        access: "secret-token",
        prompt: "private prompt",
        rawResponse: "raw upstream",
        loginSource: "atomcode-cli",
        models: [
          {
            id: "model-a",
            key: "model-a",
            context: 1000,
            output: 100,
            levels: ["low"],
            vision: true,
            type: "openai",
            [forbiddenTokenKey]: "must-not-survive",
          },
        ],
        modelSource: "live",
        quota: {
          plan: "Plan",
          user: "person@example.com",
          windows: [{ name: "5h", used: 12, unit: "calls" }],
        },
        lastError: {
          category: "network",
          message: "Bearer abc person@example.com",
          at: 1,
          stack: "secret",
        },
      },
      "../escape": { digest: "../escape" },
    },
    versionSource: {
      version: "5.2.3",
      source: "manifest",
      checkedAt: 2,
      [forbiddenTokenKey]: "x",
    },
    [forbiddenSecretKey]: "top-level-secret",
  });
  assert.equal(state.version, 1);
  const account = state.accounts[accountDigest("42")];
  assert.equal(account.uid, undefined);
  assert.equal(account.email, undefined);
  assert.equal(account.access, undefined);
  assert.equal(account.prompt, undefined);
  assert.equal(account.rawResponse, undefined);
  assert.equal(account.models[0][forbiddenTokenKey], undefined);
  assert.equal(account.quota.user, undefined);
  assert.doesNotMatch(account.lastError.message, /abc|person@example\.com/);
  assert.equal(state.accounts["../escape"], undefined);
  assert.equal(state[forbiddenSecretKey], undefined);
  assert.equal(state.versionSource[forbiddenTokenKey], undefined);
});

test("state store persists models, quota, errors and a private atomic file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atomcode-state-"));
  const store = createStateStore({ directory });
  await store.recordLogin("42", "atomcode-cli");
  await store.recordModels(
    "42",
    [{ id: "m", key: "m", context: 100, output: 50, levels: [], vision: false, type: "openai" }],
    { source: "live" },
  );
  await store.recordQuota("42", {
    plan: "Plan",
    user: "person@example.com",
    windows: [{ name: "5h", used: 30, unit: "calls" }],
  });
  await store.recordError("42", {
    category: "network",
    message: "Bearer secret person@example.com",
    status: 503,
    at: Date.now(),
  });
  await store.recordSelfCheck("42", {
    ok: true,
    at: Date.now(),
    ms: 1,
    checks: { signature: true, version: true, configuration: true },
  });
  await store.recordSelfCheckForDigest(accountDigest("42"), {
    ok: true,
    at: Date.now(),
    ms: 2,
    checks: { signature: true, version: true, configuration: true },
  });
  await store.recordVersion({
    version: "5.4.0",
    source: "manifest",
    checkedAt: Date.now(),
  });

  const path = join(directory, STATE_FILE_NAME);
  const text = await readFile(path, "utf8");
  const info = await stat(path);
  assert.equal(info.mode & 0o777, 0o600);
  assert.doesNotMatch(text, /person@example\.com|secret|"uid"|"access"/);
  assert.match(text, /"digest": "[a-f0-9]{16}"/);
  assert.match(text, /"version": "5\.4\.0"/);

  const reloaded = createStateStore({ directory });
  assert.equal((await reloaded.cachedModels("42"))[0].id, "m");
  assert.equal((await reloaded.cachedQuota("42")).plan, "Plan");
  const account = await reloaded.account(accountDigest("42"));
  assert.equal(account.lastError.status, 503);
  assert.equal(account.selfCheck.ok, true);
  assert.equal(account.selfCheck.ms, 2);
});

test("a corrupt state file is ignored and replaced by the next write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atomcode-state-corrupt-"));
  const path = join(directory, STATE_FILE_NAME);
  await writeFile(path, "{ definitely not json", "utf8");
  const errors = [];
  const store = createStateStore({ directory, onError: (error) => errors.push(error) });
  const recovered = await store.read();
  assert.equal(recovered.version, emptyState().version);
  assert.deepEqual({ ...recovered.accounts }, {});
  assert.equal(errors.length, 1);
  await store.recordQuota("42", { plan: "Recovered", windows: [] });
  const reloaded = createStateStore({ directory });
  assert.equal((await reloaded.cachedQuota("42")).plan, "Recovered");
});

test("stores without a directory stay in memory and report no path", async () => {
  const store = createStateStore();
  assert.equal(store.path, undefined);
  assert.equal(stateFilePath(undefined), undefined);
  await store.recordQuota("42", { plan: "Memory", windows: [] });
  assert.equal((await store.cachedQuota("42")).plan, "Memory");
});

test("concurrent updates serialize rather than losing accounts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atomcode-state-concurrent-"));
  const store = createStateStore({ directory });
  await Promise.all([
    store.recordLogin("a", "atomcode-browser"),
    store.recordLogin("b", "atomcode-cli"),
    store.recordQuota("a", { plan: "A", windows: [] }),
  ]);
  const state = await store.read();
  assert.ok(state.accounts[accountDigest("a")]);
  assert.ok(state.accounts[accountDigest("b")]);
});
