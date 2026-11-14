// The page's control API: what it answers without a key, what it never
// runs, and the page's own files. No frpc is downloaded or started here.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import * as service from "../lib/service.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "frp-connect-test-"));
const page = path.resolve(import.meta.dirname, "../page");

async function up(options = {}, base = tmp()) {
  const part = service.frp({ frpcBinary: "local", frpcPath: "/nonexistent/frpc", ...options }, { base });
  const { server, secret } = await service.listen(part, { port: 0 + 34000 + Math.floor(Math.random() * 1000), page });
  const port = server.address().port;
  const at = (p, init) => fetch(`http://127.0.0.1:${port}${p}`, init);
  return { part, server, secret, at, close: () => server.close() };
}

test("the page's own files are served without the key", async () => {
  const s = await up();
  try {
    const html = await s.at("/");
    assert.equal(html.status, 200);
    assert.match(await html.text(), /FRP Connect/);
    assert.equal((await s.at("/app.js")).status, 200);
    assert.equal((await s.at("/i18n.js")).status, 200);
    assert.equal((await s.at("/../index.mjs")).status, 404);
  } finally {
    s.close();
  }
});

test("the state and the actions need the key", async () => {
  const s = await up();
  try {
    assert.equal((await s.at("/api/state")).status, 403);
    assert.equal((await s.at("/api/state", { headers: { "x-frp-key": "wrong" } })).status, 403);
    const start = await s.at("/api/action", {
      method: "POST",
      headers: { "x-frp-key": "wrong", "content-type": "application/json" },
      body: JSON.stringify({ action: "start" }),
    });
    assert.equal(start.status, 403);
    // nothing ran: no frpc, no config file
    assert.equal(s.part.state().running, false);
  } finally {
    s.close();
  }
});

test("with the key, the state reads out with no frpc running", async () => {
  const s = await up();
  try {
    const res = await s.at("/api/state", { headers: { "x-frp-key": s.secret } });
    assert.equal(res.status, 200);
    const state = await res.json();
    assert.equal(state.running, false);
    assert.equal(state.pid, null);
    assert.equal(typeof state.logPath, "string");
    assert.equal(typeof state.log, "string");
    assert.equal(state.binary.source, "local");
  } finally {
    s.close();
  }
});

test("stop with no frpc running stops nothing", async () => {
  const s = await up();
  try {
    const res = await s.at("/api/action", {
      method: "POST",
      headers: { "x-frp-key": s.secret, "content-type": "application/json" },
      body: JSON.stringify({ action: "stop" }),
    });
    const answer = await res.json();
    assert.deepEqual(answer.result, { stopped: false, pid: null });
  } finally {
    s.close();
  }
});

test("a call that names no action is an error, not a start", async () => {
  const s = await up({ serverAddr: "h", proxies: [{ name: "p", localPort: 1 }] });
  try {
    const res = await s.at("/api/action", {
      method: "POST",
      headers: { "x-frp-key": s.secret, "content-type": "application/json" },
      body: JSON.stringify({ action: "rm -rf" }),
    });
    const answer = await res.json();
    assert.match(answer.error, /no such action/);
    assert.equal(s.part.state().running, false);
  } finally {
    s.close();
  }
});

test("verify says frpc isn't there rather than downloading one", async () => {
  const s = await up({ serverAddr: "h", serverPort: 7000, proxies: [{ name: "p", localPort: 1 }] });
  try {
    const res = await s.at("/api/action", {
      method: "POST",
      headers: { "x-frp-key": s.secret, "content-type": "application/json" },
      body: JSON.stringify({ action: "verify" }),
    });
    const answer = await res.json();
    // a local frpc that isn't there: `frpc verify` fails, and nothing runs
    assert.equal(answer.result.ok, false);
    assert.equal(s.part.state().running, false);
  } finally {
    s.close();
  }
});

test("the key is a file in the plugin's own folder, made once", () => {
  const dir = tmp();
  const first = service.key(dir);
  assert.ok(first.length >= 16);
  assert.equal(service.key(dir), first);
  assert.equal(fs.readFileSync(path.join(dir, "service.key"), "utf8").trim(), first);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(path.join(dir, "service.key")).mode & 0o077, 0, "not readable by others");
  }
});
