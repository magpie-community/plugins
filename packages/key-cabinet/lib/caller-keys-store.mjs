import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { magpieConfigDir } from "./paths.mjs";
import { mutateKeysFile, readKeysFileLimits } from "./caller-keys-core.mjs";
import { openLibc } from "./libc-flock.mjs";

const HELPER = join(dirname(fileURLToPath(import.meta.url)), "caller-key-off-bun.mjs");

function keysPath() {
  return join(magpieConfigDir(), "caller-keys.json");
}

function lockPath() {
  return keysPath() + ".lock";
}

function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

function magpieBun() {
  // Prefer Magpie's cached Bun (same runtime as plugin host). The cache path is
  // versioned by Magpie's bundle, so read state.json instead of pinning a version.
  const base = join(process.env.HOME || homedir(), ".cache", "magpie", "bun");
  try {
    const current = JSON.parse(readFileSync(join(base, "state.json"), "utf8"))?.current;
    if (current) {
      const candidate = join(base, String(current), "magpie-bun");
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    /* fall through */
  }
  try {
    const versions = readdirSync(base)
      .filter((v) => /^\d+\.\d+\.\d+$/.test(v))
      .sort(compareVersions)
      .reverse();
    for (const version of versions) {
      const candidate = join(base, version, "magpie-bun");
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    /* fall through */
  }
  if (typeof Bun !== "undefined" && typeof process.execPath === "string") {
    return process.execPath;
  }
  return "bun";
}

/**
 * Magpie locks caller-keys.json with flock on `<path>.lock`.
 * Pure JS via Bun FFI (plugin host is Bun). Under plain Node (QA / tests),
 * spawn Magpie's Bun for the same critical section — still JS, no Python.
 * Never prints secrets — only id / off / error.
 */
export async function setCallerKeyOff(id, off) {
  const want = String(id || "").trim();
  if (!want) throw new Error("缺少 Key id");
  if (typeof Bun !== "undefined") {
    return setWithBunFfi(want, Boolean(off));
  }
  return setViaBunSubprocess(want, Boolean(off));
}

/** Best-effort limits view for the editor; writes still go through the Magpie CLI. */
export function getCallerKeyLimits(id) {
  const want = String(id || "").trim();
  if (!want) throw new Error("缺少 Key id");
  return readKeysFileLimits(keysPath(), want);
}

async function setWithBunFfi(id, off) {
  const libc = await openLibc();
  const LOCK_EX = 2;
  const LOCK_NB = 4;
  const LOCK_UN = 8;

  const lf = await open(lockPath(), "a+");
  try {
    // 非阻塞加锁 + 超时：直接 flock(LOCK_EX) 会把 Bun 主线程（整个插件服务）
    // 挂住，直到别人放锁；锁被僵死进程占着时更是无限期。
    const deadline = Date.now() + 5000;
    for (;;) {
      if (libc.symbols.flock(lf.fd, LOCK_EX | LOCK_NB) === 0) break;
      if (Date.now() > deadline) {
        throw new Error("无法锁定 Magpie caller-keys.json（其它进程正在写入，请稍后重试）");
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    try {
      return await mutateKeysFile(keysPath(), id, off);
    } finally {
      libc.symbols.flock(lf.fd, LOCK_UN);
    }
  } finally {
    await lf.close();
  }
}

function setViaBunSubprocess(id, off) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      magpieBun(),
      [HELPER, String(id), off ? "1" : "0", keysPath()],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("切换钥匙状态超时"));
    }, 8000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => {
      stdout += c;
    });
    child.stderr.on("data", (c) => {
      stderr += c;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      let parsed = null;
      try {
        parsed = JSON.parse(String(stdout || "").trim() || "{}");
      } catch {
        /* ignore */
      }
      if (code === 0 && parsed?.ok) {
        resolve({ id: parsed.id, off: Boolean(parsed.off) });
        return;
      }
      const msg = parsed?.error || stderr.trim() || stdout.trim() || `切换失败 (exit ${code})`;
      reject(new Error(msg));
    });
  });
}
