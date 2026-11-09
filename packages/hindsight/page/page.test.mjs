import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Script } from "node:vm";
import { testConnection } from "./probe.mjs";

const read = name => readFile(new URL(`./${name}`, import.meta.url), "utf8");

function pageCalls(source) {
  return [...source.matchAll(/\bmagpie\s*(?:\?\.|\.)\s*([\w$]+(?:\s*(?:\?\.|\.)\s*[\w$]+)*)/g)]
    .map(([, call]) => call.replace(/\s/g, "").replaceAll("?.", "."));
}

test("settings HTML exposes the eight option fields and status regions", async () => {
  const html = await read("settings.html");
  const ids = [
    "form", "hindsight_api", "bank", "recall_max_tokens", "capture", "agents",
    "gatewayTimeoutMs", "allowRemote", "allowInsecureHttp", "save", "test-connection",
    "status", "status-bank", "status-api", "status-agents"
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
  for (const key of ["hindsight_api", "bank", "recall_max_tokens", "capture", "agents", "gatewayTimeoutMs", "allowRemote", "allowInsecureHttp"])
    assert.match(source, new RegExp(`\\b${key}\\b`));
  assert.match(source, /location\.assign/);
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

test("loopback service has the Magpie host entry point without starting on import", async () => {
  const { default: service } = await import("./service.mjs");
  assert.equal(service.id, "magpie-hindsight");
  assert.equal(typeof service.server, "function");
});
