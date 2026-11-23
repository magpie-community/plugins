import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReport, createReader, createResetter, timestamp, windowKind } from "../lib/data.mjs";

const now = Date.parse("2026-11-16T08:00:00Z");

test("分别提供 GPT 双窗口与第三方 API 余额", () => {
  const report = buildReport([
    { provider: "codex", user: "one@example.test", readAt: now, windows: [
      { name: "5 hours", used: 37, resetsAt: now + 3600000 },
      { name: "Weekly", used: 82 },
    ] },
    { provider: "chatgpt", user: "two@example.test", windows: [{ name: "5h", remaining: 12 }] },
    { provider: "duiba-codex", balance: "$100", windows: [] },
  ], { now });
  assert.equal(report.accounts.length, 2);
  assert.equal(report.accounts[0].fiveHour[0].remaining, 63);
  assert.equal(report.accounts[0].weekly[0].remaining, 18);
  assert.equal(report.accounts[1].fiveHour[0].remaining, 12);
  assert.equal(report.accounts[1].weekly.length, 0);
  assert.equal(report.apiAccounts.length, 1);
  assert.equal(report.apiAccounts[0].balances[0].display, "$100");
  assert.equal(report.apiAccounts[0].balances[0].remaining, null);
});

test("Kiro 积分和常见旧版订阅保留在订阅分区", () => {
  const report = buildReport([
    { provider: "kiro", user: "kiro-user", windows: [{ name: "Monthly credits", amount: 350, limit: 1000, unit: "credits" }] },
    ...["claude", "copilot", "plugin:gemini-cli", "antigravity"].map((provider) => ({
      provider, user: provider, windows: [{ name: "每日请求数", amount: 10, limit: 100, unit: "requests" }],
    })),
  ]);
  assert.equal(report.accounts.length, 5);
  assert.equal(report.apiAccounts.length, 0);
  const kiro = report.accounts.find((account) => account.provider === "kiro");
  assert.equal(kiro.kind, "subscription");
  assert.equal(kiro.windows[0].remaining, 65);
  assert.equal(kiro.windows[0].amount, 350);
  assert.equal(kiro.windows[0].limit, 1000);
  assert.equal(kiro.windows[0].unit, "credits");
});

test("保留付费周期结束时间，不以额度重置或凭证期限推算订阅有效期", () => {
  const until = Date.parse("2026-12-16T08:00:00Z");
  const report = buildReport([
    { provider: "codex", user: "auto", until: "2026-12-16T08:00:00Z", renew: "auto" },
    { provider: "vendor", kind: "plan", user: "off", until: until / 1000, renew: "off" },
    { provider: "codex", user: "numeric", until },
    { provider: "codex", user: "invalid", until: "not-a-date", renew: "off" },
    { provider: "codex", user: "missing", expiresAt: until, windows: [{ name: "Weekly", resetsAt: until }] },
  ]);
  const accounts = new Map(report.accounts.map((account) => [account.user, account]));
  assert.equal(accounts.get("auto").until, until);
  assert.equal(accounts.get("off").until, until);
  assert.equal(accounts.get("numeric").until, until);
  assert.equal(accounts.get("invalid").until, null);
  assert.equal(accounts.get("missing").until, null);
});

test("Magpie 类型优先，任何插件订阅与密钥套餐都展示全部窗口", () => {
  const report = buildReport([
    { provider: "plugin:future-service", kind: "subscription", user: "future", windows: [
      { name: "Daily", remaining: 50 },
      { name: "Monthly credits", limit: 1000, amount: 200, unit: "credits" },
      { name: "Model pool A", used: 10 },
      { name: "Model pool B", used: 20 },
    ] },
    { provider: "custom-vendor", kind: "plan", plan: "coding", windows: [{ name: "Requests", amount: 50, limit: 100 }] },
    { provider: "codex", kind: "balance", balance: "$12" },
    { provider: "kiro", kind: "balance", balance: "$4" },
  ]);
  assert.equal(report.accounts.length, 2);
  const subscription = report.accounts.find((account) => account.user === "future");
  assert.equal(subscription.provider, "future-service");
  assert.deepEqual(subscription.windows.map((window) => window.remaining), [50, 80, 90, 80]);
  assert.equal(subscription.fiveHour.length, 0);
  assert.equal(subscription.weekly.length, 0);
  assert.equal(report.accounts.find((account) => account.kind === "plan").plan, "coding");
  assert.equal(report.apiAccounts.length, 2);
});

