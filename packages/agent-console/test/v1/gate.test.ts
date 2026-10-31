// Plugin gate (lib/gate.mjs): driven by a fake ensureDaemon, no real daemon is started.
import { describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { freePort, request } from "./helpers-net.js";

const gateUrl = pathToFileURL(join(resolve(__dirname, "..", ".."), "lib", "gate.mjs")).href;

describe("gate (lib/gate.mjs)", () => {
  it("checks Host, refuses any Origin, requires the gate key, and serializes opens", async () => {
    const { createGate } = await import(/* @vite-ignore */ gateUrl);
    const port = await freePort();
    const daemonPort = await freePort();
    const key = "c".repeat(64);
    const token = "a".repeat(64);
    let calls = 0;
    const gate = createGate({
      port,
      key,
      token,
      ensureDaemon: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 50));
        return { port: daemonPort };
      },
    });
    await gate.listen();
    try {
      expect((await request(port, `/open?k=${key}`, { host: `evil.example:${port}` })).status).toBe(421);
      expect((await request(port, `/open?k=${key}`, { host: `127.0.0.1:${port + 1}` })).status).toBe(421);
      expect((await request(port, `/open?k=${key}`, { origin: "null" })).status).toBe(403);
      expect((await request(port, `/open?k=${key}`, { origin: "https://evil.example" })).status).toBe(403);
      expect((await request(port, "/")).status).toBe(404);
      expect((await request(port, "/open")).status).toBe(403);
      expect((await request(port, "/open?k=wrong")).status).toBe(403);
      // the daemon token is not a gate key, in either parameter
      expect((await request(port, `/open?k=${token}`)).status).toBe(403);
      expect((await request(port, `/open?t=${token}`)).status).toBe(403);
      expect((await request(port, `/open?t=${key}`)).status).toBe(403);
      expect(calls).toBe(0);

      const results = await Promise.all([
        request(port, `/open?k=${key}&theme=dark`),
        request(port, `/open?k=${key}&theme=dark`),
      ]);
      expect(calls).toBe(1);
      for (const result of results) {
        expect(result.status).toBe(302);
        expect(result.headers.location).toBe(`http://127.0.0.1:${daemonPort}/?theme=dark#t=${token}`);
        expect(result.headers["cache-control"]).toBe("no-store");
        expect(result.headers["x-content-type-options"]).toBe("nosniff");
        expect(result.headers["referrer-policy"]).toBe("no-referrer");
        expect(result.headers["access-control-allow-origin"]).toBeUndefined();
        expect(result.headers.location).not.toContain(key);
      }
    } finally {
      await gate.close();
    }
  });

  it("answers 503 when the daemon cannot start, and recovers on the next open", async () => {
    const { createGate } = await import(/* @vite-ignore */ gateUrl);
    const port = await freePort();
    const key = "d".repeat(64);
    const token = "b".repeat(64);
    let fail = true;
    const gate = createGate({
      port,
      key,
      token,
      ensureDaemon: async () => {
        if (fail) throw new Error("spawn ENOENT");
        return { port: 45678 };
      },
    });
    await gate.listen();
    try {
      const first = await request(port, `/open?k=${key}`);
      expect(first.status).toBe(503);
      expect(first.body).not.toContain(token);
      fail = false;
      const second = await request(port, `/open?k=${key}`);
      expect(second.status).toBe(302);
    } finally {
      await gate.close();
    }
  });

  it("refuses to start with a missing gate key or one equal to the daemon token", async () => {
    const { createGate } = await import(/* @vite-ignore */ gateUrl);
    const ensureDaemon = async () => ({ port: 1 });
    const token = "e".repeat(64);
    expect(() => createGate({ port: 1, token, ensureDaemon })).toThrow();
    expect(() => createGate({ port: 1, key: token, token, ensureDaemon })).toThrow();
    expect(() => createGate({ port: 1, key: "f".repeat(64), token, ensureDaemon })).not.toThrow();
  });
});
