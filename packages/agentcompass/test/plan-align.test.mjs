// Magpie follows AgentCompass's plan templates and status fields (references/plan-templates.json is the authority).
import assert from "node:assert/strict";
import test from "node:test";

import { listQuotaAccounts, normalizeQuotaSnapshot } from "../src/index.js";
import { buildFleet } from "../src/fleet.js";
import { PLAN_CAPACITY } from "../src/reference-data.js";

const T0 = 1_700_000_000_000;
const HOUR = 3600 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const win = (over = {}) => ({ name: "7d", remaining: 80, used: 20, resetHours: 100, ...over });

const account = (provider, plan, windowName = "7d", extra = {}) => {
  const entries = normalizeQuotaSnapshot({ [`${provider}/a`]: { kind: "subscription", plan, ...extra, quota: { windows: [win({ name: windowName })] } } }, T0);
  return { entry: entries[0], spec: buildFleet({ entries, nowMs: T0 }).fleet.accounts[`${provider}/a`] };
};
const cap = (provider, plan, windowId) => account(provider, plan, windowId).spec.capacity_usd[windowId];
const entry = (provider, plan) => account(provider, plan).entry;

test("a plan's window capacity is the pinned community data's, for every plan and window the data holds", () => {
  let checked = 0;
  for (const [family, plans] of Object.entries(PLAN_CAPACITY)) {
    for (const [plan, windows] of Object.entries(plans)) {
      for (const [id, row] of Object.entries(windows)) {
        if (row.capacity_usd === null) continue;
        assert.equal(cap(family, plan, id), row.capacity_usd, `${family} ${plan} ${id}`);
        checked++;
      }
    }
  }
  assert.ok(checked > 20);
});

test("a window the plan does not have is observation-only: no capacity of its own", () => {
  // Codex Pro has one weekly pool; a five-hour reading on it is not sized
  assert.equal(account("codex", "pro", "five_hour").spec.capacity_usd.five_hour, undefined);
  assert.equal(cap("codex", "pro", "usage"), PLAN_CAPACITY.codex.pro.usage.capacity_usd);
});

test("a plan's other names resolve to it: team seats, prolite, a bare max", () => {
  assert.equal(cap("codex", "team", "five_hour"), PLAN_CAPACITY.codex.plus.five_hour.capacity_usd, "team seats use the Plus prior");
  assert.equal(cap("codex", "prolite", "usage"), PLAN_CAPACITY.codex.pro100.usage.capacity_usd);
  assert.equal(entry("claude", "max").planKnown, true);
  assert.equal(cap("claude", "max", "seven_day"), PLAN_CAPACITY.claude.max.seven_day.capacity_usd);
});

test("an unknown plan is no plan: capacity unknown, and no smaller tier stands in for it", () => {
  const { entry: e, spec } = account("antigravity", "mystery", "gemini-weekly");
  assert.equal(e.planKnown, false);
  assert.equal(spec.capacity_unknown, true);
  assert.deepEqual(spec.capacity_usd, {});
});

test("status rows carry status, reason, last_success_at, and the usage_failing fields", () => {
  const q = {
    "codex/ok": { kind: "subscription", plan: "plus", fetched_at: iso(T0 - 60_000), quota: { windows: [win()] } },
    "codex/bad": {
      kind: "subscription",
      plan: "plus",
      error: "boom",
      last_success_at: iso(T0 - HOUR),
      failing_since: iso(T0 - 30 * 60_000),
      quota: { windows: [win()] },
    },
    "codex/gone": {
      kind: "subscription",
      plan: "plus",
      error: "boom",
      last_success_at: iso(T0 - 7 * HOUR),
      quota: { windows: [win()] },
    },
  };
  const [ok, bad, gone] = listQuotaAccounts(q, T0);
  assert.equal(ok.status, "ready");
  assert.equal(ok.failing_since, undefined);
  assert.equal(ok.exclude_after_hours, undefined);
  assert.equal(ok.usage_excluded, undefined);

  assert.equal(bad.status, "usage_failing");
  assert.match(bad.reason, /boom/);
  assert.equal(bad.last_success_at, iso(T0 - HOUR));
  assert.equal(bad.failing_since, iso(T0 - 30 * 60_000), "an explicit failing_since is kept");
  assert.equal(bad.exclude_after_hours, 6);
  assert.equal(bad.usage_excluded, false);

  assert.equal(gone.failing_since, iso(T0 - 7 * HOUR), "without one, failing starts at the last success");
  assert.equal(gone.usage_excluded, true);
});

test("thresholds: error warns at once; no error but no fresh reading for 2h is failing; 6h excludes", () => {
  const at = (ageH, extra = {}) =>
    listQuotaAccounts(
      { "codex/a": { kind: "subscription", plan: "plus", fetched_at: iso(T0 - ageH * HOUR), quota: { windows: [win()] }, ...extra } },
      T0
    )[0];
  assert.equal(at(1.9).status, "ready");
  const stale = at(2.5);
  assert.equal(stale.status, "usage_failing");
  assert.equal(stale.usage_excluded, false);
  assert.equal(stale.dispatchable, true);
  assert.equal(at(6.5).usage_excluded, true);
  assert.equal(at(0.1, { error: "x", last_success_at: iso(T0 - 0.1 * HOUR) }).status, "usage_failing");
});

test("thresholds are configurable (usage_fresh_hours, usage_max_age_hours)", () => {
  const base = { "codex/a": { kind: "subscription", plan: "plus", fetched_at: iso(T0 - 3 * HOUR), quota: { windows: [win()] } } };
  assert.equal(listQuotaAccounts({ ...base, usage_fresh_hours: 4 }, T0)[0].status, "ready");
  const row = listQuotaAccounts({ ...base, usage_max_age_hours: 3.5, usage_fresh_hours: 1 }, T0)[0];
  assert.equal(row.exclude_after_hours, 3.5);
  assert.equal(row.usage_excluded, false);
  assert.equal(listQuotaAccounts({ ...base, usage_max_age_hours: 2.5, usage_fresh_hours: 1 }, T0)[0].usage_excluded, true);
});

test("plan: the online plan wins and a disagreement is exposed as plan_conflict", () => {
  const row = (item) =>
    listQuotaAccounts({ "codex/a": { kind: "subscription", quota: { windows: [win()] }, ...item } }, T0)[0];
  const conflict = row({ plan: "plus", plan_claim: "pro" });
  assert.deepEqual(conflict.plan_conflict, { online: "plus", credential: "pro" });
  assert.equal(cap("codex", "plus", "usage"), PLAN_CAPACITY.codex.plus.usage.capacity_usd);
  assert.equal(row({ plan: "plus", plan_claim: "plus" }).plan_conflict, undefined);
  assert.equal(row({ plan: "plus" }).plan_conflict, undefined);

  // No online plan: the credential claim is the fallback, and there is nothing to conflict with.
  const entries = normalizeQuotaSnapshot({ "codex/a": { kind: "subscription", plan_claim: "pro", quota: { windows: [win({ name: "usage" })] } } }, T0);
  assert.equal(buildFleet({ entries, nowMs: T0 }).fleet.accounts["codex/a"].capacity_usd.usage, PLAN_CAPACITY.codex.pro.usage.capacity_usd);
  assert.equal(entries[0].planKnown, true);
  assert.equal(entries[0].planConflict, null);
});
