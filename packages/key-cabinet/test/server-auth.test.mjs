import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createNetServer } from "node:net";
import { request } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveEnv } from "./env.mjs";

async function unusedPort() {
  const server = createNetServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function rawGet(port, path, headers) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("API 拒绝缺少口令、外站 Origin 和伪造 Host", async () => {
  const restoreEnv = saveEnv(["MAGPIE_CONFIG_DIR", "MAGPIE_PROJECT_KEYS_GATEWAY"]);
  const dir = await mkdtemp(join(tmpdir(), "key-cabinet-auth-"));
  process.env.MAGPIE_CONFIG_DIR = dir;
  process.env.MAGPIE_PROJECT_KEYS_GATEWAY = "http://127.0.0.1:1";
  const { startServer } = await import("../lib/server.mjs");
  const port = await unusedPort();
  const { server, reused } = await startServer({ options: { port } });
  assert.equal(reused, false);
  const base = `http://127.0.0.1:${port}`;
  try {
    const html = await (await fetch(base)).text();
    const token = html.match(/__MAGPIE_PROJECTS_TOKEN__="([^"]+)"/)[1];

    assert.equal((await fetch(base + "/api/projects")).status, 403);

    const foreign = await fetch(base + "/api/projects", {
      headers: { "x-magpie-projects-token": token, origin: "https://evil.example" },
    });
    assert.equal(foreign.status, 403);

    const sandboxed = await fetch(base + "/api/projects", {
      headers: { "x-magpie-projects-token": token, origin: "null" },
    });
    assert.equal(sandboxed.status, 200);

    const spoofedHost = await rawGet(port, "/api/projects", {
      host: "evil.example",
      "x-magpie-projects-token": token,
    });
    assert.equal(spoofedHost.status, 403);

    const health = await fetch(base + "/api/health");
    const healthBody = await health.json();
    assert.equal(health.status, 200);
    assert.equal("root" in healthBody, false);

    const preflight = await fetch(base + "/api/projects", {
      method: "OPTIONS",
      headers: {
        origin: "null",
        "access-control-request-headers": "content-type, x-magpie-projects-token",
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "null");

    const badJSON = await fetch(base + "/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json", "x-magpie-projects-token": token },
      body: "{broken",
    });
    assert.equal(badJSON.status, 400);

    // 1 MiB 上限：先按 Content-Length 拒绝，避免大请求把服务拖住。
    const tooBig = await fetch(base + "/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json", "x-magpie-projects-token": token },
      body: JSON.stringify({ name: "x".repeat((1 << 20) + 1) }),
    });
    assert.equal(tooBig.status, 413);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
    restoreEnv();
  }
});
