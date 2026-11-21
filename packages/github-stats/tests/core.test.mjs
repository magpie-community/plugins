import test from "node:test";
import { request } from "node:http";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaults,
  validateConfig,
  withLock,
  saveConfig,
} from "../dist/config.js";
import { normalizeUsage, readUsage } from "../dist/usage.js";
import { renderCard, readmeSnippet } from "../dist/renderer.js";
import { GitHub, GitHubError } from "../dist/github.js";
import { sync, due, readState } from "../dist/sync.js";
import { scheduleFiles } from "../dist/scheduler.js";
import { startServer } from "../dist/server.js";
const config = { ...defaults, repository: "tester/profile" };
const source = () => ({
  period: "30d",
  since: "2026-10-19T00:00:00+08:00",
  bucket: "day",
  calls: 3,
  input: 1000,
  output: 200,
  cache_read: 9000,
  reasoning: 80,
  cost: 1.2,
  unpriced: 1,
  accounts: [{ account: "private@example.com" }],
  sessions: [{ id: "secret-session" }],
  models: [
    {
      model: "model-a",
      input: 300,
      output: 100,
      calls: 1,
      host: "secret-host",
    },
    {
      model: "model-a",
      input: 700,
      output: 100,
      calls: 2,
      providerAccount: "SECRET",
    },
  ],
  series: [
    { time: "2026-11-16T00:00:00+08:00", calls: 1, input: 500, output: 100 },
    { time: "2026-11-17T00:00:00+08:00", calls: 2, input: 500, output: 100 },
  ],
});
const stats = () => normalizeUsage(source(), "30d");
async function temp(t) {
  const dir = await mkdtemp(join(tmpdir(), "magpie-stats-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("normalization matches official token semantics and strips private dimensions", () => {
  const s = stats();
  assert.equal(s.tokens, 1200);
  assert.equal(s.activeDays, 2);
  assert.equal(s.models.length, 1);
  assert.equal(s.models[0].tokens, 1200);
  assert.equal(s.days[1].date, "2026-11-17");
  assert.doesNotMatch(
    JSON.stringify(s),
    /secret|SECRET|private@|account|host|cache_read/,
  );
});
test("rejects malformed upstream counts and incompatible aggregation", () => {
  for (const patch of [
    { calls: -1 },
    { input: NaN },
    { output: "100" },
    { bucket: "week" },
    { period: "7d" },
    { series: null },
  ])
    assert.throws(() => normalizeUsage({ ...source(), ...patch }, "30d"));
});
test("empty usage produces valid zero-state SVG", () => {
  const s = normalizeUsage(
    { ...source(), calls: 0, input: 0, output: 0, models: [], series: [] },
    "30d",
  );
  for (const mode of ["light", "dark"]) {
    const svg = renderCard(s, config, mode, "2026-11-17");
    assert.match(svg, /No activity/);
    assert.doesNotMatch(svg, /NaN|Infinity/);
  }
});
test("SVG escapes untrusted model names and keeps cost opt-in", () => {
  const s = stats();
  s.models[0].name = '<script>alert("X")</script>';
  const svg = renderCard(s, config, "dark", "2026-11-17");
  assert.doesNotMatch(svg, /<script|Estimated|EST\. COST|private@|secret-host/);
  assert.match(svg, /&lt;script&gt;/);
  assert.match(
    renderCard(s, { ...config, showCost: true }, "light", "2026-11-17"),
    /EST\. COST/,
  );
});
test("all themes and layouts generate bounded numeric SVG", () => {
  for (const width of [320, 520, 640, 800])
    for (const theme of ["aurora", "minimal", "cyberpunk"])
      for (const mode of ["light", "dark"]) {
        const s = stats();
        s.models = Array.from({ length: 5 }, (_, i) => ({
          name: "very-long-model-".repeat(20) + i,
          requests: 1,
          tokens: 1,
        }));
        const svg = renderCard(
          s,
          { ...config, width, theme, topModels: 5 },
          mode,
          "2026-11-17",
        );
        assert.match(svg, new RegExp(`width="${width}"`));
        assert.doesNotMatch(svg, /NaN|Infinity/);
        assert.match(svg, /…/);
      }
});
test("invalid paths, unknown secrets, and unsafe settings fail closed", () => {
  for (const patch of [
    { repository: "owner/repo/extra" },
    { folder: "../assets" },
    { folder: ".git" },
    { branch: "x..y" },
    { branch: "-bad ref" },
    { width: 200 },
    { topModels: 9 },
    { daily: "true" },
    { token: "never-store-in-config" },
    { magpiePort: 0 },
  ])
    assert.throws(() => validateConfig({ ...config, ...patch }));
});
test("README supports remote assets and encoded branch names", () => {
  const html = readmeSnippet({ ...config, branch: "cards/daily" });
  assert.match(html, /cards%2Fdaily\/assets\/magpie-dark.svg/);
  assert.match(html, /prefers-color-scheme: dark/);
});
test("usage client reads only loopback summary and refuses redirects", async () => {
  let calls = 0;
  const s = await readUsage(
    { ...config, showHeatmap: false },
    async (url, init) => {
      calls++;
      const period = calls === 1 ? "30d" : "all";
      assert.equal(url, "http://127.0.0.1:3425/v1/magpie/usage?period=" + period);
      assert.equal(init.redirect, "error");
      const data = source();
      if (period === "all") data.series.push({ ...data.series[0], time: "2025-01-01T00:00:00Z" });
      return Response.json({ ...data, period });
    },
  );
  assert.equal(s.tokens, 1200);
  assert.equal(calls, 2);
  assert.equal(s.activeDays, 3);
  assert.equal(s.days.length, 2);
});
test("weekly All Time histories expand using bounded summary date ranges", async () => {
  const now = new Date();
  const start = new Date(now);
  start.setDate(start.getDate() - 35);
  const date = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  let calls = 0;
  const s = await readUsage(
    { ...config, period: "all", showHeatmap: false },
    async (url) => {
      calls++;
      const p = new URL(url).searchParams.get("period");
      if (p === "all")
        return Response.json({
          ...source(),
          period: "all",
          bucket: "week",
          since: date(start) + "T00:00:00Z",
        });
      return Response.json({
        ...source(),
        period: p,
        bucket: "day",
        series: [
          {
            time: p.split("..")[0] + "T00:00:00Z",
            calls: 1,
            input: 10,
            output: 1,
          },
        ],
      });
    },
  );
  assert.equal(calls, 3);
  assert.equal(s.activeDays, 2);
  assert.equal(s.tokens, 1200);
});
function githubMock(handler) {
  return new GitHub(
    "test-token",
    async (url, init) => handler(url, init),
    async () => {},
  );
}
test("GitHub upload skips identical content and creates missing content", async () => {
  let puts = 0;
  let exists = true;
  const github = githubMock((url, init) => {
    assert.equal(init.redirect, "error");
    if (init.method === "GET")
      return exists
        ? Response.json({
            type: "file",
            encoding: "base64",
            content: Buffer.from("<svg/>").toString("base64"),
            sha: "one",
          })
        : new Response("", { status: 404 });
    puts++;
    return Response.json({ commit: { sha: "two" } });
  });
  assert.equal(
    await github.put(config, "main", "magpie-dark.svg", "<svg/>"),
    false,
  );
  assert.equal(puts, 0);
  exists = false;
  assert.equal(
    await github.put(config, "main", "magpie-dark.svg", "<svg/>"),
    true,
  );
  assert.equal(puts, 1);
});
test("GitHub SHA conflict re-reads and recovers without overwriting other files", async () => {
  let gets = 0,
    puts = 0;
  const github = githubMock((url, init) => {
    if (init.method === "GET") {
      gets++;
      return Response.json({
        type: "file",
        encoding: "base64",
        content: "b2xk",
        sha: "sha" + gets,
      });
    }
    puts++;
    assert.equal(JSON.parse(init.body).sha, "sha" + gets);
    return puts === 1 ? new Response("", { status: 409 }) : Response.json({});
  });
  await github.put(config, "main", "magpie-dark.svg", "new");
  assert.equal(gets, 2);
  assert.equal(puts, 2);
});
test("lost write response resolves as unchanged after SHA conflict", async () => {
  let current = "old";
  let writes = 0;
  const github = githubMock((url, init) => {
    if (init.method === "GET")
      return Response.json({
        type: "file",
        encoding: "base64",
        content: Buffer.from(current).toString("base64"),
        sha: current,
      });
    writes++;
    if (writes === 1) {
      current = "new";
      throw new Error("network lost");
    }
    return new Response("", { status: 409 });
  });
  assert.equal(
    await github.put(config, "main", "magpie-dark.svg", "new"),
    false,
  );
  assert.equal(current, "new");
});
test("GitHub retries transient server errors, but not authentication", async () => {
  let n = 0;
  const retry = githubMock(() =>
    ++n < 3 ? new Response("", { status: 503 }) : Response.json({ ok: true }),
  );
  assert.equal((await retry.request("/repos/a/b")).ok, true);
  assert.equal(n, 3);
  n = 0;
  const denied = githubMock(() => {
    n++;
    return new Response("token should not leak", { status: 401 });
  });
  await assert.rejects(
    denied.request("/repos/a/b"),
    (e) => e.status === 401 && !e.message.includes("leak"),
  );
  assert.equal(n, 1);
});
test("rate limit stores a cooldown without waiting in process", async () => {
  const github = githubMock(
    () => new Response("", { status: 429, headers: { "retry-after": "120" } }),
  );
  await assert.rejects(
    github.request("/repos/a/b"),
    (e) =>
      e instanceof GitHubError && Date.parse(e.retryAt) > Date.now() + 100000,
  );
});
test("successful sync is idempotent across days with identical public data", async (t) => {
  const dir = await temp(t),
    remote = new Map();
  let commits = 0;
  const github = {
    repository: async () => ({ branch: "main", private: false }),
    put: async (c, b, name, svg) => {
      if (remote.get(name) === svg) return false;
      commits++;
      remote.set(name, svg);
      return true;
    },
  };
  const deps = {
    config: { ...config, daily: true },
    stats: async () => stats(),
    github,
    now: new Date(2026, 10, 17, 3),
  };
  assert.equal((await sync(dir, false, deps)).changed, 2);
  deps.now = new Date(2026, 10, 18, 3);
  assert.equal((await sync(dir, false, deps)).changed, 0);
  assert.equal(commits, 2);
  assert.equal((await sync(dir, true, deps)).result, "skipped");
  assert.equal((await readState(dir)).publishedDate, "2026-11-17");
});
test("failed sync retains previous valid local cards and does not mark success", async (t) => {
  const dir = await temp(t),
    github = {
      repository: async () => ({ branch: "main" }),
      put: async () => true,
    };
  await sync(dir, false, { config, stats: async () => stats(), github });
  const before = await readFile(join(dir, "cards", "magpie-dark.svg"), "utf8");
  const previous = await readState(dir);
  await assert.rejects(
    sync(dir, false, {
      config,
      stats: async () => {
        throw new Error("offline");
      },
      github,
    }),
  );
  assert.equal(
    await readFile(join(dir, "cards", "magpie-dark.svg"), "utf8"),
    before,
  );
  const state = await readState(dir);
  assert.equal(state.lastSuccess, previous.lastSuccess);
  assert.equal(state.lastResult, "failed");
});
test("lock prevents duplicate concurrent operations", async (t) => {
  const dir = await temp(t);
  let release;
  const barrier = new Promise((r) => (release = r));
  const first = withLock(dir, () => barrier);
  await new Promise((r) => setTimeout(r, 30));
  await assert.rejects(
    withLock(dir, async () => {}),
    /另一个/,
  );
  release();
  await first;
});
test("daily due handles local dates, catch-up, disabled and cooldown", () => {
  const c = { ...config, daily: true };
  assert.equal(due(c, {}), true);
  assert.equal(due({ ...c, daily: false }, {}), false);
  assert.equal(
    due(c, { nextRetry: new Date(Date.now() + 60000).toISOString() }),
    false,
  );
});
test("native schedule files quote paths and include wake catch-up", () => {
  const dir = "/home/test/a b&c";
  const mac = scheduleFiles(
    "darwin",
    dir,
    "/path with space/node",
    "/some file/cli.js",
    "/test",
  );
  assert.match(mac[0].content, /RunAtLoad/);
  assert.match(mac[0].content, /a b&amp;c/);
  assert.match(mac[0].content, /<integer>2<\/integer>/);
  const linux = scheduleFiles("linux", dir, "/node", "/a b/cli.js", "/test");
  assert.match(linux[0].content, /"\/a b\/cli.js"/);
  assert.match(linux[1].content, /Persistent=true/);
  const win = scheduleFiles(
    "win32",
    "C:\\Users\\Test Name",
    "C:\\Program Files\\node.exe",
    "C:\\my plugin\\cli.js",
  );
  assert.match(win[0].content, /StartWhenAvailable>true/);
  assert.match(win[0].content, /LogonTrigger/);
  assert.match(win[0].content, /&quot;C:\\my plugin\\cli.js&quot;/);
});
test("service rejects unauthenticated API, foreign origins, DNS rebinding and traversal", async (t) => {
  const dir = await temp(t);
  const svc = await startServer({ port: 0, dir });
  t.after(() => svc.close());
  const html = await (await fetch(svc.url)).text();
  const token = html.match(/name="page-token" content="([^"]+)"/)[1];
  assert.equal((await fetch(svc.url + "/api/status")).status, 403);
  assert.equal(
    (
      await fetch(svc.url + "/api/status", {
        headers: {
          "X-Magpie-Stats-Token": token,
          Origin: "https://evil.example",
        },
      })
    ).status,
    403,
  );
  assert.equal(
    await new Promise((resolve, reject) => {
      const q = request(
        svc.url + "/api/status",
        { headers: { Host: "evil.example", "X-Magpie-Stats-Token": token } },
        (r) => {
          r.resume();
          resolve(r.statusCode);
        },
      );
      q.on("error", reject);
      q.end();
    }),
    403,
  );
  assert.equal((await fetch(svc.url + "/package.json")).status, 404);
  const ok = await fetch(svc.url + "/api/status", {
    headers: { "X-Magpie-Stats-Token": token, Origin: "null" },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("Access-Control-Allow-Origin"), "null");
  assert.doesNotMatch(JSON.stringify(await ok.json()), /test-token/);
});
test("service can save ordinary settings without requesting credentials", async (t) => {
  const dir = await temp(t);
  const svc = await startServer({ port: 0, dir });
  t.after(() => svc.close());
  const html = await (await fetch(svc.url)).text();
  const token = html.match(/name="page-token" content="([^"]+)"/)[1];
  const r = await fetch(svc.url + "/api/config", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Magpie-Stats-Token": token,
    },
    body: JSON.stringify({ config }),
  });
  assert.equal(r.status, 200);
  assert.equal(
    JSON.parse(await readFile(join(dir, "config.json"))).repository,
    config.repository,
  );
});
