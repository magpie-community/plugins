import { describe, expect, test } from "bun:test";
import sample from "./fixtures/usage.json";
import { quotaFrom } from "../src/quota.mjs";

const now = Date.parse("2026-11-02T07:00:00Z");
const reading = () => structuredClone(sample);

describe("DimAgent allowance mapping", () => {
  test("observed credits, search allowance and expiry retain their meaning", () => {
    const q = quotaFrom(reading(), now);
    expect(q.plan).toBe("Max套餐");
    expect(q.user).toBe("1");
    expect(q.windows[0]).toMatchObject({ name: "Credits", used: 2.64, amount: 2640, limit: 100000, runsOut: 97360 });
    expect(q.windows[0].runsOutAt).toBe(sample.credits.subscription_bucket.expires_at);
    expect(q.windows[0].resetsAt).toBe(sample.subscription.current_term.end_at);
    expect(q.windows[0].span).toBeUndefined();
    expect(q.windows[1]).toMatchObject({ name: "Web Search", amount: 560, limit: 5500, aside: true });
    expect(q.windows[1].span).toBeUndefined();
    expect(q.until).toBe(sample.subscription.current_term.end_at);
  });

  test("an expiry alone is not a subscription cycle", () => {
    const data = reading();
    delete data.subscription.current_term;
    const q = quotaFrom(data, now);
    expect(q.windows[0].resetsAt).toBeUndefined();
    expect(q.windows[0].span).toBeUndefined();
    expect(q.windows[0].runsOutAt).toBe(sample.credits.subscription_bucket.expires_at);
    expect(q.windows[1].span).toBeUndefined();
  });

  test("unrelated term or search period never borrows the plan's cycle", () => {
    const data = reading();
    data.subscription.current_term.credit_bucket_id = 99;
    data.feature_meters[0].period_end = "2026-11-20T00:00:00Z";
    const q = quotaFrom(data, now);
    expect(q.windows[0].resetsAt).toBeUndefined();
    expect(q.windows[0].span).toBeUndefined();
    expect(q.windows[1].span).toBeUndefined();
  });

  test("search can report its own cycle, independent of the plan", () => {
    const data = reading();
    Object.assign(data.feature_meters[0], { period_start: "2026-11-01T00:00:00Z", period_end: "2026-11-08T00:00:00Z" });
    expect(quotaFrom(data, now).windows[1].span).toBe(7 * 86400);
  });

  test("missing bucket identity or a different expiry cannot identify the term", () => {
    const data = reading();
    delete data.subscription.current_term.credit_bucket_id;
    delete data.credits.subscription_bucket.id;
    expect(quotaFrom(data, now).windows[0].resetsAt).toBeUndefined();
    data.subscription.current_term.credit_bucket_id = 1;
    data.credits.subscription_bucket.id = 1;
    data.credits.subscription_bucket.expires_at = "2026-11-12T00:00:00Z";
    expect(quotaFrom(data, now).windows[0].resetsAt).toBeUndefined();
  });

  test("billing dates do not supply a credit or search measurement start", () => {
    const data = reading();
    delete data.subscription.current_term.start_at;
    expect(quotaFrom(data, now).windows[0].span).toBeUndefined();
    data.subscription.current_term.start_at = "2026-11-14T00:00:00Z";
    expect(quotaFrom(data, now).windows[0].span).toBeUndefined();
    expect(quotaFrom(data, now).windows[1].span).toBeUndefined();
  });

  test("a reversed reported allowance window is rejected", () => {
    const data = reading();
    data.feature_meters[0].period_start = "2026-11-14T00:00:00Z";
    expect(() => quotaFrom(data, now)).toThrow("周期");
  });

  test("zero usage is a real zero, missing usage is not", () => {
    const data = reading();
    data.credits.subscription_bucket.used_units = 0;
    expect(quotaFrom(data, now).windows[0].used).toBe(0);
    delete data.credits.subscription_bucket.used_units;
    expect(() => quotaFrom(data, now)).toThrow("计数");
  });

  test.each([0, 100000])("unlimited Credits have no invented share even with total %s", (total) => {
    const data = reading();
    Object.assign(data.credits.subscription_bucket, {
      unlimited: true, total_units: total, used_units: 0, remaining_units: 0,
      window_states: [{
        window_duration_hours: 5, window_token_used: 300, window_token_cap: 1000,
        window_expires_at: "2026-11-02T10:00:00Z",
      }],
    });
    const q = quotaFrom(data, now);
    expect(q.windows[0]).toEqual({ name: "Credits", display: "Unlimited" });
    expect(q.windows[1]).toMatchObject({ name: "Credits · 5h", used: 30, limit: 1000 });
    expect(q.until).toBe(data.subscription.current_term.end_at);
  });

  test.each([[null], [{}], [{ credits: {} }], [[]]])("unrecognized data is an error: %j", (data) => {
    expect(() => quotaFrom(data, now)).toThrow();
  });

  test.each([0, -1, "100000", Infinity])("invalid denominator %s is not an allowance", (value) => {
    const data = reading();
    data.credits.subscription_bucket.total_units = value;
    expect(() => quotaFrom(data, now)).toThrow("计数");
  });

  test("packs remain separate from the plan", () => {
    const data = reading();
    data.credits.addon_buckets = [{
      id: 7, status: "active", total_units: 1000, used_units: 200, remaining_units: 800,
      expires_at: "2026-12-01T00:00:00Z",
    }];
    const q = quotaFrom(data, now);
    expect(q.windows[0].limit).toBe(100000);
    expect(q.windows[1]).toMatchObject({ name: "Add-on 7", used: 20, runsOut: 800, runsOutAt: "2026-12-01T00:00:00.000Z" });
    expect(q.windows[1].resetsAt).toBeUndefined();
  });

  test("rate windows report tokens and actual reset times", () => {
    const data = reading();
    data.credits.subscription_bucket.window_states = [{
      window_duration_hours: 5, window_token_used: 300, window_token_cap: 1000,
      window_expires_at: "2026-11-02T10:00:00Z",
    }];
    expect(quotaFrom(data, now).windows[1]).toMatchObject({
      name: "Credits · 5h", used: 30, span: 18000, unit: "tokens", resetsAt: "2026-11-02T10:00:00.000Z",
    });
  });

  test("expired readings do not become zero usage", () => {
    expect(() => quotaFrom(reading(), Date.parse("2027-01-01"))).toThrow("当前可用");
  });

  test("unlimited search has no invented percentage", () => {
    const data = reading();
    data.feature_meters[0].unlimited = true;
    expect(quotaFrom(data, now).windows).toHaveLength(1);
  });

  test("invalid dates and duplicate packs are reported", () => {
    const data = reading();
    data.credits.subscription_bucket.expires_at = "not a date";
    expect(() => quotaFrom(data, now)).toThrow("日期");
    const duplicate = reading();
    const pack = { ...duplicate.credits.subscription_bucket, id: 7 };
    duplicate.credits.addon_buckets = [pack, pack];
    expect(() => quotaFrom(duplicate, now)).toThrow("重复");
  });
});
