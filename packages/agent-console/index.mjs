// Agent Console — Magpie plugin entry (loaded by Magpie's Bun plugin host).
//
// Lifecycle and token handoff (design after the PR #535 review):
// - Importing this module has no side effects: no port, no process, no file writes.
// - When Magpie calls server(input, options): generate two random secrets for this host — the gate key (written to
//   page/session.js) and the daemon token (handed to the daemon page only via the # fragment of the gate's 302, never written to any static file) —
//   and bind a tiny "gate" (lib/gate.mjs) on 127.0.0.1:<port> (default 3488). Only after a successful bind is
//   page/session.js written atomically; the plugin page (sandbox iframe) reads it from the page directory Magpie serves. If the bind fails (port in use)
//   it retries every 2 seconds in the background; server() itself returns immediately and never blocks the plugin host from loading.
// - The daemon is started only when the plugin page navigates to the gate's /open?k=<key> ("start on page open"): a non-detached child,
//   stdin is a lifeline pipe and it gets --parent-pid; later /open calls reuse the same child.
// - The daemon exits by itself when the host exits (stdin closes or the parent disappears) or after an idle timeout (60 minutes);
//   stop() closes the gate, ends the daemon and deletes session.js.
// - Note: Magpie's plugin host treats the return value of server() as an OpenCode hooks object and never calls stop();
//   the host calls process.exit() after Magpie closes its stdin. So what really runs is the synchronous exit safety net:
//   close the daemon's lifeline pipe and delete the session.js this host wrote.
// - No SIGINT/SIGTERM handlers (they would swallow the host's default termination behavior).

import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGate } from "./lib/gate.mjs";
import { NODE_TOO_OLD_MESSAGE, requireNode } from "./lib/pathscan.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 3488;
// Longest wait for the daemon's ready line (Windows cold start + antivirus scanning can be slow)
const READY_TIMEOUT_MS = 15000;
const BIND_RETRY_MS = 2000;
const SESSION_BEAT_MS = 4000;
// A port still busy after this many tries (~10 s) is worth a log line (see bindLoop)
const BUSY_LOG_AFTER = 5;
function bindDelayMs() {
  const v = Number(process.env.AGENT_CONSOLE_BIND_DELAY_MS);
  return Number.isFinite(v) && v >= 0 ? v : 1200;
}

// Paths are computed again inside server(): tests change environment variables after import
function paths() {
  const dataRoot = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const dataDir = join(dataRoot, "magpie", "agent-console");
  return {
    dataRoot,
    dataDir,
    logsDir: join(dataDir, "logs"),
    spawnLog: join(dataDir, "logs", "daemon-spawn.log"),
    daemonJson: join(dataDir, "daemon.json"),
    pageDir: process.env.AGENT_CONSOLE_PAGE_DIR || join(here, "page"),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ESRCH = gone; EPERM = exists but we may not signal it (common on Windows), counts as alive
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

// A failed log write (directory deleted, disk full) must never make the host's flow throw
function makeLogger(p) {
  return (message) => {
    try {
      mkdirSync(p.logsDir, { recursive: true });
      appendFileSync(p.spawnLog, `[${new Date().toISOString()}] ${message}\n`);
    } catch {}
  };
}

function readDaemonInfo(p) {
  try {
    return JSON.parse(readFileSync(p.daemonJson, "utf8"));
  } catch {
    return null;
  }
}

function ping(port, token) {
  return new Promise((resolve) => {
    const request = http.get(
      {
        host: "127.0.0.1",
        port,
        path: "/api/ping",
        headers: { "x-agent-console": token },
        timeout: 1500,
      },
      (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve(null);
          }
        });
      },
    );
    request.on("error", () => resolve(null));
    request.on("timeout", () => {
      request.destroy();
      resolve(null);
    });
  });
}

