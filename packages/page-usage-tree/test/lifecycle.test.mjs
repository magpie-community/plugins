import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, version } from "../lib/server.mjs";
import { servicePidFile } from "../lib/data.mjs";

test("a newer build takes the port from an older one", async (t) => {
  const cache = mkdtempSync(join(tmpdir(), "usage-tree-cache-"));
  process.env.MAGPIE_CACHE_DIR = cache;
  const port = 3496;
  const pidFile = servicePidFile(port);

  const old = spawn(
    process.execPath,
    [join(import.meta.dirname, "fixtures", "old-service.mjs"), String(port), pidFile],
    { stdio: "ignore" },
  );
  t.after(() => old.kill());
  // the exit is watched before the new build starts: the older one is
  // stopped while it is taking the port.
  let stopped = false;
  old.once("exit", () => {
    stopped = true;
  });

  // wait for the old build to own the port
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
        signal: AbortSignal.timeout(300),
      });
      if (res.ok) break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  const info = await startServer({ port, load: async () => ({ summary: {}, accounts: [] }) });
  t.after(() => info.close());

  // the old build is gone, and this one answers
  assert.equal(stopped, true, "the older build was stopped");

  const res = await fetch(`http://127.0.0.1:${port}/healthz`);
  const body = await res.json();
  assert.equal(body.name, "magpie-usage-tree");
  assert.equal(body.version, version());
});

test("the service waits for a host on its way out to release the port", async (t) => {
  const cache = mkdtempSync(join(tmpdir(), "usage-tree-race-"));
  process.env.MAGPIE_CACHE_DIR = cache;
  const port = 3498;

  // a host that is shutting down keeps the port for a moment
  const leaving = createServer(() => {});
  await new Promise((resolve) => leaving.listen(port, "127.0.0.1", resolve));
  setTimeout(() => leaving.close(), 800);

  const info = await startServer({ port, load: async () => ({ summary: {}, accounts: [] }) });
  t.after(() => info.close());

  const res = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(res.status, 200);
});
