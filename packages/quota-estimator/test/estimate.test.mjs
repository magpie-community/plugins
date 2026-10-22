import test from "node:test";
import assert from "node:assert/strict";
import { estimateAccount, pricesFrom, priceRecord } from "../estimate.mjs";

const now = Date.parse("2026-10-21T09:00:00Z");
const prices = pricesFrom({ openai: { models: { "gpt-test": { cost: {
  input: 2, output: 10, cache_read: .2, cache_write: 2.5,
  tiers: [{ input: 4, output: 15, cache_read: .4, cache_write: 5, tier: { type: "context", size: 1000 } }],
} } } }, anthropic: { models: { "claude-test": { cost: { input: 4, output: 20, cache_read: .4, cache_write: 5 } } } } });
const record = (extra = {}) => ({ provider: "codex", providerAccount: "one@example.test", rid: "r1",
  t: "2026-10-21T08:00:00Z", model: "gpt-test", in: 100, out: 50, cache_read: 400, cache_write: 0, status: 200, ...extra });
const quota = (extra = {}) => ({ provider: "codex", user: "one@example.test", balance: "100 credits",
  readAt: "2026-10-21T09:00:00Z", windows: [
    { name: "5 hours", used: 25, resetsAt: "2026-10-21T10:00:00Z" },
    { name: "7 days", used: 50, resetsAt: "2026-10-27T09:00:00Z" },
  ], ...extra });
const run = (extra = {}) => estimateAccount({ quota: quota(), rows: [record()], prices, now,
  title: "本机 Codex · 账号 1", firstRecordAt: now - 14 * 86400000, ...extra });

test("余额不妨碍估算；两个窗口独立使用官方比例，Token 包含缓存", () => {
  const [five, week] = run();
  assert.equal(five.tokens, 2200);
  assert.equal(week.tokens, 1100);
  assert.equal(five.observedTokens, 550);
  assert.ok(Math.abs(five.cost - .00312) < 1e-12);
  assert.equal(five.state, "estimated");
});

test("只累加该账号、该窗口、采样之前的有效调用；分页重复只计一次", () => {
  const rows = [record(), record(), record({ rid: "other", providerAccount: "two@example.test" }),
    record({ rid: "before", t: "2026-10-20T20:00:00Z" }),
    record({ rid: "after", t: "2026-10-21T09:01:00Z" }), record({ rid: "failed", status: 500 }),
    record({ rid: "reported", source: "reported" }), record({ rid: "unknown", providerAccount: undefined })];
  const [five, week] = run({ rows });
  assert.equal(five.calls, 1);
  assert.equal(week.calls, 2);
});

test("缺少5小时窗口时不拿周额度推算", () => {
  const [five, week] = run({ quota: quota({ windows: quota().windows.slice(1) }) });
  assert.equal(five.tokens, null);
  assert.match(five.reason, /未上报/);
  assert.equal(week.tokens, 1100);
});

test("过期、陈旧、异常比例和低比例不输出满额数字", () => {
  for (const q of [quota({ readAt: "2026-10-20T08:00:00Z" }), quota({ readAt: "tomorrow" }),
    quota({ windows: [{ name: "5 hours", used: 150, resetsAt: "2026-10-21T10:00:00Z" }] }),
    quota({ windows: [{ name: "5 hours", used: 3, resetsAt: "2026-10-21T10:00:00Z" }] })]) {
    assert.ok(run({ quota: q }).every(x => x.tokens === null));
  }
  assert.equal(run({ now: now + 3600000 })[0].tokens, null);
});

test("未知价格不冒充免费，实际服务模型优先，日志覆盖不足明确标注", () => {
  const [five] = run({ rows: [record({ served: "no-price" })], firstRecordAt: now - 1000 });
  assert.equal(five.tokens, 2200);
  assert.equal(five.cost, null);
  assert.equal(five.unpriced, 1);
  assert.equal(five.partial, true);
});

test("缓存分档价格按整段上下文触发，1小时写入不重复计算", () => {
  assert.equal(priceRecord(record({ in: 1000, out: 0, cache_read: 0 }), prices), .002);
  assert.equal(priceRecord(record({ in: 1000, out: 0, cache_read: 1 }), prices), .0040004);
  const cost = priceRecord(record({ model: "claude-test", in: 0, out: 0, cache_read: 0,
    cache_write: 100, cache_write_1h: 60 }), prices);
  assert.equal(cost, .00068);
});

test("实际积分付费、额度耗尽后调用均不可冒充订阅消耗", () => {
  assert.match(run({ rows: [record({ credits: 1 })] })[0].reason, /额外付费/);
  const history = [{ name: "7 days", points: [{ at: "2026-10-21T07:00:00Z", left: 0 }] }];
  assert.equal(run({ history })[0].tokens, null);
});

test("固定截止时间内重置后，只计新额度段并标记观察边界的不确定性", () => {
  const history = [{ name: "5 hours", points: [
    { at: "2026-10-21T06:00:00Z", left: 10, resetsAt: "2026-10-21T10:00:00Z" },
    { at: "2026-10-21T07:00:00Z", left: 100, resetsAt: "2026-10-21T10:00:00Z" },
  ] }];
  const [five] = run({ history, rows: [record(), record({ rid: "old", t: "2026-10-21T06:30:00Z" })] });
  assert.equal(five.calls, 1);
  assert.equal(five.partial, true);
});

test("非法Token不传播NaN或负数，恶意价格不产生伪造美元", () => {
  const [five] = run({ rows: [record({ in: -1 })] });
  assert.equal(five.tokens, null);
  assert.equal(priceRecord(record(), new Map([["gpt-test", { input: -1, output: 10, cache_read: 1 }]])), null);
});

test("内部 auto-review 仅复用 Magpie 明确声明的价格别名，不猜相似模型", () => {
  const p = pricesFrom({ openai: { models: { "gpt-5.6-luna": { cost: { input: .2, output: 1.2, cache_read: .02 } } } } });
  assert.equal(priceRecord(record({ model: "codex-auto-review", cache_read: 0 }), p), .00008);
  assert.equal(priceRecord(record({ model: "codex-auto-review-fast" }), p), null);
});
