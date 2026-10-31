// Plugin entry (index.mjs): import has no side effects; server() → session.js → /open → daemon → stop() end to end.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canBind, freePort, pidAlive, request, waitFor } from "./helpers-net.js";

const repo = resolve(__dirname, "..", "..");
const entryUrl = pathToFileURL(join(repo, "index.mjs")).href;
const hasDist = existsSync(join(repo, "daemon", "dist", "main.js"));
const ENV_KEYS = ["AGENT_CONSOLE_PAGE_DIR", "XDG_CONFIG_HOME", "AGENT_CONSOLE_PORT", "AGENT_CONSOLE_MOCK"];

let savedEnv: Record<string, string | undefined> = {};
let tempDirs: string[] = [];
let pageDir = "";
let leftoverPids: number[] = [];
let stopHost: (() => Promise<void>) | null = null;

function parseSession(text: string): { v: number; port: number; key: string; token?: string; ts?: number } {
  const match = /^globalThis\.AgentConsoleSession = (\{.*\});\n$/.exec(text);
  if (!match) throw new Error(`unexpected session.js: ${text}`);
  return JSON.parse(match[1]);
}

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  pageDir = mkdtempSync(join(tmpdir(), "ac-entry-page-"));
  const xdg = mkdtempSync(join(tmpdir(), "ac-entry-xdg-"));
  tempDirs = [pageDir, xdg];
  process.env.AGENT_CONSOLE_PAGE_DIR = pageDir;
  process.env.XDG_CONFIG_HOME = xdg;
  leftoverPids = [];
  stopHost = null;
});

afterEach(async () => {
  if (stopHost) await stopHost().catch(() => {});
  for (const pid of leftoverPids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("plugin entry (index.mjs)", () => {
  it("import has no side effects: no listen, no session.js, no spawn", async () => {
    const port = await freePort();
    process.env.AGENT_CONSOLE_PORT = String(port);
    vi.resetModules();
    const mod = await import(/* @vite-ignore */ `${entryUrl}?noside=${Date.now()}`);
    expect(typeof mod.default.server).toBe("function");
    expect(mod.default.id).toBe("agent-console");
    // Give possible async side effects a moment
    await new Promise((r) => setTimeout(r, 300));
    expect(existsSync(join(pageDir, "session.js"))).toBe(false);
    expect(await canBind(port)).toBe(true);
    expect(existsSync(join(process.env.XDG_CONFIG_HOME!, "magpie", "agent-console"))).toBe(false);
  });

  it.skipIf(!hasDist)(
    "end to end: server() → session.js → /open → daemon → stop()",
    async () => {
      const port = await freePort();
      process.env.AGENT_CONSOLE_MOCK = "1";
      delete process.env.AGENT_CONSOLE_PORT;
      vi.resetModules();
      const mod = await import(/* @vite-ignore */ `${entryUrl}?e2e=${Date.now()}`);
      const host = await mod.default.server({}, { port });
      stopHost = () => host.stop();

      const sessionPath = join(pageDir, "session.js");
      expect(await waitFor(() => existsSync(sessionPath), 5000)).toBe(true);
      const session = parseSession(readFileSync(sessionPath, "utf8"));
      expect(session.v).toBe(2);
      expect(session.port).toBe(port);
      expect(session.key).toMatch(/^[0-9a-f]{64}$/);
      // Any page that knows Magpie's page path can read session.js via <script src>: it must not contain the daemon token
      expect(session.token).toBeUndefined();
      expect(Object.keys(session).sort()).toEqual(["key", "port", "ts", "v"]);
      // ts is refreshed while the host lives, so boot.js can tell a killed host's leftover file from a live one
      expect(Math.abs(Date.now() - (session as { ts?: number }).ts!)).toBeLessThan(10000);
      const key = session.key;

      // Gate: /open → 302 to the daemon, token only in the # fragment
      const open = await request(port, `/open?k=${key}&theme=dark`);
      expect(open.status).toBe(302);
      const location = new URL(String(open.headers.location));
      expect(location.hostname).toBe("127.0.0.1");
      const daemonPort = Number(location.port);
      expect(daemonPort).toBeGreaterThan(0);
      expect(daemonPort).not.toBe(port);
      expect(location.searchParams.get("theme")).toBe("dark");
      expect(location.searchParams.has("t")).toBe(false);
      const token = new URLSearchParams(location.hash.slice(1)).get("t") ?? "";
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      expect(token).not.toBe(key);
      expect(location.search).not.toContain(token);
      expect(location.search).not.toContain(key);
      expect(location.hash).toBe(`#t=${token}`);
      expect(readFileSync(sessionPath, "utf8")).not.toContain(token);

      // The daemon token can't be used as the gate key (nor the key as the daemon token, see the ping below)
      expect((await request(port, `/open?t=${token}`)).status).toBe(403);

      // Daemon page: no Origin → 200 and no token in it
      const page = await request(daemonPort, "/");
      expect(page.status).toBe(200);
      expect(page.body).not.toContain(token);
      expect(page.headers["access-control-allow-origin"]).toBeUndefined();

      expect((await request(daemonPort, "/api/ping", { "x-agent-console": key })).status).toBe(403);
      const ping = await request(daemonPort, "/api/ping", { "x-agent-console": token });
      expect(ping.status).toBe(200);
      const pingBody = JSON.parse(ping.body);
      expect(pingBody.ok).toBe(true);
      const daemonPid = Number(pingBody.pid);
      expect(daemonPid).toBeGreaterThan(0);
      leftoverPids.push(daemonPid);

      // Opening a second time reuses the same daemon
      const again = await request(port, `/open?k=${key}&theme=dark`);
      expect(again.status).toBe(302);
      expect(Number(new URL(String(again.headers.location)).port)).toBe(daemonPort);

      // Origin: null reading a static page → 403
      const opaque = await request(daemonPort, "/", { origin: "null" });
      expect(opaque.status).toBe(403);
      expect(opaque.body).not.toContain(token);

      // stop(): the daemon exits within 5 seconds, the gate port is freed, session.js is deleted
      await host.stop();
      stopHost = null;
      expect(await waitFor(() => !pidAlive(daemonPid), 5000)).toBe(true);
      expect(await canBind(port)).toBe(true);
      expect(existsSync(sessionPath)).toBe(false);
    },
    20000,
  );

  it("process exit removes its own session.js (Magpie's plugin host never calls stop())", async () => {
    const port = await freePort();
    const script = [
      `const mod = await import(${JSON.stringify(entryUrl)});`,
      `await mod.default.server({}, { port: ${port} });`,
      `const { existsSync } = await import("node:fs");`,
      `const file = ${JSON.stringify(join(pageDir, "session.js"))};`,
      `for (let i = 0; i < 100 && !existsSync(file); i++) await new Promise((r) => setTimeout(r, 50));`,
      `process.stdout.write(existsSync(file) ? "written\\n" : "missing\\n");`,
      `process.exit(0);`,
    ].join("\n");
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, AGENT_CONSOLE_PAGE_DIR: pageDir },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    const code = await new Promise((r) => child.once("exit", r));
    expect(code).toBe(0);
    expect(out.trim()).toBe("written");
    expect(existsSync(join(pageDir, "session.js"))).toBe(false);
    expect(await canBind(port)).toBe(true);
  }, 15000);
});
