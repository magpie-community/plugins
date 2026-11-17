// Optional real-host test. All config, usage and session paths are isolated.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCollector } from "../lib/collector.mjs";

test(
  "reports into an isolated real Magpie ledger without duplication",
  { skip: !process.env.MAGPIE_BINARY, timeout: 30000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "amp-magpie-"));
    const config = join(root, ".config", "magpie");
    await mkdir(config, { recursive: true });
    const port = await new Promise((resolve) => {
      const server = createServer();
      server.listen(0, "127.0.0.1", () => {
        const port = server.address().port;
        server.close(() => resolve(port));
      });
    });
    await writeFile(
      join(config, "settings.json"),
      JSON.stringify({ port, sessionReads: { asked: true, all: false } }),
    );
    const child = spawn(process.env.MAGPIE_BINARY, ["serve"], {
      env: {
        PATH: process.env.PATH,
        HOME: root,
        USERPROFILE: root,
        XDG_CONFIG_HOME: join(root, ".config"),
        XDG_CACHE_HOME: join(root, ".cache"),
        XDG_DATA_HOME: join(root, ".local", "share"),
        MAGPIE_ADDR: `127.0.0.1:${port}`,
      },
      stdio: "ignore",
    });
    const stopped = new Promise((resolve) => child.once("exit", resolve));
    t.after(async () => {
      child.kill("SIGTERM");
      await stopped;
      await rm(root, { recursive: true, force: true });
    });
    const base = `http://127.0.0.1:${port}`;
    let up = false;
    for (let i = 0; i < 100; i++) {
      try {
        if (
          (
            await fetch(`${base}/v1/models`, {
              signal: AbortSignal.timeout(500),
            })
          ).ok
        ) {
          up = true;
          break;
        }
      } catch {}
      if (child.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(up, "sandbox gateway starts");
    const fixture = JSON.parse(
      await readFile(new URL("fixtures/amp-local.json", import.meta.url)),
    );
    let now = Date.now();
    const collector = await createCollector({
      dataDir: join(config, "amp-usage"),
      configDir: config,
      options: { gatewayURL: base, settleSeconds: 30 },
      clock: () => now,
      source: async () => ({ threads: [fixture] }),
    });
    t.after(() => collector.close());
    assert.equal((await collector.run()).pending, 1);
    now += 31000;
    const first = await collector.run();
    assert.deepEqual(first.errors, []);
    assert.equal(first.imported, 1);
    assert.equal((await collector.run()).imported, 0);
    const ledger = await (
      await fetch(`${base}/v1/magpie/usage/requests?period=all&agent=amp`)
    ).json();
    assert.equal(ledger.total, 1);
    assert.equal(ledger.rows[0].agent, "amp");
    assert.equal(ledger.rows[0].source, "reported");
    assert.equal(ledger.input, fixture.messages[0].usage.inputTokens);
    assert.equal(ledger.output, fixture.messages[0].usage.outputTokens);
    assert.equal(
      ledger.cache_read,
      fixture.messages[0].usage.cacheReadInputTokens || 0,
    );
  },
);
