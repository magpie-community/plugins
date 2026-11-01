// frp-connect: build an frpc.toml from plugin options, locate frpc, and supervise it.
// frpc for Windows is bundled in ./bin; other platforms are downloaded on first use.

import { spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { tool } from "@opencode-ai/plugin";

const FRPC_VERSION = "0.71.1";
const FRPC_DOWNLOAD_BASE = "https://github.com/fatedier/frp/releases/download";
const pluginDir = import.meta.dir;
let logTimer: ReturnType<typeof setInterval> | null = null;

type FrpcState = {
  mode: "download" | "local";
  path: string | null;
  source: string | null;
  version: string | null;
};

let frpcState: FrpcState = {
  mode: "download",
  path: null,
  source: null,
  version: null,
};

let downloadState: {
  state: "downloading" | "extracting" | "done" | "error";
  percent: number;
  url?: string;
  dest?: string;
  error?: string;
} | null = null;

type Proxy = {
  name?: string;
  type?: string;
  localIP?: string;
  localPort?: number | string;
  remotePort?: number | string;
  customDomains?: string;
  subdomain?: string;
};

type Options = {
  frpcPath?: string;
  frpcVersion?: string;
  frpcDownloadBase?: string;
  frpcMode?: "download" | "local";
  configMode?: "form" | "toml";
  frpcToml?: string;
  requestAction?: { action?: string; nonce?: number };
  autoConnect?: boolean;
  serverAddr?: string;
  serverPort?: number | string;
  authMethod?: string;
  authToken?: string;
  transport?: string;
  proxies?: Proxy[];
};

type Config = {
  frpcPath?: string;
  frpcVersion: string;
  frpcDownloadBase: string;
  frpcMode: "download" | "local";
  configMode: "form" | "toml";
  frpcToml?: string;
  serverAddr?: string;
  serverPort?: number | string;
  authMethod?: string;
  authToken?: string;
  transport?: string;
  proxies: Proxy[];
};

type Paths = {
  dir: string;
  toml: string;
  log: string;
  pid: string;
  meta: string;
};

const CONFIG_MISSING =
  "FRP is not configured. Fill in the FRP Connect config page, or run " +
  "`magpie plugin options frp-connect '{...}'` first.";

function normalize(options: unknown): Config {
  const o = (options ?? {}) as Options;
  return {
    frpcPath:
      typeof o.frpcPath === "string" && o.frpcPath.trim()
        ? o.frpcPath.trim()
        : undefined,
    frpcVersion:
      typeof o.frpcVersion === "string" && o.frpcVersion.trim()
        ? o.frpcVersion.trim()
        : FRPC_VERSION,
    frpcDownloadBase:
      typeof o.frpcDownloadBase === "string" && o.frpcDownloadBase.trim()
        ? o.frpcDownloadBase.trim()
        : FRPC_DOWNLOAD_BASE,
    frpcMode: o.frpcMode === "local" ? "local" : "download",
    configMode: o.configMode === "toml" ? "toml" : "form",
    frpcToml: typeof o.frpcToml === "string" ? o.frpcToml : "",
    serverAddr:
      typeof o.serverAddr === "string" && o.serverAddr.trim()
        ? o.serverAddr.trim()
        : undefined,
    serverPort: o.serverPort ?? 7000,
    authMethod: typeof o.authMethod === "string" ? o.authMethod : "token",
    authToken: typeof o.authToken === "string" ? o.authToken : "",
    transport: typeof o.transport === "string" ? o.transport : "",
    proxies: Array.isArray(o.proxies) ? o.proxies : [],
  };
}

function stateDir(input: any): string {
  const base =
    (typeof input?.directory === "string" && input.directory) ||
    (typeof input?.worktree === "string" && input.worktree) ||
    path.join(os.homedir(), ".config", "magpie");
  return path.join(base, "frp-connect");
}

function quote(value: string | number): string {
  if (typeof value === "number") return String(value);
  return JSON.stringify(String(value));
}

function parsePort(value: number | string | undefined): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n =
    typeof value === "number" ? value : Number.parseInt(String(value), 10);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

function splitDomains(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function buildToml(cfg: Config): string {
  const lines: string[] = [];
  lines.push(`serverAddr = ${quote(cfg.serverAddr ?? "")}`);
  lines.push(`serverPort = ${quote(parsePort(cfg.serverPort) ?? 7000)}`);
  lines.push("loginFailExit = false");
  if (cfg.authToken) {
    lines.push(`auth.method = ${quote(cfg.authMethod || "token")}`);
    lines.push(`auth.token = ${quote(cfg.authToken)}`);
  }
  if (cfg.transport && cfg.transport !== "tcp") {
    lines.push(`transport.protocol = ${quote(cfg.transport)}`);
  }
  lines.push("");

  for (const raw of cfg.proxies) {
    const name = (raw.name ?? "").trim();
    const type = (raw.type ?? "tcp").trim();
    const localPort = parsePort(raw.localPort);
    if (!name || !type || localPort === null) continue;

    lines.push("[[proxies]]");
    lines.push(`name = ${quote(name)}`);
    lines.push(`type = ${quote(type)}`);
    lines.push(`localIP = ${quote(raw.localIP?.trim() || "127.0.0.1")}`);
    lines.push(`localPort = ${quote(localPort)}`);

    if (type === "http" || type === "https") {
      const subdomain = (raw.subdomain ?? "").trim();
      const domains = splitDomains(raw.customDomains);
      if (subdomain) lines.push(`subdomain = ${quote(subdomain)}`);
      if (domains.length) {
        lines.push(`customDomains = [${domains.map((d) => quote(d)).join(", ")}]`);
      }
    } else {
      const remotePort = parsePort(raw.remotePort);
      if (remotePort !== null) lines.push(`remotePort = ${quote(remotePort)}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}

type Validate =
  | { ok: true; toml: string }
  | { ok: false; error: string };

function validate(cfg: Config): Validate {
  if (cfg.configMode === "toml") {
    const toml = (cfg.frpcToml ?? "").trim();
    if (!toml) {
      return { ok: false, error: "paste your frpc.toml, or switch back to form mode." };
    }
    return { ok: true, toml: toml.endsWith("\n") ? toml : toml + "\n" };
  }

  if (!cfg.serverAddr) return { ok: false, error: CONFIG_MISSING };
  if (parsePort(cfg.serverPort) === null) {
    return { ok: false, error: "serverPort must be a valid port (1-65535)." };
  }
  const hasProxy = cfg.proxies.some(
    (p) =>
      (p.name ?? "").trim() &&
      (p.type ?? "tcp").trim() &&
      parsePort(p.localPort) !== null,
  );
  if (!hasProxy) {
    return {
      ok: false,
      error: "add at least one valid proxy (name, type and localPort are required).",
    };
  }
  return { ok: true, toml: buildToml(cfg) };
}

function hash(str: string): string {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36) + "-" + str.length;
}

function ensureDir(dir: string) {
  mkdirSync(dir, { recursive: true });
}

function pidAlive(pid: number | null | undefined): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readMeta(metaPath: string): Record<string, any> | null {
  try {
    const parsed = JSON.parse(readFileSync(metaPath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function trackedPid(pidPath: string, metaPath: string): number | null {
  const state = readMeta(metaPath);
  if (typeof state?.pid === "number") return state.pid;
  try {
    const n = Number.parseInt(readFileSync(pidPath, "utf8"), 10);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function writeState(paths: Paths, patch: Record<string, any>) {
  ensureDir(paths.dir);
  const current = readMeta(paths.meta) ?? {};
  const next = { ...current, ...patch };
  writeFileSync(paths.meta, JSON.stringify(next, null, 2), "utf8");
  if (typeof next.pid === "number") {
    writeFileSync(paths.pid, String(next.pid), "utf8");
  }
}

function clearState(paths: Paths) {
  ensureDir(paths.dir);
  const current = readMeta(paths.meta) ?? {};
  const next: Record<string, any> = {
    lastActionNonce: current.lastActionNonce,
    lastAction: current.lastAction,
    stoppedAt: new Date().toISOString(),
  };
  writeFileSync(paths.meta, JSON.stringify(next, null, 2), "utf8");
  try {
    writeFileSync(paths.pid, "", "utf8");
  } catch {
    // ignore
  }
}

function logTail(logPath: string, maxChars = 4000): string {
  try {
    const text = readFileSync(logPath, "utf8");
    return text.length <= maxChars ? text : text.slice(-maxChars);
  } catch {
    return "";
  }
}

function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function writeLogSnapshot(paths: Paths) {
  const current = statusFrpc(paths);
  const state = readMeta(paths.meta);
  const snapshot = {
    at: Date.now(),
    running: current.running,
    pid: current.pid,
    logPath: paths.log,
    tail: logTail(paths.log, 20000),
    lastAction: state?.lastAction ?? null,
    frpc: frpcState,
    download: downloadState,
  };
  try {
    writeFileSync(
      path.join(pluginDir, "page", "_log.js"),
      `window.__FRP_LOG__ = ${safeJson(snapshot)};\n`,
      "utf8",
    );
  } catch {
    // Installed plugins may have a read-only folder; the `logs` tool still works.
  }
}

function statusFrpc(paths: Paths) {
  const state = readMeta(paths.meta);
  const pid = trackedPid(paths.pid, paths.meta);
  const running = pidAlive(pid);
  return {
    running,
    pid: running ? pid : null,
    configHash: state?.configHash ?? null,
    startedAt: state?.startedAt ?? null,
  };
}

type RunResult = {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: string;
};

function runCommand(
  command: string,
  args: string[],
  timeoutMs = 15000,
): Promise<RunResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (e) {
      resolve({
        ok: false,
        exitCode: null,
        stdout: "",
        stderr: "",
        error: (e as Error).message,
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (
      ok: boolean,
      exitCode: number | null,
      stdout: string,
      stderr: string,
      error?: string,
    ) => {
      if (done) return;
      done = true;
      resolve({ ok, exitCode, stdout, stderr, error });
    };

    child.stdout?.on("data", (d) => {
      stdout += d;
    });
    child.stderr?.on("data", (d) => {
      stderr += d;
    });
    child.on("error", (e) => finish(false, null, stdout, stderr, (e as Error).message));
    child.on("close", (code) => finish(code === 0, code, stdout, stderr));

    setTimeout(() => {
      if (done) return;
      try {
        child.kill();
      } catch {
        // ignore
      }
      finish(false, null, stdout, stderr, "timed out");
    }, timeoutMs);
  });
}

type Asset = {
  os: "windows" | "darwin" | "linux";
  arch: "amd64" | "arm64" | "arm";
  ext: "zip" | "tar.gz";
  bin: string;
};

function frpAsset(
  platform: string = process.platform,
  arch: string = process.arch,
): Asset | null {
  const a =
    arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : arch === "arm" ? "arm" : null;
  const osName =
    platform === "win32" ? "windows" : platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : null;
  if (!a || !osName) return null;
  return {
    os: osName,
    arch: a,
    ext: osName === "windows" ? "zip" : "tar.gz",
    bin: osName === "windows" ? "frpc.exe" : "frpc",
  };
}

function bundledBinary(): string | null {
  const asset = frpAsset();
  if (!asset) return null;
  const name =
    asset.os === "windows"
      ? `frpc-windows-${asset.arch}.exe`
      : `frpc-${asset.os}-${asset.arch}`;
  const p = path.join(pluginDir, "bin", name);
  return existsSync(p) ? p : null;
}

async function resolveFrpcVersion(cfg: Config): Promise<string> {
  const wanted = (cfg.frpcVersion || FRPC_VERSION).trim();
  if (wanted && wanted !== "latest") return wanted;
  try {
    const resp = await fetch(
      "https://api.github.com/repos/fatedier/frp/releases/latest",
      { headers: { "user-agent": "frp-connect" } },
    );
    if (resp.ok) {
      const data = (await resp.json()) as { tag_name?: string };
      const tag = data.tag_name?.replace(/^v/, "");
      if (tag) return tag;
    }
  } catch {
    // fall back to the pinned version below
  }
  return FRPC_VERSION;
}

async function downloadFrpc(cfg: Config, paths: Paths): Promise<string> {
  const asset = frpAsset();
  if (!asset) {
    throw new Error(
      `unsupported platform/arch: ${process.platform}/${process.arch}; set frpcPath to your frpc binary.`,
    );
  }

  const version = await resolveFrpcVersion(cfg);
  const name = `frp_${version}_${asset.os}_${asset.arch}.${asset.ext}`;
  const url = `${cfg.frpcDownloadBase.replace(/\/+$/, "")}/v${version}/${name}`;
  const work = path.join(paths.dir, "download", `${asset.os}_${asset.arch}`);
  ensureDir(work);
  const archive = path.join(work, name);
  const dest = path.join(paths.dir, "bin", asset.bin);

  downloadState = { state: "downloading", percent: 0, url };

  const resp = await fetch(url, { redirect: "follow" });
  if (!resp.ok) {
    downloadState = { state: "error", percent: 0, url, error: `HTTP ${resp.status}` };
    throw new Error(`failed to download frpc (HTTP ${resp.status}): ${url}`);
  }

  const total = Number(resp.headers.get("content-length") || 0);
  const reader = resp.body?.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      if (total > 0) {
        downloadState = {
          state: "downloading",
          percent: Math.round((received / total) * 100),
          url,
        };
      }
    }
  }
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  writeFileSync(archive, buf);

  downloadState = { state: "extracting", percent: 100, url };
  const tar = await runCommand("tar", ["-xf", archive, "-C", work], 120000);
  if (!tar.ok) {
    downloadState = { state: "error", percent: 100, url, error: tar.stderr || tar.error };
    throw new Error(`failed to extract ${name}: ${tar.stderr || tar.error}`);
  }

  const extracted = path.join(
    work,
    `frp_${version}_${asset.os}_${asset.arch}`,
    asset.bin,
  );
  if (!existsSync(extracted)) {
    throw new Error(`frpc binary not found after extracting ${name}`);
  }

  ensureDir(path.dirname(dest));
  copyFileSync(extracted, dest);
  if (asset.os !== "windows") chmodSync(dest, 0o755);
  downloadState = { state: "done", percent: 100, url, dest };
  return dest;
}

async function ensureFrpc(cfg: Config, paths: Paths): Promise<string> {
  if (cfg.frpcMode === "local") {
    const p = cfg.frpcPath || "frpc";
    frpcState = { mode: "local", path: p, source: "local", version: null };
    downloadState = null;
    return p;
  }

  const bundled = bundledBinary();
  if (bundled) {
    frpcState = { mode: "download", path: bundled, source: "bundled", version: null };
    downloadState = null;
    return bundled;
  }

  const asset = frpAsset();
  if (asset) {
    const cached = path.join(paths.dir, "bin", asset.bin);
    if (existsSync(cached)) {
      frpcState = { mode: "download", path: cached, source: "downloaded", version: null };
      downloadState = null;
      return cached;
    }
  }

  const p = await downloadFrpc(cfg, paths);
  frpcState = { mode: "download", path: p, source: "downloaded", version: null };
  return p;
}

async function startFrpc(
  frpcPath: string,
  toml: string,
  paths: Paths,
) {
  ensureDir(paths.dir);
  writeFileSync(paths.toml, toml, "utf8");

  const logFd = openSync(paths.log, "a");
  const child = spawn(frpcPath, ["-c", paths.toml], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    windowsHide: true,
    env: { ...process.env },
  });

  const spawnError = await new Promise<string | null>((resolve) => {
    let settled = false;
    child.once("error", (e) => {
      if (!settled) {
        settled = true;
        resolve((e as Error).message);
      }
    });
    child.once("spawn", () => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    });
    setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    }, 2000);
  });

  if (spawnError) {
    throw new Error(`failed to start frpc (${frpcPath}): ${spawnError}`);
  }

  child.unref();
  const pid = typeof child.pid === "number" ? child.pid : null;
  const startedAt = new Date().toISOString();
  writeState(paths, { pid, configHash: hash(toml), startedAt });

  await new Promise((r) => setTimeout(r, 700));
  const alive = pidAlive(pid);
  return {
    started: alive,
    pid,
    frpcPath,
    startedAt,
    configPath: paths.toml,
    logTail: alive ? undefined : logTail(paths.log),
    hint: alive
      ? undefined
      : "frpc exited right after starting; check logTail and the generated config.",
  };
}

function stopFrpc(paths: Paths) {
  const pid = trackedPid(paths.pid, paths.meta);
  const wasAlive = pidAlive(pid);
  if (wasAlive && pid) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // ignore
    }
  }
  clearState(paths);
  return { stopped: wasAlive, pid: wasAlive ? pid : null };
}

async function ensureRunning(cfg: Config, paths: Paths) {
  const validated = validate(cfg);
  if (!validated.ok) throw new Error(validated.error);

  const current = statusFrpc(paths);
  const sameConfig = current.configHash === hash(validated.toml);
  if (current.running && sameConfig) {
    return { alreadyRunning: true, ...current };
  }
  if (current.running) stopFrpc(paths);

  const frpcPath = await ensureFrpc(cfg, paths);
  return await startFrpc(frpcPath, validated.toml, paths);
}

async function executeAction(
  action: string,
  base: Config,
  paths: Paths,
): Promise<Record<string, any>> {
  switch (action) {
    case "start":
      return await ensureRunning(base, paths);
    case "stop":
      return stopFrpc(paths);
    case "restart":
      stopFrpc(paths);
      return await ensureRunning(base, paths);
    case "verify": {
      const validated = validate(base);
      if (!validated.ok) throw new Error(validated.error);
      ensureDir(paths.dir);
      writeFileSync(paths.toml, validated.toml, "utf8");
      const frpcPath = await ensureFrpc(base, paths);
      const result = await runCommand(
        frpcPath,
        ["verify", "-c", paths.toml],
        15000,
      );
      return {
        ok: result.ok,
        frpcPath,
        stdout: result.stdout.trim(),
        stderr: result.stderr.trim(),
        error: result.error,
      };
    }
    default:
      throw new Error(`unknown action: ${action}`);
  }
}

export const FrpConnect = async (input: unknown, options: unknown) => {
  const dir = stateDir(input);
  const base = normalize(options);
  const autoConnect = (options as Options)?.autoConnect === true;

  const paths: Paths = {
    dir,
    toml: path.join(dir, "frpc.toml"),
    log: path.join(dir, "frpc.log"),
    pid: path.join(dir, "frpc.pid"),
    meta: path.join(dir, "frpc.json"),
  };

  writeLogSnapshot(paths);
  if (logTimer) clearInterval(logTimer);
  logTimer = setInterval(() => writeLogSnapshot(paths), 3000);

  const request = (options as Options)?.requestAction;
  if (request && request.action && typeof request.nonce === "number") {
    const state = readMeta(paths.meta);
    if (state?.lastActionNonce !== request.nonce) {
      const at = new Date().toISOString();
      let record: Record<string, any>;
      try {
        const result = await executeAction(request.action, base, paths);
        record = { action: request.action, at, result };
      } catch (e) {
        record = { action: request.action, at, error: (e as Error).message };
      }
      writeState(paths, { lastActionNonce: request.nonce, lastAction: record });
      writeLogSnapshot(paths);
    }
  }

  if (autoConnect) {
    try {
      await ensureRunning(base, paths);
    } catch (e) {
      console.error(`[frp-connect] auto-connect failed: ${(e as Error).message}`);
    }
  }

  return {
    tool: {
      install: tool({
        description:
          "Ensure frpc is available (downloaded or local) and report its path and version.",
        async execute() {
          const frpcPath = await ensureFrpc(base, paths);
          const version = await runCommand(frpcPath, ["-v"], 5000);
          frpcState = {
            ...frpcState,
            path: frpcPath,
            version: version.ok ? version.stdout.trim() : null,
          };
          writeLogSnapshot(paths);
          return {
            frpcPath,
            version: version.ok ? version.stdout.trim() : null,
            error: version.error,
            source: frpcState.source,
          };
        },
      }),
      start: tool({
        description:
          "Start (or restart with the current config) frpc to connect to the FRP server.",
        async execute() {
          return await ensureRunning(base, paths);
        },
      }),
      stop: tool({
        description: "Stop the running frpc process and disconnect from FRP.",
        async execute() {
          return stopFrpc(paths);
        },
      }),
      restart: tool({
        description: "Stop and start frpc to apply the latest config.",
        async execute() {
          stopFrpc(paths);
          return await ensureRunning(base, paths);
        },
      }),
      status: tool({
        description: "Report whether frpc is running and its PID.",
        async execute() {
          return { ...statusFrpc(paths), logPath: paths.log };
        },
      }),
      logs: tool({
        description: "Return the frpc log path and the latest log lines.",
        async execute() {
          return { logPath: paths.log, tail: logTail(paths.log) };
        },
      }),
      generate: tool({
        description: "Show the frpc.toml generated from the current plugin config.",
        async execute() {
          const validated = validate(base);
          if (!validated.ok) throw new Error(validated.error);
          ensureDir(paths.dir);
          writeFileSync(paths.toml, validated.toml, "utf8");
          return { configPath: paths.toml, toml: validated.toml };
        },
      }),
      verify: tool({
        description: "Validate the generated frpc config with `frpc verify -c`.",
        async execute() {
          const validated = validate(base);
          if (!validated.ok) throw new Error(validated.error);
          ensureDir(paths.dir);
          writeFileSync(paths.toml, validated.toml, "utf8");
          const frpcPath = await ensureFrpc(base, paths);
          const result = await runCommand(
            frpcPath,
            ["verify", "-c", paths.toml],
            15000,
          );
          return {
            ok: result.ok,
            frpcPath,
            exitCode: result.exitCode,
            stdout: result.stdout.trim(),
            stderr: result.stderr.trim(),
            error: result.error,
          };
        },
      }),
    },
  };
};
