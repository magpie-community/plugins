// node-pty is a native module. magpie installs plugins with `bun add` and never runs install scripts, so on a
// platform its tarball has no prebuild for (e.g. Linux musl, 32-bit ARM) there is no binary at all, and a broken
// or ABI-mismatched binary throws on load. Either way only the terminal panel may be affected: it falls back to a
// plain shell over pipes (`simple: true`, which the panel shows as "Simple terminal"), and the daemon keeps running.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Sent = { index: number; text: string };

function fakeGateway() {
  const sent: Sent[] = [];
  const events: unknown[] = [];
  const gw = {
    onTerminalInput: undefined as undefined | ((conn: { subs: Set<string> }, index: number, op: number, payload: Buffer) => void),
    publishTerminal(index: number, payload: Buffer) {
      sent.push({ index, text: payload.toString("utf8") });
    },
    publish(_ch: string, data: unknown) {
      events.push(data);
    },
  };
  return { gw, sent, events };
}

async function waitFor(check: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function runFallback() {
  const { TerminalService } = await import("../../daemon/src/terminal/service.js");
  const { gw, sent } = fakeGateway();
  const svc = new TerminalService(gw as any);
  const cwd = mkdtempSync(join(tmpdir(), "ac-term-"));
  try {
    const made = await svc.create("p1", cwd, 80, 24);
    expect("error" in made).toBe(false);
    if ("error" in made) return;
    expect(made.simple).toBe(true);
    expect(svc.list("p1")[0]).toMatchObject({ simple: true, alive: true });
    expect(svc.attach(made.id)).toMatchObject({ simple: true });
    // The plain shell still runs commands
    const conn = { subs: new Set([`terminal:${made.index}`]) };
    gw.onTerminalInput?.(conn, made.index, 2, Buffer.from("echo fallback-$((40+2))\n"));
    await waitFor(() => sent.some((s) => s.index === made.index && s.text.includes("fallback-42")));
    svc.killAll();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform === "win32")("terminal without node-pty", () => {
  afterEach(() => {
    vi.doUnmock("node-pty");
    vi.resetModules();
  });

  it("falls back to a plain shell when node-pty cannot be loaded", async () => {
    vi.resetModules();
    vi.doMock("node-pty", () => {
      throw new Error("simulated: no prebuilt pty.node for this platform");
    });
    await runFallback();
  });

  it("falls back to a plain shell when node-pty loads but cannot spawn", async () => {
    vi.resetModules();
    vi.doMock("node-pty", () => ({
      spawn() {
        throw new Error("simulated: posix_spawnp failed");
      },
    }));
    await runFallback();
  });
});
