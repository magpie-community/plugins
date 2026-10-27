import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { context, fixture } from "./helpers.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const hostPath = process.env.MAGPIE_HOST_PATH;
const bun = process.env.MAGPIE_BUN_PATH ?? "bun";

async function host(t, f) {
  const child = spawn(bun, [resolve(hostPath)], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, SEARCH1API_API_KEY: "" },
  });
  const pending = new Map();
  let next = 0;
  let errors = "";
  child.stderr.on("data", (data) => {
    errors += data;
  });
  createInterface({ input: child.stdout }).on("line", (line) => {
    const msg = JSON.parse(line);
    if (!("result" in msg) && !msg.error) return;
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    clearTimeout(waiter.timer);
    if (msg.error) waiter.reject(new Error(msg.error.message));
    else waiter.resolve(msg.result);
  });
  child.on("error", (error) => {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    pending.clear();
  });
  child.on("exit", (code) => {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(`Host exited ${code}: ${errors}`));
    }
    pending.clear();
  });
  t.after(() => {
    child.kill();
  });
  const rpc = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out: ${errors}`));
      }, 15_000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  const init = await rpc("init", {
    authPath: f.authPath,
    directory: f.directory,
    plugins: [
      {
        spec: "@magpie-community/tools-search1api",
        target: root,
        options: { baseUrl: f.baseUrl },
      },
    ],
  });
  assert.equal(init.plugins[0].error, undefined, JSON.stringify(init));
  assert.equal(init.plugins[0].tools.length, 6);
  return rpc;
}

test(
  "actual Magpie Bun host: native OAuth → saved account → tools → refresh → logout",
  { timeout: 30_000 },
  async (t) => {
    assert.ok(
      hostPath,
      "Set MAGPIE_HOST_PATH to Magpie's internal/plugin/host.js (see README).",
    );
    const f = await fixture(t);
    const rpc = await host(t, f);
    const providers = await rpc("providers");
    assert.equal(providers[0].id, "search1api");
    assert.equal(providers[0].single, true);
    assert.deepEqual(providers[0].models, []);
    assert.deepEqual(
      providers[0].methods.map((m) => m.type),
      ["oauth", "api"],
    );
    const signIn = await rpc("authorize", {
      provider: "search1api",
      method: 0,
    });
    assert.equal((await fetch(signIn.url)).status, 200);
    const saved = await rpc("callback", { session: signIn.session });
    assert.equal(saved.ok, true);
    assert.equal(saved.account, "search1api");
    assert.equal((await stat(f.authPath)).mode & 0o777, 0o600);
    const call = () =>
      rpc("tool", {
        spec: "@magpie-community/tools-search1api",
        name: "search",
        args: { query: "Bun", searchService: "github", timeRange: "week" },
        ms: 5000,
        agent: "test",
      });
    const result = await call();
    assert.equal(JSON.parse(result.text).results[0].metadata.stars, 0);
    await assert.rejects(
      rpc("tool", {
        spec: "@magpie-community/tools-search1api",
        name: "search",
        args: { query: " " },
        ms: 5000,
      }),
      /query|arguments are wrong/,
    );
    const all = await f.readAuth();
    all.search1api.expires = Date.now() - 1;
    await writeFile(f.authPath, JSON.stringify(all), { mode: 0o600 });
    const second = await host(t, f);
    await Promise.all([
      call(),
      second("tool", {
        spec: "@magpie-community/tools-search1api",
        name: "ask",
        args: { query: "Bun" },
        ms: 5000,
      }),
    ]);
    assert.equal(
      f.state.refreshes,
      1,
      "rotating refresh tokens are shared safely across real Bun processes",
    );
    assert.equal((await f.readAuth()).search1api.access, "test-access-1");
    await rpc("signOut", { provider: "search1api" });
    await assert.rejects(call(), /Sign in/);
  },
);

test(
  "actual Magpie Bun host saves API keys using its native login path",
  { timeout: 20_000 },
  async (t) => {
    assert.ok(hostPath, "Set MAGPIE_HOST_PATH.");
    const f = await fixture(t);
    const rpc = await host(t, f);
    const saved = await rpc("apiKey", {
      provider: "search1api",
      method: 1,
      key: "test-native-api-key",
    });
    assert.equal(saved.ok, true);
    const result = await rpc("tool", {
      spec: "@magpie-community/tools-search1api",
      name: "news",
      args: { query: "test" },
      ms: 5000,
    });
    assert.ok(JSON.parse(result.text).results.length);
    assert.equal(
      f.calls.at(-1).headers.authorization,
      "Bearer test-native-api-key",
    );
  },
);
