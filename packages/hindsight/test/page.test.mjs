import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Script } from "node:vm";
import { testConnection } from "../page/probe.mjs";

const read = name => readFile(new URL(`../page/${name}`, import.meta.url), "utf8");

function pageCalls(source) {
  return [...source.matchAll(/\bmagpie\s*(?:\?\.|\.)\s*([\w$]+(?:\s*(?:\?\.|\.)\s*[\w$]+)*)/g)]
    .map(([, call]) => call.replace(/\s/g, "").replaceAll("?.", "."));
}

test("settings HTML exposes every option field and status region", async () => {
  const html = await read("settings.html");
  const ids = [
    "form", "hindsight_api", "bank", "api_key", "api_key_header", "api_key_prefix", "authorizationEnv",
    "recall_max_tokens", "capture", "agents", "max_replay_blocks",
    "gatewayTimeoutMs", "allowRemote", "allowInsecureHttp", "save", "test-connection",
    "status", "status-bank", "status-api", "status-auth", "status-agents"
  ];
  for (const id of ids) assert.match(html, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  assert.match(html, /<script src=["']_magpie\/bridge\.js["'] defer><\/script>/);
  assert.doesNotMatch(html, /<script(?![^>]*src=)[^>]*>/);
  assert.doesNotMatch(html, /\stype=["']password["']/);
  assert.match(html, /hermes \/ dsh/);
});

test("settings script parses and uses only the released options/service bridge", async () => {
  const source = await read("settings.js");
  new Script(source, { filename: "settings.js" });
  assert.doesNotMatch(source, /\b(fetch|XMLHttpRequest|WebSocket|EventSource)\b/);
  assert.doesNotMatch(source, /\bmagpie\s*\[|\b(?:window|globalThis)\s*\[\s*["']magpie["']\s*\]/);
  const allowed = ["service", "options.get", "options.set", "ready.then"];
  assert.deepEqual([...new Set(pageCalls(source))].sort(), [...allowed].sort());
  assert.ok(pageCalls(source).every(call => allowed.includes(call)));
  for (const key of ["hindsight_api", "bank", "recall_max_tokens", "capture", "agents", "gatewayTimeoutMs", "allowRemote", "allowInsecureHttp", "api_key", "api_key_header", "api_key_prefix", "authorizationEnv", "max_replay_blocks"])
    assert.match(source, new RegExp(`\\b${key}\\b`));
  assert.match(source, /location\.assign/);
});

test("the connection-test envelope keeps `ok` flat and `code` a string", async () => {
  const { testEnvelope } = await import("../page/service.mjs");

  const healthy = testEnvelope({ ok: true, code: "connected", ms: 12, bank: "hermes-dsh" });
  assert.equal(healthy.status, 200);
  assert.deepEqual(healthy.body, { ok: true, code: "connected", bank: "hermes-dsh", ms: 12 });

  const down = testEnvelope({ ok: false, code: "unavailable", ms: 30, bank: "hermes" });
  assert.equal(down.status, 503);
  assert.equal(down.body.ok, false);
  assert.equal(down.body.code, "unavailable");
  assert.equal(typeof down.body.code, "string");

  const garbled = testEnvelope({ ok: true, code: undefined });
  assert.equal(garbled.body.ok, false, "a missing code is never reported as success");
  assert.equal(garbled.body.code, "invalid");
});

test("health probe performs a minimal GET without reading memories", async () => {
  let seen;
  const result = await testConnection({ hindsight_api: "http://127.0.0.1:8888", bank: "hermes" }, async (url, init) => {
    seen = { url, init };
    return new Response(JSON.stringify({ status: "healthy", database: "connected", ignored: "not returned" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  });
  assert.equal(result.ok, true);
  assert.equal(result.code, "connected");
  assert.equal(result.bank, "hermes");
  assert.ok(Number.isInteger(result.ms));
  assert.equal(seen.url, "http://127.0.0.1:8888/health");
  assert.equal(seen.init.method, "GET");
  assert.equal(seen.init.body, undefined);
  assert.equal(seen.init.redirect, "error");
  assert.equal(JSON.stringify(result).includes("ignored"), false);
});

test("health probe rejects unavailable and non-Hindsight responses", async () => {
  const unavailable = await testConnection({}, async () => new Response("{}", { status: 503 }));
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.code, "unavailable");
  assert.equal(unavailable.bank, "hermes");
  const invalid = await testConnection({}, async () => new Response(JSON.stringify({ status: "unknown" }), { status: 200 }));
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, "invalid");
});

test("health probe reuses the saved credential so a protected API reports healthy", async () => {
  let seen;
  const result = await testConnection(
    { hindsight_api: "http://127.0.0.1:8888", bank: "hermes", api_key: "sk-test" },
    async (url, init) => {
      seen = init.headers;
      return Response.json({ status: "healthy", database: "connected" });
    }
  );
  assert.equal(result.ok, true);
  assert.equal(seen.Authorization, "Bearer sk-test");

  const rejected = await testConnection(
    { api_key: "wrong" },
    async () => new Response("{}", { status: 401 })
  );
  assert.equal(rejected.code, "unauthorized");
});

test("loopback service has the Magpie host entry point without starting on import", async () => {
  const { default: service } = await import("../page/service.mjs");
  assert.equal(service.id, "magpie-hindsight");
  assert.equal(typeof service.server, "function");
});