test("不限量、文本与无总额钱包不伪造剩余百分比", () => {
  const report = buildReport([{ provider: "custom-plugin", kind: "subscription", windows: [
    { name: "Chat", unlimited: true, used: 0, remaining: 100 },
    { name: "签到", text: true, display: "今日已签到", used: 0, remaining: 100 },
    { name: "Wallet", balance: 12.5, unit: "USD", used: 0, remaining: 100 },
    { name: "Unknown" },
  ] }]);
  const windows = report.accounts[0].windows;
  assert.deepEqual(windows.map((window) => window.remaining), [null, null, null, null]);
  assert.equal(windows[0].unlimited, true);
  assert.equal(windows[1].text, true);
  assert.equal(windows[1].display, "今日已签到");
  assert.equal(windows[2].balance, 12.5);
});

test("订阅钱包有总额才计算比例，无总额的已用数量仍保留", () => {
  const report = buildReport([{ provider: "custom-plugin", kind: "subscription", windows: [
    { name: "Wallet", balance: 25, limit: 100, unit: "credits" },
    { name: "Requests", amount: 12, unit: "requests" },
  ] }]);
  assert.equal(report.accounts[0].windows[0].remaining, 25);
  assert.equal(report.accounts[0].windows[1].remaining, null);
  assert.equal(report.accounts[0].windows[1].amount, 12);
});

test("无读数和错误记录仍然可见，未知类型不会直接归为 API", () => {
  const report = buildReport([
    { provider: "new-plugin", kind: "subscription", error: "需要重新登录" },
    { provider: "new-vendor", kind: "balance", error: "余额接口暂不可用" },
    { provider: "untyped", windows: [{ name: "Daily", remaining: 25 }] },
    { provider: "untyped-credits", windows: [{ name: "Credits", display: "试用中" }] },
    null, {},
  ]);
  assert.equal(report.accounts.length, 1);
  assert.equal(report.accounts[0].error, "需要重新登录");
  assert.equal(report.apiAccounts.length, 1);
  assert.equal(report.apiAccounts[0].balances.length, 0);
  assert.equal(report.otherAccounts.length, 2);
  assert.ok(report.otherAccounts.every((account) => account.kind === "unknown"));
});

test("同供应商不同类型、远端与未提供 user 的不同账号不会互相覆盖", () => {
  const report = buildReport([
    { provider: "service", kind: "subscription", user: "same", readAt: now, windows: [{ name: "Daily", used: 10 }] },
    { provider: "service", kind: "subscription", user: "same", from: "remote", readAt: now, windows: [{ name: "Daily", used: 20 }] },
    { provider: "service", kind: "plan", user: "same", windows: [{ name: "Daily", used: 30 }] },
    { provider: "service", kind: "balance", user: "same", balance: "$12" },
    { provider: "service", kind: "subscription", name: "account-one", windows: [] },
    { provider: "service", kind: "subscription", name: "account-two", windows: [] },
  ]);
  assert.equal(report.accounts.length, 5);
  assert.equal(report.apiAccounts.length, 1);
  assert.equal(new Set([...report.accounts, ...report.apiAccounts].map((account) => account.id)).size, 6);
});

test("保留同周期多个模型窗口，过滤无效窗口和敏感字段", () => {
  const report = buildReport([{ provider: "plugin:claude", kind: "subscription", accessToken: "secret", windows: [
    null, 0, "invalid",
    { name: "Weekly Sonnet", used: 30, secret: "window-secret" },
    { name: "Weekly Opus", used: 80 },
  ] }]);
  assert.equal(report.accounts[0].windows.length, 2);
  assert.equal(report.accounts[0].weekly.length, 2);
  assert.deepEqual(report.accounts[0].weekly.map((window) => window.remaining), [70, 20]);
  assert.ok(!JSON.stringify(report).includes("secret"));
});

