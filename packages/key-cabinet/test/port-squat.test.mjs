import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveEnv } from "./env.mjs";

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("端口被冒充 service 名的进程占用时不复用", async () => {
  const restoreEnv = saveEnv(["MAGPIE_CONFIG_DIR", "MAGPIE_PROJECT_KEYS_PORT", "MAGPIE_PROJECT_KEYS_GATEWAY"]);
  const dir = await mkdtemp(join(tmpdir(), "key-cabinet-squat-"));
  const port = await unusedPort();
  // server.mjs 在 import 时读取端口，所以环境变量必须在 import 之前设置。
  process.env.MAGPIE_CONFIG_DIR = dir;
  process.env.MAGPIE_PROJECT_KEYS_PORT = String(port);
  process.env.MAGPIE_PROJECT_KEYS_GATEWAY = "http://127.0.0.1:1";

  const fake = createServer((req, res) => {
    if (req.url === "/api/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "page-project-keys", port, uiOk: true }));
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><html><body>not us</body></html>");
  });
  await new Promise((resolve) => fake.listen(port, "127.0.0.1", resolve));

  try {
    const { startServer } = await import("../lib/server.mjs");
    await assert.rejects(
      startServer(),
      /端口 \d+ 已被占用，且现有进程不可用/
    );
  } finally {
    await new Promise((resolve) => fake.close(resolve));
    await rm(dir, { recursive: true, force: true });
    restoreEnv();
  }
});
