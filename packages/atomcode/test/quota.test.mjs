import { test } from "node:test";
import assert from "node:assert/strict";

import { strings } from "../i18n.mjs";
import { quotaFromStatus } from "../quota.mjs";

const t = strings("en");

test("quotaFromStatus maps every rate-limit window", () => {
  const usage = quotaFromStatus(
    {
      codingplan_free: {
        plan_name: "CodingPlan Pro",
        expires_at: "2026-12-01",
      },
      current_usage: {
        usage_percent: 99,
        reset_at: "2026-11-01T10:00:00Z",
      },
      rate_limit_windows: [
        {
          window_hours: 5,
          call_limit: 200,
          calls_used: 50,
          usage_percent: 25,
          seconds_until_reset: 1200,
        },
        {
          window_size_seconds: 86400,
          call_limit: 1000,
          calls_used: 250,
          usage_percent: 25,
        },
      ],
    },
    t,
    { user: "alice" },
  );

  assert.equal(usage.plan, "CodingPlan Pro");
  assert.equal(usage.user, "alice");
  assert.equal(usage.until, "2026-12-01T15:59:59.999Z");
  assert.equal(usage.windows.length, 2);
  assert.deepEqual(usage.windows[0], {
    name: "5h window",
    used: 25,
    span: 18000,
    amount: 50,
    unit: "calls",
    limit: 200,
    display: "50 / 200 calls",
    resetSecs: 1200,
  });
  assert.equal(usage.windows[1].name, "24h window");
  assert.equal(usage.windows[1].display, "250 / 1000 calls");
});

test("quotaFromStatus falls back to current_usage when no window rows exist", () => {
  const usage = quotaFromStatus(
    {
      codingplan_free: { plan_name: "CodingPlan Lite" },
      current_usage: {
        usage_percent: 120,
        window_hours: 3,
        seconds_until_reset: 60,
      },
    },
    t,
  );
  assert.deepEqual(usage.windows, [
    {
      name: "3h window",
      used: 120,
      span: 10800,
      unit: "calls",
      resetSecs: 60,
    },
  ]);
});

test("quotaFromStatus returns a stable empty shape for malformed status", () => {
  assert.deepEqual(quotaFromStatus(null, t), {
    plan: "AtomCode CodingPlan",
    windows: [],
  });
});

test("quotaFromStatus keeps unknown shares unknown and trusts each window's own data", () => {
  const usage = quotaFromStatus(
    {
      codingplan_free: { plan_name: "Plan", remaining_days: null, expires_at: "2099-12-31" },
      current_usage: { usage_percent: 99, window_hours: 5, reset_at: "2099-12-31T10:00:00" },
      rate_limit_windows: [
        { window_hours: 5, call_limit: 100, usage_percent: 12, reset_at: "2099-12-31T10:00:00" },
        { window_hours: 24 },
      ],
    },
    t,
  );
  assert.equal(usage.windows[0].used, 12);
  assert.equal(usage.windows[0].amount, undefined);
  assert.equal(usage.windows[1].used, undefined);
  assert.equal(usage.windows[1].amount, undefined);
});

test("quotaFromStatus adds a token window when the current window declares tokens", () => {
  const usage = quotaFromStatus(
    {
      codingplan_free: { plan_name: "Plan" },
      current_usage: {
        unit: "tokens",
        window_hours: 5,
        window_tokens_used: 250000,
        window_token_limit: 1000000,
        seconds_until_reset: 60,
      },
      rate_limit_windows: [],
    },
    t,
  );
  assert.equal(usage.windows.length, 1);
  assert.equal(usage.windows[0].unit, "tokens");
  assert.equal(usage.windows[0].used, 25);
  assert.equal(usage.windows[0].amount, 250000);
  assert.equal(usage.windows[0].limit, 1000000);
});

test("quotaFromStatus ignores legacy token-named call counters in current_usage", () => {
  const usage = quotaFromStatus(
    {
      codingplan_free: { plan_name: "Plan" },
      current_usage: {
        window_hours: 5,
        window_tokens_used: 237,
        window_token_limit: 1600,
        usage_percent: 14,
        seconds_until_reset: 60,
      },
      rate_limit_windows: [
        {
          window_size_seconds: 18000,
          window_hours: 5,
          call_limit: 1600,
          calls_used: 237,
          usage_percent: 14,
          seconds_until_reset: 60,
        },
      ],
    },
    t,
  );
  assert.equal(usage.windows.length, 1);
  assert.equal(usage.windows[0].unit, "calls");
  assert.equal(usage.windows[0].amount, 237);
  assert.equal(usage.windows[0].limit, 1600);
});

test("quotaFromStatus separates token and call rows and honours explicit units", () => {
  const usage = quotaFromStatus(
    {
      codingplan_free: { plan_name: "Plan" },
      current_usage: {
        usage_percent: 20,
        window_tokens_used: 500,
        window_token_limit: 1000,
        window_hours: 5,
      },
      rate_limit_windows: [
        {
          unit: "tokens",
          window_hours: 24,
          tokens_used: 400,
          token_limit: 2000,
          token_usage_percent: 20,
        },
        {
          unit: "calls",
          window_hours: 5,
          requests_used: 10,
          requests_limit: 100,
        },
        {
          window_hours: 7,
          call_limit: 50,
          calls_used: 5,
        },
      ],
    },
    t,
  );
  assert.deepEqual(
    usage.windows.map((window) => [window.unit, window.span, window.used]),
    [
      ["tokens", 86400, 20],
      ["calls", 18000, 10],
      ["calls", 25200, 10],
    ],
  );
  assert.equal(usage.windows[0].display, "400 / 2000 tokens");
  assert.equal(usage.windows[1].display, "10 / 100 calls");
});

