// Daemon lifeline: --port 0 ready line, Host checked against the actual port, exits when stdin closes, exits when the parent disappears.
import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pidAlive, request, waitFor } from "./helpers-net.js";

const repo = resolve(__dirname, "..", "..");
const mainJs = join(repo, "daemon", "dist", "main.js");
const hasDist = existsSync(mainJs);
const TOKEN = "lifeline-token";

let children: ChildProcess[] = [];
let dirs: string[] = [];

afterEach(() => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  children = [];
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function startDaemon(parentPid: number): ChildProcess {
  const data = mkdtempSync(join(tmpdir(), "ac-life-"));
  dirs.push(data);
  const child = spawn(process.execPath, [mainJs, "--port", "0", "--data", data, "--parent-pid", String(parentPid)], {
    env: { ...process.env, AGENT_CONSOLE_TOKEN: TOKEN, AGENT_CONSOLE_MOCK: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  child.stderr!.resume();
  return child;
}

function readyLine(child: ChildProcess): Promise<{ agentConsoleReady: boolean; port: number; pid: number }> {
  return new Promise((resolvePromise, reject) => {
    let buffer = "";
    const onData = (chunk: Buffer) => {
      buffer += String(chunk);
      for (const line of buffer.split(/\r?\n/)) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.agentConsoleReady) {
            child.stdout!.off("data", onData);
            child.stdout!.resume();
            resolvePromise(parsed);
            return;
          }
        } catch {}
      }
    };
    child.stdout!.on("data", onData);
    child.once("exit", (code) => reject(new Error(`daemon exited early (${code})`)));
  });
}

function exited(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolvePromise) => child.once("exit", (code) => resolvePromise(code)));
}

describe.skipIf(!hasDist)("daemon lifeline (daemon/dist/main.js)", () => {
  it("prints a ready line with the real port, checks Host against it, exits when stdin closes", async () => {
    const child = startDaemon(process.pid);
    const ready = await readyLine(child);
    expect(ready.agentConsoleReady).toBe(true);
    expect(ready.port).toBeGreaterThan(0);
    expect(ready.pid).toBe(child.pid);

    const good = await request(ready.port, "/", { host: `127.0.0.1:${ready.port}` });
    expect(good.status).toBe(200);
    const bad = await request(ready.port, "/", { host: `127.0.0.1:${ready.port + 1}` });
    expect(bad.status).toBe(421);

    const started = Date.now();
    child.stdin!.end();
    const code = await Promise.race([exited(child), new Promise((r) => setTimeout(() => r("timeout"), 5000))]);
    expect(code).toBe(0);
    expect(Date.now() - started).toBeLessThan(5000);
  }, 15000);

  it("exits within 7 s when the parent pid dies (stdin kept open)", async () => {
    const dummy = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    children.push(dummy);
    expect(await waitFor(() => typeof dummy.pid === "number", 2000)).toBe(true);

    const child = startDaemon(dummy.pid!);
    const ready = await readyLine(child);
    expect(ready.port).toBeGreaterThan(0);

    dummy.kill("SIGKILL");
    await exited(dummy);
    const started = Date.now();
    const gone = await waitFor(() => child.exitCode !== null || !pidAlive(child.pid!), 7000);
    expect(gone).toBe(true);
    expect(Date.now() - started).toBeLessThan(7000);
    // stdin never closed: the exit really comes from parent detection
    expect(child.stdin!.writableEnded).toBe(false);
  }, 15000);
});
