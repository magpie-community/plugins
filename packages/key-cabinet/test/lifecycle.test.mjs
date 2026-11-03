import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { saveEnv } from "./env.mjs";

// Isolate all writes and replace Magpie CLI and gateway with local fixtures.
test("key lifecycle through HTTP API", async () => {
  const restoreEnv = saveEnv(["MAGPIE_BIN", "MAGPIE_CONFIG_DIR", "FIXTURE_LOG", "MAGPIE_PROJECT_KEYS_GATEWAY"]);
  const dir = await mkdtemp(join(tmpdir(), "key-cabinet-api-"));
  const bin = join(dir, "magpie");
  await writeFile(bin, `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] !== 'gateway-key') process.exit(1);
if (args[1] === 'add') console.log('id: 123456789012345678901234\\nsk-magpie-key-abcdef123456');
else if (args[1] === 'rotate') console.log('sk-magpie-key-fedcba654321');
else if (args[1] === 'list') console.log('ID                        NAME                STATE     GATEWAY KEY                LIMIT  MODELS  ACCOUNTS  ACCESS\\n123456789012345678901234  project:example     enabled   sk-magpie-key-' + (process.env.FIXTURE_MASK || '…123456') + '      -      all     all       full');
else if (args[1] === 'limit') require('fs').appendFileSync(process.env.FIXTURE_LOG, args.join(' ') + '\\n');
else if (!['remove', 'models'].includes(args[1])) process.exit(1);
`, { mode: 0o700 });
  const gateway = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: [{ id: "group/example" }] }));
  });
  await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  process.env.MAGPIE_BIN = bin;
  process.env.MAGPIE_CONFIG_DIR = dir;
  process.env.FIXTURE_LOG = join(dir, "cli.log");
  process.env.MAGPIE_PROJECT_KEYS_GATEWAY = `http://127.0.0.1:${gateway.address().port}`;
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const { startServer } = await import("../lib/server.mjs");
  const { server, reused } = await startServer({ options: { port } });
  assert.equal(reused, false);
  const base = `http://127.0.0.1:${port}`;
  try {
    const html = await (await fetch(base)).text();
    const token = html.match(/__MAGPIE_PROJECTS_TOKEN__="([^"]+)"/)[1];
    async function api(path, method = "GET", body) {
      const res = await fetch(base + path, { method, headers: { "content-type": "application/json", "x-magpie-projects-token": token }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: res.status, body: await res.json() };
    }
    const created = await api("/api/projects", "POST", { name: "Example", slug: "example", model: "group/example" });
    assert.equal(created.status, 201);
    assert.equal(created.body.project.secret, "sk-magpie-key-abcdef123456");
    const path = `/api/projects/${created.body.project.id}`;
    assert.equal((await api("/api/projects")).body.projects.length, 1);
    assert.equal((await api(path + "/reveal", "POST")).body.secret, created.body.project.secret);
    // 掩码后缀与本地明文一致 → 没被轮换。
    assert.equal((await api(path + "/reveal", "POST")).body.rotated, false);
    assert.equal((await api(path, "PATCH", { name: "Renamed", model: "" })).body.project.name, "Renamed");

    // 状态同步：即使本地记录已是 off，也以 PATCH 为准再写一次 Magpie，
    // 这样用户在 Magpie GUI 里改过的状态能被纠正回来。
    const callerKeys = join(dir, "caller-keys.json");
    await writeFile(callerKeys, JSON.stringify([{ id: "123456789012345678901234", secret: "fixture" }]));
    assert.equal((await api(path, "PATCH", { status: "off" })).body.project.status, "off");
    assert.equal(JSON.parse(await readFile(callerKeys, "utf8"))[0].off, true);
    // 模拟 GUI 侧重新启用；再来一次 PATCH off 应把它重新停用。
    await writeFile(callerKeys, JSON.stringify([{ id: "123456789012345678901234", secret: "fixture", off: false }]));
    assert.equal((await api(path, "PATCH", { status: "off" })).body.project.status, "off");
    assert.equal(JSON.parse(await readFile(callerKeys, "utf8"))[0].off, true);
    assert.equal((await api(path, "PATCH", { status: "on" })).body.project.status, "on");
    assert.equal(JSON.parse(await readFile(callerKeys, "utf8"))[0].off, undefined);

    // 非法限额要在写 Magpie 之前被拒：同一请求里的 status 也不应生效。
    assert.equal((await api(path, "PATCH", null)).status, 400);
    assert.equal((await api(path, "PATCH", { status: "off", limit: { window: "bad" } })).status, 400);
    assert.equal(JSON.parse(await readFile(callerKeys, "utf8"))[0].off, undefined);

    // 掩码后缀变了 = Magpie 侧轮换过，本地明文过期（列表缓存刚被状态写入清掉）。
    process.env.FIXTURE_MASK = "…999999";
    const rotated = await api(path + "/reveal", "POST");
    assert.equal(rotated.body.exists, true);
    assert.equal(rotated.body.rotated, true);
    const meta = await api("/api/meta");
    assert.equal(meta.status, 200);
    assert.equal(meta.body.rotated["123456789012345678901234"], true);
    process.env.FIXTURE_MASK = "…123456";

    // 限额：GET 读 Magpie 持久化的 limit + moreLimits；PATCH 先 off 再写一条，
    // 保证页面上这一条就是 Magpie 实际执行的限额。
    await writeFile(callerKeys, JSON.stringify([{
      id: "123456789012345678901234",
      secret: "fixture",
      limit: { period: "week", tokens: 5000 },
      moreLimits: [{ period: "days", days: 3 }],
    }]));
    const lim = await api(path + "/limits");
    assert.equal(lim.status, 200);
    assert.equal(lim.body.limits.length, 2);
    assert.equal(lim.body.limits[0].period, "week");
    assert.equal(lim.body.limits[0].tokens, 5000);
    assert.equal(lim.body.limits[1].days, 3);

    assert.equal((await api(path, "PATCH", { limit: { window: "day", tokens: 100000, cost: 1.5 } })).status, 200);
    // 自定义窗口原样传给 Magpie CLI（Magpie 负责持久化成 days/hours）。
    assert.equal((await api(path, "PATCH", { limit: { window: "3d", tokens: 1000, cacheReads: true } })).status, 200);
    assert.equal((await api(path, "PATCH", { limit: null })).status, 200);
    const cliLog = await readFile(process.env.FIXTURE_LOG, "utf8");
    assert.match(cliLog, /gateway-key limit 123456789012345678901234 remove 2/);
    assert.match(cliLog, /gateway-key limit 123456789012345678901234 day --tokens 100000 --cost 1\.5/);
    assert.match(cliLog, /gateway-key limit 123456789012345678901234 3d --tokens 1000 --cache-reads/);
    assert.match(cliLog, /gateway-key limit 123456789012345678901234 off/);

    assert.equal((await api(path, "PATCH", { limit: { window: "year", tokens: 1 } })).status, 400);
    assert.equal((await api(path, "PATCH", { limit: { window: "0d", tokens: 1 } })).status, 400);
    assert.equal((await api(path, "PATCH", { limit: { window: "day" } })).status, 400);
    assert.equal((await api(path, "PATCH", { limit: { window: "day", tokens: -5 } })).status, 400);
    assert.equal((await api(path, "PATCH", { limit: { window: "day", tokens: 1.5 } })).status, 400);

    assert.equal((await api(path + "/reset", "POST")).body.project.secret, "sk-magpie-key-fedcba654321");
    assert.equal((await api(path, "DELETE")).body.ok, true);
    assert.equal((await api("/api/projects")).body.projects.length, 0);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    gateway.closeAllConnections?.();
    await new Promise((resolve) => gateway.close(resolve));
    await rm(dir, { recursive: true, force: true });
    restoreEnv();
  }
});