test("第三方余额支持零余额，有总额度时计算真实剩余比例", () => {
  const report = buildReport([
    { provider: "vendor-a", name: "供应商 A", balance: "$0.00", windows: [] },
    { provider: "vendor-b", name: "供应商 B", windows: [
      { name: "Credits", limit: 1000, amount: 350, unit: "credits" },
    ] },
    { provider: "vendor-c", name: "供应商 C", windows: [
      { name: "钱包", balance: 12.5, unit: "USD" },
    ] },
    { provider: "vendor-d", name: "供应商 D", windows: [
      { name: "日请求数", limit: 100, amount: 20, unit: "requests" },
    ] },
  ]);
  assert.equal(report.apiAccounts.length, 3);
  assert.equal(report.apiAccounts[0].name, "供应商 A");
  assert.equal(report.apiAccounts[0].balances[0].display, "$0.00");
  assert.equal(report.apiAccounts[0].balances[0].remaining, null);
  assert.equal(report.apiAccounts[1].balances[0].display, "650 credits");
  assert.equal(report.apiAccounts[1].balances[0].remaining, 65);
  assert.equal(report.apiAccounts[2].balances[0].display, "$12.5");
  assert.equal(report.apiAccounts[2].balances[0].remaining, null);
});

test("第三方额度不包含凭据，同一账户保留最新余额", () => {
  const report = buildReport([
    { provider: "vendor", user: "one", balance: "$20", readAt: now, apiKey: "secret" },
    { provider: "vendor", user: "one", balance: "$99", readAt: now - 1000 },
  ]);
  assert.equal(report.apiAccounts.length, 1);
  assert.equal(report.apiAccounts[0].balances[0].display, "$20");
  assert.ok(!JSON.stringify(report).includes("secret"));
});

test("缺失读数不显示为满额，零与超额读数保留正确含义", () => {
  const report = buildReport([{ provider: "codex", windows: [
    { name: "5h", used: null },
    { name: "5h", used: 0 },
    { name: "5h", used: 130 },
    { name: "5h", remaining: 0, used: 0 },
    { name: "Weekly", amount: 40, limit: 100 },
  ] }]);
  assert.deepEqual(report.accounts[0].fiveHour.map((window) => window.remaining), [null, 100, 0, 0]);
  assert.equal(report.accounts[0].weekly[0].remaining, 60);
});

test("重置倒计时以供应商读数时间为基准，过期后不自动填满", () => {
  const report = buildReport([{ provider: "codex", readAt: now - 7200000, windows: [
    { name: "5h", used: 100, resetSecs: 3600 },
  ] }], { now });
  assert.equal(report.accounts[0].fiveHour[0].resetsAt, now - 3600000);
  assert.equal(report.accounts[0].fiveHour[0].remaining, 0);
});

test("识别窗口时兼容秒和 Go duration，避免误认 15h", () => {
  assert.equal(windowKind({ name: "5-hour limit" }), "fiveHour");
  assert.equal(windowKind({ name: "每周限额" }), "weekly");
  assert.equal(windowKind({ name: "7 days" }), "weekly");
  assert.equal(windowKind({ span: 18000e9 }), "fiveHour");
  assert.equal(windowKind({ span: 604800 }), "weekly");
  assert.equal(windowKind({ name: "15h" }), null);
  assert.equal(timestamp(now / 1000), now);
  assert.equal(timestamp(now), now);
  assert.equal(timestamp(new Date(now).toISOString()), now);
  assert.equal(timestamp("无时间"), null);
});

test("去重保留更新的账号读数，并且不向页面输出额外字段", () => {
  const report = buildReport([
    { provider: "codex", user: "one", readAt: now, accessToken: "secret", windows: [{ name: "5h", used: 40 }] },
    { provider: "codex", user: "one", readAt: now - 1000, windows: [{ name: "5h", used: 10 }] },
  ]);
  assert.equal(report.accounts.length, 1);
  assert.equal(report.accounts[0].fiveHour[0].remaining, 60);
  assert.ok(!JSON.stringify(report).includes("secret"));
});

