import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { findDim, readDim } from "../src/cli.mjs";
import plugin from "../index.mjs";
import fixture from "./fixtures/usage.json";

const directory = await mkdtemp(join(tmpdir(), "dimagent-usage-test-"));
afterAll(() => rm(directory, { recursive: true, force: true }));
let serial = 0;
async function fake(source) {
  const path = join(directory, `fake dim ${++serial}`);
  await writeFile(path, `#!${process.execPath}\n${source}`, { mode: 0o755 });
  return path;
}
function currentFixture() {
  const data = structuredClone(fixture);
  const future = new Date(Date.now() + 86400000).toISOString();
  data.credits.subscription_bucket.expires_at = future;
  data.subscription.current_term.end_at = future;
  data.feature_meters[0].period_end = future;
  return data;
}

test("invokes only usage --json and supports paths with spaces", async () => {
  const path = await fake('console.log(JSON.stringify({args: process.argv.slice(2), cwd: process.cwd()}))');
  expect(await findDim(path)).toBe(path);
  const result = await readDim(path);
  expect(result.args).toEqual(["usage", "--json"]);
  expect(result.cwd).toBe(await realpath(tmpdir()));
});

test("missing executable and relative paths are actionable errors", async () => {
  await expect(findDim(join(directory, "missing"))).rejects.toThrow("找不到");
  await expect(findDim("./dim")).rejects.toThrow("绝对路径");
  await expect(readDim(join(directory, "missing"))).rejects.toThrow("无法启动");
});

test("exit and malformed JSON errors never echo CLI output", async () => {
  const failed = await fake('console.error("not signed in SECRET"); process.exit(1)');
  await expect(readDim(failed)).rejects.toThrow("dim auth login");
  const malformed = await fake('console.log("SECRET is not JSON")');
  await expect(readDim(malformed)).rejects.toThrow("有效 JSON");
});

test("output is bounded", async () => {
  const path = await fake('process.stdout.write("x".repeat(10000))');
  await expect(readDim(path, { maxBytes: 100 })).rejects.toThrow("大小限制");
});

test("timeout terminates a CLI wrapper and its child", async () => {
  const pidFile = join(directory, "child-pid");
  const path = await fake(`
    import { spawn } from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'inherit'});
    writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
    setInterval(() => {}, 1000);
  `);
  await expect(readDim(path, { timeoutMs: 1000 })).rejects.toThrow("超时");
  const pid = Number(await readFile(pidFile, "utf8"));
  expect(() => process.kill(pid, 0)).toThrow();
}, 5000);

test("connects without vendor credentials, lists no models and refuses model calls", async () => {
  const data = currentFixture();
  const path = await fake(`console.log(${JSON.stringify(JSON.stringify(data))})`);
  const hooks = await plugin();
  const saved = await hooks.auth.methods[0].authorize({ dimPath: path });
  expect(saved).toEqual({ type: "success", key: "local-cli-only", metadata: { dimPath: path, accountId: "1", email: "1" } });
  const quota = await hooks.auth.usage(async () => saved);
  expect(quota.windows[0].used).toBe(2.64);
  expect(quota.error).toBeUndefined();
  expect(await hooks.provider.models()).toEqual({});
  const loader = await hooks.auth.loader();
  expect((await loader.fetch("https://must-never-be-contacted.invalid")).status).toBe(405);
});

test("finds dim on PATH and connects without asking for a path", async () => {
  const bin = join(directory, "automatic path");
  await mkdir(bin);
  const path = join(bin, "dim");
  await writeFile(path, `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify(currentFixture()))})`, { mode: 0o755 });
  const result = spawnSync(process.execPath, ["--eval", `
    import plugin from ${JSON.stringify(new URL("../index.mjs", import.meta.url).href)};
    const method = (await plugin()).auth.methods[0];
    const question = method.ask ? await method.ask({}) : method.prompts?.[0] ?? null;
    const connection = question ? null : await method.authorize({});
    console.log(JSON.stringify({ question, connection }));
  `], { env: { ...process.env, PATH: [bin, process.env.PATH].join(delimiter) }, encoding: "utf8", timeout: 5000 });
  expect(result.status).toBe(0);
  const { question, connection } = JSON.parse(result.stdout);
  expect(question).toBeNull();
  expect(connection.type).toBe("success");
  expect(connection.metadata.dimPath).toBe(path);
});

test("switching the CLI account requires reconnecting", async () => {
  const path = await fake(`console.log(${JSON.stringify(JSON.stringify(currentFixture()))})`);
  const hooks = await plugin();
  const q = await hooks.auth.usage(async () => ({ metadata: { dimPath: path, accountId: "2" } }));
  expect(q.error).toContain("账户已改变");
  expect(q.windows).toEqual([]);
});

test("unconnected and failed readings do not invent zero quota", async () => {
  const hooks = await plugin();
  expect((await hooks.auth.usage(async () => undefined)).error).toContain("先连接");
  const path = await fake('process.exit(1)');
  const q = await hooks.auth.usage(async () => ({ metadata: { dimPath: path, accountId: "1" } }));
  expect(q.error).toContain("查询失败");
  expect(q.windows).toEqual([]);
});
