import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Store } from "../store.mjs";
import { LocalVault, secretOperation } from "../vault.mjs";
import { Center } from "../center.mjs";
import { pythonCommand } from "../runtime.mjs";

function fakeSecretOperation() {
  const sealed = new Map();
  let counter = 0;
  return async ({ op, channel, id, value }) => {
    assert.equal(op, "protect");
    const cipher = `fake-dpapi-blob-${++counter}`;
    sealed.set(cipher, { channel, id, value });
    return { cipher };
  };
}

function fixture(t, operation = fakeSecretOperation()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "search-local-keys-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(root);
  const vault = new LocalVault(store, operation);
  const calls = [];
  const center = new Center({
    store,
    vault,
    backend: {
      capabilities: async () => ({ channels: { exa: { configured: true } }, grok: {} }),
      search: () => assert.fail("old backend must not be used"),
    },
    credential: async (id, key, args, url, signal, encrypted) => {
      calls.push({ id, url, encrypted });
      return { sources: [], routing: { channel_results: { [id]: { status: "no_sources" } } } };
    },
  });
  return { root, store, vault, center, calls };
}

test("local key create, retain, replace and delete never expose plaintext or fall back", async t => {
  const { root, store, center, calls } = fixture(t);
  const secret = "synthetic-only-api-key-not-a-real-secret";
  const input = {
    channel: "exa",
    revision: 0,
    baseUrl: "https://api.exa.ai",
    strategy: "rotate",
    keys: [{ id: "draft", label: "测试 Key", enabled: true, value: secret }],
  };
  await center.saveChannel(input);
  const first = store.policy().channels.exa.keys[0];
  assert.ok(first.ref.startsWith("local://"));
  assert.ok(!fs.readFileSync(path.join(root, "credentials.encrypted.json"), "utf8").includes(secret));
  assert.ok(!JSON.stringify(await center.snapshot()).includes(secret));

  await center.search({ query: "test", channels: ["exa"] });
  assert.ok(calls[0].encrypted.cipher);
  assert.equal(calls[0].encrypted.id, first.id);

  // Empty value retains prior ref and cipher without re-prompting.
  await center.saveChannel({ ...input, revision: 1, keys: [{ ...first, value: "" }] });
  assert.equal(store.policy().channels.exa.keys[0].ref, first.ref);

  // Replacement rotates ref & id.
  await center.saveChannel({ ...input, revision: 2, keys: [{ ...first, value: secret + "-replacement" }] });
  assert.notEqual(store.policy().channels.exa.keys[0].ref, first.ref);

  // Deletion prunes encrypted store and disables unconfigured channel.
  await center.saveChannel({ ...input, revision: 3, keys: [] });
  assert.deepEqual(store.read("credentials.encrypted.json", {}), {});
  assert.equal((await center.publicCapabilities()).channels.exa.configured, false);
  await center.search({ query: "test", channels: ["exa"] });
  assert.equal(calls.length, 1);

  await assert.rejects(center.saveChannel({ ...input, revision: 0 }), e => e.code === "CONFLICT");
});

test("encrypted keys are bound to their channel (B7)", async t => {
  const { vault } = fixture(t);
  const entry = await vault.protect("exa", "synthetic-channel-binding-key");
  vault.persist([entry]);
  assert.throws(() => vault.cipher("tavily", { ref: `local://${entry.id}` }), e => e.code === "KEY_OWNER" && /不属于/.test(e.message));
  assert.equal(vault.cipher("exa", { ref: `local://${entry.id}` }).cipher, entry.cipher);
});

test("Grok channel saves model choices atomically and rejects invalid IDs", async t => {
  const { store, center } = fixture(t);
  const input = {
    channel: "grok",
    revision: 0,
    baseUrl: "https://example.test",
    strategy: "order",
    keys: [],
    models: { quick: "grok-fast", balanced: "grok-reasoning", deep: "grok-multi" },
    defaultProfile: "balanced",
  };
  await center.saveChannel(input);
  assert.deepEqual(store.policy().models, input.models);
  assert.equal(store.policy().defaultProfile, "balanced");
  await assert.rejects(center.saveChannel({ ...input, revision: 1, models: { ...input.models, quick: "bad model" } }), /模型/);
  assert.equal(store.policy().revision, 1);
});

const winTest = process.platform === "win32" ? test : test.skip;
winTest("Windows DPAPI round-trip encrypts, decrypts and enforces owner match", async t => {
  const { vault } = fixture(t, secretOperation);
  const secret = "synthetic-dpapi-roundtrip-secret";
  const entry = await vault.protect("exa", secret);
  vault.persist([entry]);
  assert.ok(!entry.cipher.includes(secret));
  const helperDir = fileURLToPath(new URL("../", import.meta.url));
  const py = pythonCommand();
  const ok = spawnSync(
    py.file,
    [...py.args, "-B", "-c", "import json,sys,local_secrets as s; r=json.loads(sys.stdin.read()); print(s.unprotect(r['c'],r['id'],r['k']))"],
    { cwd: helperDir, input: JSON.stringify({ c: "exa", id: entry.id, k: entry.cipher }), encoding: "utf8", windowsHide: true },
  );
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout.trim(), secret);

  const wrongChannel = spawnSync(
    py.file,
    [...py.args, "-B", "-c", "import json,sys,local_secrets as s; r=json.loads(sys.stdin.read()); s.unprotect(r['c'],r['id'],r['k'])"],
    { cwd: helperDir, input: JSON.stringify({ c: "tavily", id: entry.id, k: entry.cipher }), encoding: "utf8", windowsHide: true },
  );
  assert.notEqual(wrongChannel.status, 0);
});

const nonWinTest = process.platform !== "win32" ? test : test.skip;
nonWinTest("non-Windows DPAPI call fails with clear UNSUPPORTED_PLATFORM error", async () => {
  await assert.rejects(
    secretOperation({ op: "protect", channel: "exa", id: "k1", value: "synthetic" }),
    e => e.code === "UNSUPPORTED_PLATFORM",
  );
});
