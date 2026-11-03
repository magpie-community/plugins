import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("host options start the configured port after the warm-up listener", async () => {
  const warm = await unusedPort();
  let configured = await unusedPort();
  while (configured === warm) configured = await unusedPort();
  const moduleUrl = new URL("../index.mjs", import.meta.url).href;
  const script = `
    const plugin = (await import(${JSON.stringify(moduleUrl)})).default;
    await plugin.server({}, { port: ${configured} });
    const response = await fetch('http://127.0.0.1:${configured}/api/health');
    const body = await response.json();
    if (!response.ok || body.port !== ${configured}) process.exit(1);
    process.exit(0);
  `;
  // 隔离配置目录：server.mjs 会在 page-project-keys/ 下写实例指纹文件。
  const dir = await mkdtemp(join(tmpdir(), "key-cabinet-host-port-"));
  try {
    const { stderr } = await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", script], {
      env: {
        ...process.env,
        MAGPIE_CONFIG_DIR: dir,
        MAGPIE_PROJECT_KEYS_PORT: String(warm),
      },
      timeout: 10000,
    });
    assert.equal(stderr, "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