async function killPid(pid) {
  if (process.platform === "win32") {
    await new Promise((resolve) =>
      execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve()),
    );
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {}
  for (let i = 0; i < 20 && pidAlive(pid); i++) await sleep(100);
  if (pidAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}

// The 0.1.0 daemon was detached and may still hold 3488 after an upgrade.
// Only after it answered a ping with the token from daemon.json (confirming it really is our daemon, guarding against pid reuse)
// do we first shut it down gracefully via WS app.shutdown, then force-kill it if it's still there.
async function shutdownLegacy(info, log) {
  if (!info?.pid || !info?.port || !info?.token || !pidAlive(info.pid)) return;
  const answer = await ping(info.port, info.token);
  if (!answer?.ok || answer.pid !== info.pid) return;
  log(`stopping legacy daemon pid ${info.pid} on port ${info.port}`);
  try {
    const { WebSocket } = await import("ws");
    await new Promise((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${info.port}/ws`);
      const timer = setTimeout(() => {
        socket.terminate();
        resolve();
      }, 3000);
      socket.on("open", () => socket.send(JSON.stringify({ t: "hello", token: info.token, v: 1 })));
      socket.on("message", (data) => {
        let message;
        try {
          message = JSON.parse(String(data));
        } catch {
          return;
        }
        if (message.t === "hello.ok") {
          socket.send(JSON.stringify({ t: "req", id: 1, m: "app.shutdown", p: {} }));
        }
        if (message.t === "res" && message.id === 1) {
          clearTimeout(timer);
          socket.close();
          resolve();
        }
      });
      socket.on("error", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  } catch {}
  for (let i = 0; i < 30 && pidAlive(info.pid); i++) await sleep(100);
  if (pidAlive(info.pid)) await killPid(info.pid);
}

// session.js is a script file holding only the gate port (a number) and the gate key (hex); "<" is still escaped just in case.
// Any page that knows Magpie's page path can read it with <script src>, so the daemon token must never go here.
// ts: refreshed every SESSION_BEAT_MS while the gate is up. A host that is killed hard (Magpie restarting it, Windows) can't delete
// its session.js; boot.js treats one whose ts stopped moving as stale and waits for the new host's instead of opening a dead gate.
function writeSession(pageDir, port, key) {
  mkdirSync(pageDir, { recursive: true });
  const json = JSON.stringify({ v: 2, port, key, ts: Date.now() }).replace(/</g, "\\u003c");
  const temp = join(pageDir, `.session-${process.pid}-${randomBytes(4).toString("hex")}.tmp`);
  writeFileSync(temp, `globalThis.AgentConsoleSession = ${json};\n`, { mode: 0o600 });
  renameSync(temp, join(pageDir, "session.js"));
}

function removeSession(pageDir, key) {
  const sessionPath = join(pageDir, "session.js");
  try {
    // Another host may already have written its own session.js; delete only ours
    if (readFileSync(sessionPath, "utf8").includes(key)) unlinkSync(sessionPath);
  } catch {}
}

// Synchronous safety net when the host process exits (Magpie never calls stop(); this is the only cleanup that runs on a normal exit).
// The daemon also exits by itself when stdin closes / the parent disappears; this only speeds it up;
// on Windows child.kill() is a hard kill that leaves the daemon no time to end the Agent processes it started, so we only close the pipe.
// Also delete the session.js this host wrote so no stale key is left behind.
const liveChildren = new Set();
const liveSessions = new Map(); // pageDir -> key
let exitHookInstalled = false;
function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const [pageDir, key] of liveSessions) removeSession(pageDir, key);
    for (const child of liveChildren) {
      try {
        child.stdin?.destroy();
      } catch {}
      if (process.platform !== "win32") {
        try {
          child.kill("SIGTERM");
        } catch {}
      }
    }
  });
}

function createHost(port) {
  const p = paths();
  const log = makeLogger(p);
  // Gate key: written to session.js; even if leaked it only buys one navigation to the daemon
  const key = randomBytes(32).toString("hex");
  // Daemon token: given to the daemon only via an environment variable, and to the page via the 302's # fragment
  const token = randomBytes(32).toString("hex");
  let stopped = false;
  let child = null;
  let childPort = null;
  let starting = null;
  let legacyChecked = false;
  let wakeBindLoop = null;
  let beat = null;

  async function checkLegacyOnce() {
    if (legacyChecked) return;
    legacyChecked = true;
    const info = readDaemonInfo(p);
    if (info && (!child || info.pid !== child.pid)) await shutdownLegacy(info, log);
  }

  async function spawnDaemon() {
    await checkLegacyOnce();
    if (stopped) throw new Error("plugin host stopped");
    mkdirSync(p.logsDir, { recursive: true });
    let node;
    try {
      // Inside Magpie process.execPath is Bun; the daemon and node-pty need real Node
      node = requireNode();
    } catch (error) {
      log(`cannot spawn daemon: ${error.message} (PATH=${process.env.PATH ?? ""})`);
      throw error;
    }
    log(`spawning daemon with ${node}`);
    const stderrFd = openSync(p.spawnLog, "a");
    let spawned;
    try {
      spawned = spawn(
        node,
        [
          join(here, "daemon", "dist", "main.js"),
          "--port",
          "0",
          "--data",
          p.dataRoot,
          "--parent-pid",
          String(process.pid),
        ],
        {
          // The token goes through an environment variable, not the command line (command lines are visible to other users on the machine)
          env: { ...process.env, AGENT_CONSOLE_TOKEN: token },
          stdio: ["pipe", "pipe", stderrFd],
          windowsHide: true,
        },
      );
    } finally {
      closeSync(stderrFd);
    }
    child = spawned;
    childPort = null;
    liveChildren.add(spawned);
    installExitHook();

    return new Promise((resolve, reject) => {
      let settled = false;
      let stdoutBuffer = "";
      const finish = (error, port) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          // Failed start: clear the state so the next /open starts it again
          try {
            spawned.kill();
          } catch {}
          if (child === spawned) {
            child = null;
            childPort = null;
          }
          reject(error);
        } else {
          resolve(port);
        }
      };
      const timer = setTimeout(() => finish(new Error("daemon ready timeout")), READY_TIMEOUT_MS);

      // A spawn failure (ENOENT etc.) must not crash the Bun plugin host: log it and fail this /open
      spawned.on("error", (spawnError) => {
        log(`spawn error: ${spawnError}`);
        finish(spawnError);
      });
      spawned.stdin.on("error", () => {});
      // Keep reading stdout into the log so the pipe never fills up; the ready line may span chunks, so buffer and parse by line
      spawned.stdout.on("data", (chunk) => {
        const text = String(chunk);
        try {
          appendFileSync(p.spawnLog, text);
        } catch {}
        stdoutBuffer += text;
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) {
          let ready;
          try {
            ready = JSON.parse(line);
          } catch {
            continue;
          }
          if (ready?.agentConsoleReady && Number.isInteger(ready.port) && ready.port > 0) {
            if (child === spawned) childPort = ready.port;
            finish(null, ready.port);
          }
        }
      });
      spawned.once("exit", (code, signal) => {
        log(`daemon pid ${spawned.pid} exited (code ${code}, signal ${signal})`);
        liveChildren.delete(spawned);
        if (child === spawned) {
          child = null;
          childPort = null;
        }
        const error = new Error(`daemon exited before ready (code ${code})`);
        // The daemon uses exit code 3 for a Node version that's too old
        if (code === 3) error.userMessage = NODE_TOO_OLD_MESSAGE;
        finish(error);
      });
    });
  }

  // Called on every gate /open: reuse the child if it's alive, start one only if not; concurrent calls share one start
  async function ensureDaemon() {
    if (stopped) throw new Error("plugin host stopped");
    if (child && child.exitCode === null && child.signalCode === null && childPort) {
      return { port: childPort };
    }
    if (!starting) {
      starting = spawnDaemon().finally(() => {
        starting = null;
      });
    }
    return { port: await starting };
  }

  const gate = createGate({ port, key, token, ensureDaemon });

  function waitForRetry() {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, BIND_RETRY_MS);
      wakeBindLoop = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  async function bindLoop() {
    const loggedCodes = new Set();
    let busyTries = 0;
    // B16: every `magpie` CLI command starts a short-lived plugin host that calls server() too. Waiting a moment before binding
    // means such a host usually exits before it takes the gate or writes session.js, and a port held by the long-lived host
    // (EADDRINUSE) is only logged once it has stayed busy for a while, not once per CLI command.
    const delay = bindDelayMs();
    if (delay > 0) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, delay);
        wakeBindLoop = () => { clearTimeout(timer); resolve(); };
      });
    }
    while (!stopped) {
      try {
        await gate.listen();
      } catch (error) {
        const code = error?.code || String(error);
        if (code === "EADDRINUSE") busyTries++;
        const quiet = code === "EADDRINUSE" && busyTries < BUSY_LOG_AFTER;
        if (!quiet && !loggedCodes.has(code)) {
          loggedCodes.add(code);
          log(`gate port ${port} bind failed (${code}); retrying every ${BIND_RETRY_MS / 1000}s`);
        }
        // Port in use: if a detached 0.1.0 daemon is holding it, confirm its identity and shut it down
        if (code === "EADDRINUSE" && !legacyChecked) {
          const info = readDaemonInfo(p);
          if (info?.port === port) await checkLegacyOnce();
        }
        if (stopped) return;
        await waitForRetry();
        continue;
      }
      // stop() may be called while listen is in progress: close immediately and don't write session.js
      if (stopped) {
        await gate.close();
        return;
      }
      try {
        writeSession(p.pageDir, port, key);
        liveSessions.set(p.pageDir, key);
        installExitHook();
        log(`gate listening on 127.0.0.1:${port}; session.js written`);
      } catch (error) {
        log(`writing session.js failed: ${error}`);
      }
      beat = setInterval(() => {
        if (stopped) return;
        // Only while session.js is still ours (another host may have taken over the page directory)
        try {
          const cur = readFileSync(join(p.pageDir, "session.js"), "utf8");
          if (cur.includes(key)) writeSession(p.pageDir, port, key);
        } catch { /* deleted or unreadable: leave it */ }
      }, SESSION_BEAT_MS);
      beat.unref?.();
      return;
    }
  }

  const binding = bindLoop().catch((error) => log(`gate failed: ${error}`));

  async function stopDaemon() {
    const current = child;
    if (!current) return;
    // Close the lifeline first so the daemon exits gracefully (ending the Agent processes it started); force-kill after a timeout
    try {
      current.stdin.end();
    } catch {}
    for (let i = 0; i < 30 && current.exitCode === null && current.signalCode === null; i++) await sleep(100);
    if (current.exitCode === null && current.signalCode === null && current.pid) {
      await killPid(current.pid);
    }
  }

  async function stop() {
    stopped = true;
    if (beat) clearInterval(beat);
    wakeBindLoop?.();
    await binding;
    await gate.close();
    if (starting) await starting.catch(() => {});
    await stopDaemon();
    removeSession(p.pageDir, key);
    if (liveSessions.get(p.pageDir) === key) liveSessions.delete(p.pageDir);
  }

  return { stop };
}

async function server(_input, options) {
  const requested = Number(options?.port) || Number(process.env.AGENT_CONSOLE_PORT) || DEFAULT_PORT;
  const port = Number.isInteger(requested) && requested > 0 && requested <= 65535 ? requested : DEFAULT_PORT;
  return createHost(port);
}

export default { id: "agent-console", server };
