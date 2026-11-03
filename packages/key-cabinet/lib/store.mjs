import { open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { pluginDataDir } from "./paths.mjs";

function storePath() {
  return join(pluginDataDir(), "projects.json");
}

function lockPath() {
  return storePath() + ".lock";
}

function empty() {
  return { version: 1, projects: [] };
}

export async function loadStore() {
  try {
    const raw = JSON.parse(await readFile(storePath(), "utf8"));
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.projects)) {
      throw new Error("钥匙柜数据格式无效，请检查 projects.json");
    }
    return { version: 1, projects: raw.projects };
  } catch (e) {
    if (e.code === "ENOENT") return empty();
    throw e;
  }
}

async function syncDir(dir) {
  let handle;
  try {
    handle = await open(dir, "r");
    await handle.sync();
  } catch {
    // 有些平台不允许对目录 fsync；尽力而为。
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

export async function saveStore(store) {
  const next = {
    version: 1,
    projects: Array.isArray(store.projects) ? store.projects : [],
  };
  const path = storePath();
  const temporary = `${path}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(JSON.stringify(next, null, 2) + "\n", "utf8");
    // 先落盘再 rename：断电时不会出现「Magpie 里有 Key、本地映射没了」的孤儿。
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    await syncDir(dirname(path));
  } finally {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporary).catch((e) => { if (e.code !== "ENOENT") throw e; });
  }
  return next;
}

/**
 * Cross-process lock for projects.json, so two plugin processes (or QA next to a
 * live instance) cannot read-modify-write the same file.
 *
 * The lock file holds "<pid> <owner-token>". A lock is broken only when its pid
 * is dead (or when the content is unreadable and old); a live holder is never
 * broken just because the operation is slow. Releasing also checks ownership,
 * so a process that lost its lock cannot delete the new holder's lock.
 */
export async function withStoreLock(operation, { timeoutMs = 30_000, staleMs = 60_000 } = {}) {
  const path = lockPath();
  const owner = `${process.pid} ${randomUUID()}`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await writeFile(path, owner, { encoding: "utf8", mode: 0o600, flag: "wx" });
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const stale = await staleLockContent(path, staleMs);
      if (stale != null) {
        // 只删除确认过的旧内容；内容变了说明别人刚接手，不能动。
        await removeIfUnchanged(path, stale);
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error("钥匙柜数据正被另一个进程修改，请稍后重试");
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  }
  try {
    return await operation();
  } finally {
    await removeIfUnchanged(path, owner);
  }
}

async function readLockFile(path) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/** Returns the file's content when it is safe to break, otherwise null. */
async function staleLockContent(path, staleMs) {
  const content = await readLockFile(path);
  if (content == null) return null; // 已经被别人清掉了，下一轮直接抢
  const info = await stat(path).catch(() => null);
  if (!info) return null;
  const pid = Number(content.trim().split(/\s+/)[0]);
  if (Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(pid, 0);
      // 持有者还活着：哪怕 mtime 很旧也不强拆，宁可等到 timeout。
      return null;
    } catch (e) {
      if (e.code === "ESRCH") return content;
      return null; // EPERM 等：当作还活着
    }
  }
  // 内容不可解析（旧版本/被截断）时才用时间兜底。
  return Date.now() - info.mtimeMs > staleMs ? content : null;
}

async function removeIfUnchanged(path, expected) {
  const current = await readLockFile(path);
  if (current !== expected) return false;
  try {
    await unlink(path);
    return true;
  } catch {
    return false;
  }
}

export function slugify(s) {
  // Keep ASCII slug for key names; CJK names need a manual slug in the UI.
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9\-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function keyNameFor(slug) {
  return `project:${slug}`;
}
