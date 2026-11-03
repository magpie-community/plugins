import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
test("Bun and Node toggle only the requested fixture caller key", async (t) => {
  // 用当前运行时绝对路径，别依赖 PATH：bun test 里其它包的测试可能改过 PATH。
  const bunBin = typeof Bun === "undefined" ? "bun" : process.execPath;
  try { await run(bunBin, ["--version"]); } catch { return t.skip("Bun 不可用"); }
  const dir = await mkdtemp(join(tmpdir(), "key-cabinet-toggle-"));
  const path = join(dir, "caller-keys.json");
  const moduleUrl = new URL("../lib/caller-keys-store.mjs", import.meta.url).href;
  const script = `import { setCallerKeyOff } from ${JSON.stringify(moduleUrl)}; await setCallerKeyOff('fixture-id', process.argv[1] === 'off');`;
  try {
    await writeFile(path, JSON.stringify([{ id: "fixture-id", secret: "fixture" }, { id: "another", off: true }]));
    const env = { ...process.env, MAGPIE_CONFIG_DIR: dir };
    await run(bunBin, ["--eval", script, "off"], { env, timeout: 10000 });
    assert.equal(JSON.parse(await readFile(path, "utf8"))[0].off, true);
    await run(process.execPath, ["--input-type=module", "--eval", script, "on"], { env, timeout: 10000 });
    const keys = JSON.parse(await readFile(path, "utf8"));
    assert.equal(keys[0].off, undefined);
    assert.equal(keys[1].off, true);
    assert.equal(keys[0].secret, "fixture");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