test("从网关读取，连续请求复用缓存，手动刷新绕过缓存", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "magpie-provider-quota-data-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "plugins.json"), "{}");
  await writeFile(join(directory, "gateway.json"), JSON.stringify({ addr: "127.0.0.1:4321" }));
  const requests = [];
  let refreshed = false;
  const read = createReader({
    configDir: directory,
    fetchImpl: async (url, options) => {
      requests.push(`${options.method || "GET"} ${url.href}`);
      if (url.pathname.endsWith("/refresh") && options.method === "POST") {
        refreshed = true;
        return { ok: true, json: async () => ({ data: [] }) };
      }
      return { ok: true, json: async () => ({ data: [
        { provider: "codex", windows: [{ name: "5h", remaining: refreshed ? 65 : 80 }] },
        { provider: "vendor", kind: "plan", windows: [{ name: "Daily", remaining: refreshed ? 40 : 55 }] },
        { provider: "vendor", kind: "balance", balance: refreshed ? "$8" : "$10" },
      ] }) };
    },
  });
  assert.equal((await read()).source, "gateway");
  await read();
  const [report, concurrent] = await Promise.all([read({ force: true }), read({ force: true })]);
  assert.equal(concurrent, report);
  assert.equal(report.accounts.find((account) => account.kind === "subscription").fiveHour[0].remaining, 65);
  assert.equal(report.accounts.find((account) => account.kind === "plan").windows[0].remaining, 40);
  assert.equal(report.apiAccounts[0].balance, "$8");
  assert.equal(await read(), report);
  assert.deepEqual(requests, [
    "GET http://127.0.0.1:4321/v1/magpie/quotas?kept=1",
    "POST http://127.0.0.1:4321/v1/magpie/quotas/refresh",
    "GET http://127.0.0.1:4321/v1/magpie/quotas?kept=1",
  ]);
});

test("网关故障时标注快照，保留供应商原始读取时间", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "magpie-provider-quota-fallback-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "plugins.json"), "{}");
  await writeFile(join(directory, "quotas.json"), JSON.stringify({
    "codex/one": { at: new Date(now).toISOString(), quota: {
      provider: "codex", user: "one", windows: [{ name: "5h" }],
    } },
  }));
  const read = createReader({
    configDir: directory,
    fetchImpl: async () => { throw new Error("offline"); },
  });
  const report = await read();
  assert.equal(report.source, "snapshot");
  assert.match(report.warning, /快照/);
  assert.equal(report.accounts[0].readAt, now);
  assert.equal(report.accounts[0].fiveHour[0].remaining, null);
  await assert.rejects(read({ force: true }), /额度刷新失败/);
  assert.equal(await read(), report);
});

test("旧版快照根据记录键还原插件订阅、密钥套餐与钱包，恢复窗口周期和读数时间", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "magpie-subscription-fallback-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "plugins.json"), "{}");
  await writeFile(join(directory, "quotas.json"), JSON.stringify({
    "plugin:future/user": { at: now, spans: [{ span: 18000e9 }], quota: {
      provider: "plugin:future", user: "user", asOf: now - 60000,
      windows: [{ name: "Coding credits", amount: 20, limit: 100, unit: "credits" }],
    } },
    "vendor/plan 123456": { at: now, quota: { provider: "vendor", windows: [{ name: "Daily", used: 25 }] } },
    "kiro/balance 654321": { at: now, quota: { provider: "kiro", balance: "$2" } },
  }));
  const read = createReader({ configDir: directory, fetchImpl: async () => { throw new Error("offline"); } });
  const report = await read();
  assert.equal(report.accounts.length, 2);
  const subscription = report.accounts.find((account) => account.kind === "subscription");
  assert.equal(subscription.readAt, now - 60000);
  assert.equal(subscription.fiveHour[0].remaining, 80);
  assert.equal(report.accounts.find((account) => account.provider === "vendor").kind, "plan");
  assert.equal(report.apiAccounts[0].provider, "kiro");
});

