import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { projectState, recordCheck, revision } from "./model.mjs";
import { NativeAPI, createManager, startService } from "./server.mjs";

const provider = {
  id: "fixture", name: "Fixture", chat: "https://example.invalid/v1",
  key: "fixture-secret-key", headers: { "X-Secret": "fixture-secret-header" },
  routing: "rotate", proxy: "@first", accountProxies: { "a@example.invalid": "@second" }
};
const settings = {
  settings: { proxy: "" }, proxyNow: "",
  proxies: [
    { id: "first", name: "Exit A", url: "socks5://proxy.example.invalid:1080" },
    { id: "second", name: "Exit B", url: "http://proxy.example.invalid:8080", user: "proxy-user", hasPass: true }
  ]
};
const listing = { providers: [{
  ...provider, account: { user: "a@example.invalid", logins: [
    { user: "A@example.invalid", on: true }, { user: "b@example.invalid", on: true }
  ] }
}] };
const emptyHistory = () => ({ proxies: {}, events: [] });

test("account and key choices override provider defaults without exposing credentials", () => {
  const state = projectState(settings, listing, [provider], emptyHistory());
  assert.equal(state.providers[0].accounts[0].exit.id, "second");
  assert.equal(state.providers[0].accounts[1].exit.id, "first");
  assert(!JSON.stringify(state).includes("fixture-secret"));
  const keyed = { ...provider, account: undefined, keyList: [{ id: "key-id", name: "Key A" }], accountProxies: { "key-id": "direct" } };
  const keyState = projectState(settings, { providers: [keyed] }, [keyed], emptyHistory());
  assert.equal(keyState.providers[0].accounts[0].exit.kind, "direct");
  const custom = { ...provider, proxy: "http://private-user:private-password@proxy.example.invalid:8080" };
  const masked = JSON.stringify(projectState(settings, { providers: [custom] }, [custom], emptyHistory()));
  assert(!masked.includes("private-user"));
  assert(!masked.includes("private-password"));
  assert(masked.includes("__custom__"));
});

test("IP changes remain visible after failures and keep the original baseline", () => {
  const history = emptyHistory();
  recordCheck(history, "first", { ok: true, ip: "192.0.2.10", at: 100 });
  recordCheck(history, "first", { ok: true, ip: "192.0.2.11", at: 101 });
  recordCheck(history, "first", { ok: false, at: 102 });
  assert.equal(history.proxies.first.expectedIp, "192.0.2.10");
  assert.equal(history.proxies.first.lastGood.ip, "192.0.2.11");
  assert.equal(history.events.filter((event) => event.type === "ip-change").length, 1);
  const projected = projectState(settings, listing, [provider], history);
  assert.equal(projected.proxies[0].changed, true);
  assert.equal(projected.providers[0].exit.state, "failed");
});

test("binding saves preserve other fields, reject stale revisions and persist checks", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "magpie-egress-test-"));
  try {
    await fs.writeFile(path.join(directory, "providers.json"), JSON.stringify({ providers: [provider] }));
    await fs.writeFile(path.join(directory, "settings.json"), "{}");
    const api = {
      async call(route, body) {
        if (route === "/api/settings") return settings;
        if (route.startsWith("/api/providers")) return listing;
        if (route === "/api/provider/save") {
          await fs.writeFile(path.join(directory, "providers.json"), JSON.stringify({ providers: [body] }));
          return {};
        }
        if (route === "/api/proxies/test") return { ok: true, ip: "192.0.2.10", loc: "US", ms: 20 };
        throw new Error(route);
      }
    };
    const manager = await createManager({ directory, api });
    await manager.bind({
      provider: "fixture", kind: "account", account: "b@example.invalid",
      choice: "@second", revision: revision(provider)
    });
    const after = JSON.parse(await fs.readFile(path.join(directory, "providers.json"))).providers[0];
    assert.deepEqual({ ...after, accountProxies: provider.accountProxies }, provider);
    assert.equal(after.accountProxies["b@example.invalid"], "@second");
    await assert.rejects(manager.bind({ provider: "fixture", kind: "provider", choice: "direct", revision: revision(provider) }), { status: 409 });
    await assert.rejects(manager.bind({ provider: "fixture", kind: "provider", choice: "@missing", revision: revision(after) }));
    await manager.check("first");
    const reloaded = await createManager({ directory, api });
    assert.equal((await reloaded.state()).proxies[0].lastGood.ip, "192.0.2.10");
    const backups = path.join(directory, "egress-manager/backups");
    assert.equal((await fs.stat(backups)).mode & 0o777, 0o700);
    for (const filename of await fs.readdir(backups)) assert.equal((await fs.stat(path.join(backups, filename))).mode & 0o777, 0o600);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("loopback JSON routes require the page token and reject unrelated origins and hosts", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "magpie-egress-service-"));
  await fs.writeFile(path.join(directory, "providers.json"), JSON.stringify({ providers: [provider] }));
  const api = { async call(route) { return route === "/api/settings" ? settings : listing; } };
  const { server, port } = await startService({ directory, api, port: await freePort() });
  try {
    const base = `http://127.0.0.1:${port}/`;
    const html = await (await fetch(base)).text();
    const token = html.match(/name="egress-token" content="([^"]+)"/)[1];
    assert.equal((await fetch(base + "api/state")).status, 403);
    const response = await fetch(base + "api/state", { headers: { "X-Egress-Token": token, Origin: "null" } });
    assert.equal(response.status, 200);
    assert(!JSON.stringify(await response.json()).includes("fixture-secret"));
    assert.equal((await fetch(base + "api/state", { headers: { "X-Egress-Token": token, Origin: "https://unrelated.example.invalid" } })).status, 403);
    const status = await new Promise((resolve, reject) => {
      const request = http.request(base + "api/state", {
        headers: { "X-Egress-Token": token, Host: `unrelated.example.invalid:${port}` }
      }, (response) => { response.resume(); resolve(response.statusCode); });
      request.on("error", reject);
      request.end();
    });
    assert.equal(status, 403);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("native web authentication stays in the server cookie and never enters API paths", async () => {
  const key = "fixture-web-secret";
  const observed = [];
  const server = http.createServer((request, response) => {
    observed.push({ url: request.url, cookie: request.headers.cookie });
    if (request.url.startsWith("/?k=")) {
      response.writeHead(303, { "Set-Cookie": `fixture=${key}; Path=/; HttpOnly` });
      response.end();
      return;
    }
    response.writeHead(request.headers.cookie === `fixture=${key}` ? 200 : 401, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ proxies: [] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const client = new NativeAPI(`http://127.0.0.1:${server.address().port}`, key);
    await client.call("/api/settings");
    assert.equal(observed[1].url, "/api/settings");
    assert.equal(observed[1].cookie, `fixture=${key}`);
    await assert.rejects(client.raw("/unexpected"));
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("page controls work without sandboxed form submissions", async () => {
  const html = await fs.readFile(new URL("./ui/index.html", import.meta.url), "utf8");
  const script = await fs.readFile(new URL("./ui/app.js", import.meta.url), "utf8");
  const bootstrap = await fs.readFile(new URL("./page/launch.js", import.meta.url), "utf8");
  assert(!/<form\b/i.test(html));
  assert(script.includes('query("#save-proxy").addEventListener("click"'));
  assert(script.includes('query("#confirm-submit").addEventListener("click"'));
  assert(!script.includes('addEventListener("submit"'));
  assert(bootstrap.includes("magpie.service"));
  assert(!/\bfetch\s*\(/.test(bootstrap));
});
