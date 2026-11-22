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

test("settings HTML exposes plugin option fields and status regions", async () => {
  const html = await read("settings.html");
  const ids = [
    "form", "hindsight_api", "bank", "recall_max_tokens", "capture", "agents",
    "gatewayTimeoutMs", "port", "allowRemote", "allowInsecureHttp", "save", "test-connection",
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

test("save uses the Magpie bridge even when the sandbox blocks form submission", async () => {
  const fields = new Map();
  const field = id => {
    if (!fields.has(id)) fields.set(id, {
      dataset: {}, events: {}, checked: false,
      addEventListener(name, callback) { this.events[name] = callback; }
    });
    return fields.get(id);
  };
  let options = { bank: "hermes", agents: ["claude", "codex", "opencode"], gatewayTimeoutMs: 8000, custom: true };
  const ready = Promise.resolve();
  new Script(await read("settings.js")).runInNewContext({
    document: { getElementById: field }, window: { addEventListener() {} }, URL,
    magpie: { ready, options: { get: async () => options, set: async next => { options = next; return options; } } }
  });
  await new Promise(resolve => setImmediate(resolve));
  field("agents").value = "claude,opencode";
  field("form").events.input();
  await field("save").events.click?.();
  assert.deepEqual(Array.from(options.agents), ["claude", "opencode"]);
  assert.equal(options.gatewayTimeoutMs, 8000);
  assert.equal(options.custom, true);
  assert.match(field("status").textContent, /配置已保存/);
  assert.match(field("save-status").textContent, /配置已保存/);
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

test("connection service can load beside a busy port and responds to the sandboxed test page", async t => {
  const { default: service } = await import("./service.mjs");
  let handler;
  const server = { hostname: "127.0.0.1", port: 3483, stop() {} };
  t.mock.method(console, "warn", () => {});
  t.mock.method(console, "error", () => {});
  const bun = { serve({ hostname, port, fetch }) {
    assert.equal(hostname, "127.0.0.1");
    if (port === 3482) throw Object.assign(new Error("port busy"), { code: "EADDRINUSE" });
    handler = fetch;
    return server;
  } };
  const previousBun = globalThis.Bun;
  globalThis.Bun = bun;
  t.after(() => { if (previousBun) globalThis.Bun = previousBun; else delete globalThis.Bun; });
  t.mock.method(globalThis, "fetch", async () => Response.json({ status: "healthy", database: "connected" }));

  await assert.doesNotReject(() => service.server({}, { port: 3482 }));
  const running = await service.server({}, { port: 3483, bank: "hermes" });
  t.after(() => running.close());
  const send = (method, headers = {}) => handler(new Request("http://127.0.0.1:3483/test", {
    method, headers: { host: "127.0.0.1:3483", ...headers }
  }), server);
  const markup = await (await send("GET")).text();
  const token = markup.match(/name="hindsight-token" content="([a-f0-9]+)"/)[1];
  new Script(markup.match(/<script>([\s\S]+)<\/script>/)[1]);
  const preflight = await send("OPTIONS", {
    origin: "null", "access-control-request-method": "POST", "access-control-request-headers": "x-hindsight-token"
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "null");
  for (const headers of [{ origin: "https://example.com", "x-hindsight-token": token }, { origin: "null" }]) {
    assert.equal((await send("POST", headers)).status, 403);
  }
  const response = await send("POST", { origin: "null", "x-hindsight-token": token });
  assert.equal(response.headers.get("access-control-allow-origin"), "null");
  const result = await response.json();
  assert.equal(result.ok, true);
  assert.equal(result.code, "connected");
  assert.equal(result.bank, "hermes");
  assert.ok(Number.isInteger(result.ms));
});
