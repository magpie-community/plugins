import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { startServer } from "../lib/server.mjs";

test("fallback HTML does not expose its API token through CORS", async () => {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const { server, reused } = await startServer({ options: { port } });
  assert.equal(reused, false);
  try {
    for (const path of ["/", "/missing-route"]) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { origin: "null" } });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("access-control-allow-origin"), null);
    }
    // 不完整的 UTF-8 转义（Node 与 Bun 都会交给 handler，由 decodeURIComponent 抛错）。
    const malformed = await fetch(`http://127.0.0.1:${port}/%E0%A4`);
    assert.equal(malformed.status, 400);
    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(health.status, 200);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});