test("服务器监听所有网卡时仍通过回环地址读取网关", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "magpie-provider-quota-server-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "plugins.json"), "{}");
  await writeFile(join(directory, "gateway.json"), JSON.stringify({ addr: "0.0.0.0:3430" }));
  const read = createReader({
    configDir: directory,
    fetchImpl: async (url) => {
      assert.equal(url.hostname, "127.0.0.1");
      assert.equal(url.port, "3430");
      return { ok: true, json: async () => ({ data: [] }) };
    },
  });
  assert.equal((await read()).source, "gateway");
});

test("保留 Codex 重置卡，仅本机与远端 Codex 账号可从页面使用", () => {
  const soon = now + 86400000;
  const later = now + 7 * 86400000;
  const report = buildReport([
    { provider: "codex", user: "local@example.test", resets: {
      count: 2, until: new Date(soon).toISOString(),
      each: [{ id: "credit-a", until: new Date(soon).toISOString() }, { id: "credit-b", until: new Date(later).toISOString() }, null],
    }, resetsUsed: [{ at: new Date(now).toISOString(), why: "week" }, { why: "hand" }] },
    { provider: "office/codex", from: "office", user: "remote@example.test", resets: { count: 1 } },
    { provider: "glm", kind: "subscription", user: "team", resets: { byWindow: true, fiveHour: 2, weekly: 1, team: true } },
    { provider: "claude", user: "none", resets: { count: 0 } },
    { provider: "vendor", kind: "balance", balance: "$1", resets: { count: 3 } },
  ]);
  const accounts = new Map(report.accounts.map((account) => [account.user, account]));
  const local = accounts.get("local@example.test");
  assert.equal(local.resets.count, 2);
  assert.equal(local.resets.until, soon);
  assert.deepEqual(local.resets.each.map((card) => card.id), ["credit-a", "credit-b"]);
  assert.deepEqual(local.resetTarget, { user: "local@example.test", provider: "" });
  assert.deepEqual(local.resetsUsed, [{ at: now, why: "week" }]);
  assert.deepEqual(accounts.get("remote@example.test").resetTarget, { user: "remote@example.test", provider: "office/codex" });
  const glm = accounts.get("team");
  assert.equal(glm.resets.count, 3);
  assert.equal(glm.resets.byWindow, true);
  assert.equal(glm.resetTarget, null);
  assert.equal(accounts.get("none").resets, null);
  assert.equal(report.apiAccounts[0].resets, null);
});

test("使用重置卡经本机网关并携带网关密钥，失败时给出原因", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "magpie-provider-quota-reset-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "plugins.json"), "{}");
  await writeFile(join(directory, "gateway.json"), JSON.stringify({ addr: "127.0.0.1:4321" }));
  const calls = [];
  let status = 200;
  const useReset = createResetter({
    configDir: directory,
    fetchImpl: async (url, init) => {
      calls.push({ url: url.href, init });
      const body = status === 200 ? { code: "reset", windows: 2 } : { error: { message: "needs full access" } };
      return { ok: status === 200, status, text: async () => JSON.stringify(body) };
    },
  });
  await assert.rejects(useReset({ user: "one@example.test" }), { code: "needs_key" });
  assert.equal(calls.length, 0);
  assert.deepEqual(await useReset({ user: "one@example.test", credit: "credit-b", key: "gk-test" }), { code: "reset", windows: 2 });
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.Authorization, "Bearer gk-test");
  assert.equal(calls[0].url, "http://127.0.0.1:4321/v1/magpie/quotas/codex-reset?user=one%40example.test&credit=credit-b");
  assert.deepEqual(JSON.parse(calls[0].init.body), { user: "one@example.test", credit: "credit-b" });
  status = 401;
  await assert.rejects(useReset({ user: "one@example.test", key: "gk-test" }), { code: "bad_key", message: "needs full access" });
});
