// The frpc this plugin started, kept in sight: started as its child (not
// detached, so it goes when the host does), stopped only when it is the
// very process recorded, and its log read back for the page.

import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const LOG_MAX = 256 * 1024;
const TAIL = 64 * 1024;

// record is what is kept in frpc.json about the run: which process it is,
// so a PID reused by another program after a reboot is never signalled.
function read(file) {
  try {
    const r = JSON.parse(fs.readFileSync(file, "utf8"));
    return r && typeof r === "object" ? r : null;
  } catch {
    return null;
  }
}

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

// cmdline is a process's command line as the system keeps it, or null
// where it can't be read.
export function cmdline(pid) {
  try {
    if (process.platform === "linux") {
      return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ");
    }
    if (process.platform === "darwin") {
      return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim() || null;
    }
  } catch {
    return null;
  }
  return null;
}

// running is whether the recorded frpc is still the process in pid: on
// Linux and macOS its command line names our config file; elsewhere, and
// where the command line can't be read, a live PID is taken as it.
export function running(rec) {
  if (!rec || typeof rec.pid !== "number" || rec.pid <= 0) return false;
  try {
    process.kill(rec.pid, 0);
  } catch {
    return false;
  }
  const line = cmdline(rec.pid);
  if (line === null) return true;
  if (!rec.toml) return false;
  return line.includes(rec.toml) || (rec.exe && line.includes(path.basename(rec.exe)));
}

// state is what the page and the tools are answered: whether frpc runs,
// which one, and its last lines.
export function state(paths) {
  const rec = read(paths.record);
  const up = running(rec);
  return {
    running: up,
    pid: up ? rec.pid : null,
    version: rec?.version ?? null,
    frpcPath: rec?.exe ?? null,
    configPath: paths.toml,
    logPath: paths.log,
    startedAt: up ? rec.startedAt ?? null : null,
    configHash: up ? rec.configHash ?? null : null,
  };
}

// tail is the end of frpc's log, newest last.
export function tail(file, max = TAIL) {
  try {
    const buf = fs.readFileSync(file);
    return buf.subarray(Math.max(0, buf.length - max)).toString("utf8");
  } catch {
    return "";
  }
}

// clear empties the log before a start, so it reads as this run's.
function reset(file) {
  try {
    if (fs.statSync(file).size > LOG_MAX) fs.truncateSync(file, 0);
  } catch {
    // no log yet
  }
}

// start runs frpc on the frpc.toml at paths.toml, as a child of this
// process: it ends with the host, and nothing of it is detached.
export function start(paths, frpcPath, { version = null, hash = null } = {}) {
  fs.mkdirSync(paths.dir, { recursive: true });
  reset(paths.log);
  const log = fs.openSync(paths.log, "a");
  let child;
  try {
    child = spawn(frpcPath, ["-c", paths.toml], {
      detached: false,
      stdio: ["ignore", log, log],
      windowsHide: true,
    });
  } finally {
    fs.closeSync(log);
  }
  const rec = {
    pid: child.pid ?? null,
    exe: frpcPath,
    toml: paths.toml,
    version,
    configHash: hash,
    startedAt: new Date().toISOString(),
  };
  write(paths.record, rec);
  const exited = new Promise((resolve) => {
    child.once("error", (e) => resolve({ error: e.message }));
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return { child, record: rec, exited };
}

// stop ends the recorded frpc, and only it: a PID whose command line is
// no longer ours (a reboot, another program's) is left alone.
export function stop(paths) {
  const rec = read(paths.record);
  const up = running(rec);
  if (up) {
    try {
      process.kill(rec.pid, "SIGTERM");
    } catch {
      // gone in between
    }
  }
  fs.rmSync(paths.record, { force: true });
  return { stopped: up, pid: up ? rec.pid : null };
}

// forget removes the record of a run that ended on its own.
export function forget(paths, pid) {
  const rec = read(paths.record);
  if (rec && rec.pid === pid) fs.rmSync(paths.record, { force: true });
}

// hash is a config's identity, so a start with the same one is left be.
export function hash(text) {
  return crypto.createHash("sha256").update(String(text ?? "")).digest("hex").slice(0, 16);
}
