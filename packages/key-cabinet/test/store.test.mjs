import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keyNameFor, loadStore, saveStore, slugify, withStoreLock } from "../lib/store.mjs";

test("slugify normalizes names", () => {
  assert.equal(slugify("客服 助手"), "");
  assert.equal(slugify("Support Bot"), "support-bot");
  assert.equal(slugify("  Docs__Site!! "), "docs-site");
});

test("keyNameFor prefixes project:", () => {
  assert.equal(keyNameFor("docs-site"), "project:docs-site");
});

test("store protects secrets and reports damaged data instead of treating it as empty", async () => {
  const dir = await mkdtemp(join(tmpdir(), "key-cabinet-test-"));
  const previous = process.env.MAGPIE_CONFIG_DIR;
  process.env.MAGPIE_CONFIG_DIR = dir;
  try {
    await saveStore({ projects: [{ secret: "example" }] });
    const path = join(dir, "page-project-keys", "projects.json");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await writeFile(path, "{broken");
    await assert.rejects(loadStore());
    assert.equal(await readFile(path, "utf8"), "{broken");
  } finally {
    if (previous === undefined) delete process.env.MAGPIE_CONFIG_DIR;
    else process.env.MAGPIE_CONFIG_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("withStoreLock serializes writers and releases on failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "key-cabinet-lock-"));
  const previous = process.env.MAGPIE_CONFIG_DIR;
  process.env.MAGPIE_CONFIG_DIR = dir;
  try {
    const order = [];
    let releaseA;
    const aStarted = new Promise((resolve) => { releaseA = resolve; });
    const a = withStoreLock(async () => {
      order.push("a-start");
      releaseA();
      await new Promise((resolve) => setTimeout(resolve, 50));
      order.push("a-end");
    });
    // 等 a 真正拿到锁再排队 b；两个同时抢锁时先后顺序本来就不确定。
    await aStarted;
    const b = withStoreLock(async () => {
      order.push("b-start");
      order.push("b-end");
    });
    await Promise.all([a, b]);
    assert.deepEqual(order, ["a-start", "a-end", "b-start", "b-end"]);

    await assert.rejects(withStoreLock(async () => { throw new Error("boom"); }), /boom/);
    // 失败也必须释放，否则后续操作会一直等到超时。
    let ran = false;
    await withStoreLock(async () => { ran = true; }, { timeoutMs: 1000 });
    assert.equal(ran, true);
  } finally {
    if (previous === undefined) delete process.env.MAGPIE_CONFIG_DIR;
    else process.env.MAGPIE_CONFIG_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("withStoreLock breaks a lock left by a dead process", async () => {
  const dir = await mkdtemp(join(tmpdir(), "key-cabinet-stale-"));
  const previous = process.env.MAGPIE_CONFIG_DIR;
  process.env.MAGPIE_CONFIG_DIR = dir;
  try {
    const dataDir = join(dir, "page-project-keys");
    await mkdir(dataDir, { recursive: true });
    const lockPath = join(dataDir, "projects.json.lock");
    await writeFile(lockPath, "999999"); // 不存在的 pid
    let ran = false;
    await withStoreLock(async () => { ran = true; }, { timeoutMs: 2000 });
    assert.equal(ran, true);
    await assert.rejects(readFile(lockPath), /ENOENT/);
  } finally {
    if (previous === undefined) delete process.env.MAGPIE_CONFIG_DIR;
    else process.env.MAGPIE_CONFIG_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("withStoreLock does not break a live holder's lock just because it is old", async () => {
  const dir = await mkdtemp(join(tmpdir(), "key-cabinet-live-lock-"));
  const previous = process.env.MAGPIE_CONFIG_DIR;
  process.env.MAGPIE_CONFIG_DIR = dir;
  try {
    const dataDir = join(dir, "page-project-keys");
    await mkdir(dataDir, { recursive: true });
    const lockPath = join(dataDir, "projects.json.lock");
    const content = `${process.pid} live-owner`;
    await writeFile(lockPath, content);
    const old = new Date(Date.now() - 10 * 60_000);
    await utimes(lockPath, old, old);
    let ran = false;
    await assert.rejects(
      withStoreLock(async () => { ran = true; }, { timeoutMs: 150, staleMs: 1 }),
      /正被另一个进程修改/
    );
    assert.equal(ran, false);
    assert.equal(await readFile(lockPath, "utf8"), content);
  } finally {
    if (previous === undefined) delete process.env.MAGPIE_CONFIG_DIR;
    else process.env.MAGPIE_CONFIG_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("withStoreLock release leaves a lock that was taken over", async () => {
  const dir = await mkdtemp(join(tmpdir(), "key-cabinet-takeover-"));
  const previous = process.env.MAGPIE_CONFIG_DIR;
  process.env.MAGPIE_CONFIG_DIR = dir;
  try {
    const lockPath = join(dir, "page-project-keys", "projects.json.lock");
    await withStoreLock(async () => {
      // 模拟锁被换成了别人的（旧实现会在 finally 里无条件 unlink）。
      await writeFile(lockPath, "999999 other-owner");
    });
    assert.equal(await readFile(lockPath, "utf8"), "999999 other-owner");
  } finally {
    if (previous === undefined) delete process.env.MAGPIE_CONFIG_DIR;
    else process.env.MAGPIE_CONFIG_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
