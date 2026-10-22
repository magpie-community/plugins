import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

test("后台入口仅返回空 hooks，隔离目录生成快照，不注册登录或路由", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "quota-plugin-entry-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = fileURLToPath(new URL("../", import.meta.url));
  for (const file of ["index.mjs", "collector.mjs", "claude-native.mjs", "estimate.mjs"]) {
    await copyFile(path.join(root, file), path.join(dir, file));
  }
  await mkdir(path.join(dir, "page"));
  await writeFile(path.join(dir, "run.mjs"), 'import plugin from "./index.mjs"; console.log(JSON.stringify(await plugin()));\n');
  const { stdout } = await promisify(execFile)(process.execPath, [path.join(dir, "run.mjs")], {
    env: { ...process.env, XDG_CONFIG_HOME: path.join(dir, "config"), XDG_CACHE_HOME: path.join(dir, "cache"),
      CLAUDE_CONFIG_DIR: path.join(dir, "claude") }, timeout: 10000,
  });
  assert.deepEqual(JSON.parse(stdout), {});
  const snapshot = await readFile(path.join(dir, "page/snapshot.js"), "utf8");
  assert.match(snapshot, /^window.acceptQuotaSnapshot\(/);
  assert.ok(!snapshot.includes(root));
});