test("quotaFromStatus deduplicates current_usage by unit, not span alone", () => {
  const usage = quotaFromStatus(
    {
      codingplan_free: { plan_name: "Plan" },
      current_usage: {
        usage_percent: 30,
        window_hours: 5,
        window_tokens_used: 300,
        window_token_limit: 1000,
      },
      rate_limit_windows: [
        {
          unit: "tokens",
          window_hours: 5,
          tokens_used: 300,
          token_limit: 1000,
        },
      ],
    },
    t,
  );
  assert.deepEqual(
    usage.windows.map((window) => [window.unit, window.span, window.used]),
    [
      ["tokens", 18000, 30],
      ["calls", 18000, 30],
    ],
  );
});

const PLACEHOLDER_STATUS = {
  codingplan_free: {
    plan_name: "CodingPlan Lite",
    plan_type: null,
    status: -1,
    claimed_at: null,
    expires_at: null,
    remaining_days: null,
    total_days: 30,
    apply_id: null,
  },
  current_usage: {
    placeholder: true,
    window_token_limit: null,
    window_tokens_used: 0,
    usage_percent: 0,
    window_hours: null,
    reset_at: "",
    reset_at_display: "",
    seconds_until_reset: 0,
    reset_label: null,
    usage_status_desc: null,
  },
  rate_limit_windows: [],
};

test("quotaFromStatus：占位套餐不把 usage_percent 0 编成 5 小时额度", () => {
  const usage = quotaFromStatus(PLACEHOLDER_STATUS, strings("zh"), { user: "alice" });
  assert.equal(usage.plan, "CodingPlan Lite");
  assert.equal(usage.user, "alice");
  assert.equal(usage.until, undefined);
  assert.deepEqual(usage.windows, []);
  assert.equal(usage.error, strings("zh").planUnconfirmed);
});

test("quotaFromStatus：未确认且没有真实窗口时同样不编造额度", () => {
  const usage = quotaFromStatus(
    {
      codingplan_free: {
        plan_name: "CodingPlan Lite",
        status: -1,
        claimed_at: null,
        expires_at: null,
        remaining_days: null,
      },
      current_usage: { usage_percent: 0 },
      rate_limit_windows: [],
    },
    t,
  );
  assert.deepEqual(usage.windows, []);
  assert.equal(usage.error, t.planUnconfirmed);
});

test("quotaFromStatus：真实 0%、耗尽 100% 和付费档仍映射窗口", () => {
  const fresh = quotaFromStatus(
    {
      codingplan_free: { plan_name: "CodingPlan Lite-体验版", expires_at: "2099-10-20", remaining_days: 4 },
      current_usage: { usage_percent: 0, window_hours: 5, seconds_until_reset: 1000 },
      rate_limit_windows: [],
    },
    t,
  );
  assert.equal(fresh.error, undefined);
  assert.equal(fresh.windows.length, 1);
  assert.equal(fresh.windows[0].used, 0);
  assert.equal(fresh.windows[0].name, "5h window");

  const exhausted = quotaFromStatus(
    {
      codingplan_free: { plan_name: "CodingPlan Pro", remaining_days: 12, expires_at: "2099-12-01" },
      current_usage: { usage_percent: 100, window_hours: 5, seconds_until_reset: 30 },
      rate_limit_windows: [],
    },
    t,
  );
  assert.equal(exhausted.error, undefined);
  assert.equal(exhausted.windows.length, 1);
  assert.equal(exhausted.windows[0].used, 100);
  assert.equal(exhausted.plan, "CodingPlan Pro");
});

test("quotaFromStatus：占位用量旁的真实限流窗口仍然保留", () => {
  const usage = quotaFromStatus(
    {
      codingplan_free: {
        plan_name: "CodingPlan Pro",
        status: 1,
        remaining_days: 10,
        expires_at: "2099-01-01",
      },
      current_usage: { placeholder: true, usage_percent: 0, window_hours: null },
      rate_limit_windows: [
        { window_hours: 5, call_limit: 200, calls_used: 0, usage_percent: 0, seconds_until_reset: 50 },
      ],
    },
    t,
  );
  assert.equal(usage.error, undefined);
  assert.equal(usage.windows.length, 1);
  assert.equal(usage.windows[0].used, 0);
  assert.equal(usage.windows[0].limit, 200);
});

test("quotaFromStatus keeps an explicit token window unknown instead of inventing zero", () => {
  const usage = quotaFromStatus(
    {
      codingplan_free: { plan_name: "Plan" },
      current_usage: {},
      rate_limit_windows: [{ unit: "tokens", window_hours: 3 }],
    },
    t,
  );
  assert.equal(usage.windows.length, 1);
  assert.equal(usage.windows[0].unit, "tokens");
  assert.equal(usage.windows[0].used, undefined);
  assert.equal(usage.windows[0].amount, undefined);
});
