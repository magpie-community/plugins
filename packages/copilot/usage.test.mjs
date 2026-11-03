import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import { parseUsage } from "./usage.mjs";
import { CopilotAuthPlugin } from "./index.mjs";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
async function readUsage(getAuth, fetcher) {
  globalThis.fetch = fetcher;
  const hooks = await CopilotAuthPlugin({ client: {} });
  return hooks.auth.usage(getAuth);
}

const auth = { type: "oauth", refresh: "mock-oauth", access: "mock-inference" };
const getAuth = async () => ({ ...auth });
const response = (data, status = 200) => new Response(JSON.stringify(data), { status });
const premium = (quota, extra = {}) => ({
  copilot_plan: "business", login: "test-user", quota_reset_date: "2026-11-01",
  quota_snapshots: { premium_interactions: quota }, ...extra,
});

test("fractional credit quota, plan, identity and UTC reset", () => {
  const result = parseUsage(premium({
    token_based_billing: true, entitlement: 10000, quota_remaining: 7654.32,
    remaining: 7654, credits_used: 2346, percent_remaining: 76.5,
    quota_reset_at: 0, overage_permitted: true,
  }));
  const [window] = result.windows;
  assert.ok(Math.abs(window.amount - 2345.68) < 1e-8);
  assert.ok(Math.abs(window.used - 23.4568) < 1e-8);
  assert.equal(window.limit, 10000);
  assert.equal(window.name, "Premium credits");
  assert.equal(window.resetsAt, "2026-11-01T00:00:00.000Z");
  assert.equal(window.display, "2,345.68 / 10,000 credits used; 7,654.32 credits remaining");
  assert.equal(window.aside, false);
  assert.equal(result.balance, "7,654.32 credits remaining");
  assert.equal(result.plan, "business");
  assert.equal(result.user, "test-user");
});

test("legacy premium requests and zero remaining are not unlimited", () => {
  const [window] = parseUsage(premium({ entitlement: 300, remaining: 0 })).windows;
  assert.equal(window.used, 100);
  assert.equal(window.amount, 300);
  assert.equal(window.unit, "requests");
});

test("unlimited allowances are explicitly labelled and non-blocking", () => {
  const result = parseUsage({ quota_snapshots: {
    chat: { unlimited: true, entitlement: 0, remaining: 0 },
    completions: { unlimited: true },
  } });
  assert.equal(result.windows.length, 2);
  for (const window of result.windows) {
    assert.equal(window.display, "Unlimited");
    assert.equal(window.aside, true);
    assert.equal(window.used, 0);
    assert.equal(window.limit, undefined);
  }
});

test("unlimited premium credits show usage without inventing a seat budget", () => {
  for (const [creditsUsed, display] of [
    [0, "0 credits used"],
    [1234.5, "1,234.5 credits used"],
    ["1234.5", "1,234.5 credits used"],
  ]) {
    for (const hasQuota of [true, undefined]) {
      for (const [billing, root] of [
        [{ token_based_billing: true }, {}],
        [{}, { token_based_billing: true }],
      ]) {
        const result = parseUsage(premium({
          unlimited: true, has_quota: hasQuota, entitlement: "-1",
          percent_remaining: 100, credits_used: creditsUsed, ...billing,
        }, { copilot_plan: "enterprise", ...root }));
        assert.equal(result.windows.length, 1);
        const [window] = result.windows;
        assert.equal(window.display, display);
        assert.equal(window.name, "Premium credits");
        assert.equal(window.used, 0);
        assert.equal(window.aside, true);
        assert.equal(window.amount, undefined);
        assert.equal(window.limit, undefined);
        assert.equal(result.balance, undefined);
        assert.equal(result.error, undefined);
      }
    }
  }
});

test("unlimited allowances ignore unreadable credits and non-credit counters", () => {
  for (const creditsUsed of [undefined, null, "many", -1, NaN, Infinity, true]) {
    const [window] = parseUsage(premium({
      unlimited: true, credits_used: creditsUsed,
    }, { token_based_billing: true })).windows;
    assert.equal(window.display, "Unlimited");
    assert.equal(window.aside, true);
    assert.equal(window.limit, undefined);
  }
  const [requests] = parseUsage(premium({
    unlimited: true, token_based_billing: false, credits_used: 1234.5,
  }, { token_based_billing: true })).windows;
  assert.equal(requests.display, "Unlimited");
  const result = parseUsage({ token_based_billing: true, quota_snapshots: {
    chat: { unlimited: true, credits_used: 1234.5 },
    completions: { unlimited: true, credits_used: 1234.5 },
  } });
  assert.ok(result.windows.every((window) => window.display === "Unlimited"));
});

test("per-window resets override root reset in seconds and milliseconds", () => {
  for (const value of [1793491200, 1793491200000, "2026-11-01T00:00:00Z"]) {
    const [window] = parseUsage(premium({ percent_remaining: 50, quota_reset_at: value })).windows;
    assert.equal(window.resetsAt, "2026-11-01T00:00:00.000Z");
    assert.equal(window.used, 50);
  }
});

test("monthly free-plan legacy fields", () => {
  const result = parseUsage({
    monthly_quotas: { chat: 50, completions: 2000 },
    limited_user_quotas: { chat: 30, completions: 0 },
    limited_user_reset_date: "2026-11-01",
  });
  assert.deepEqual(result.windows.map((w) => w.used), [40, 100]);
});

test("paid overage is not added to the included allowance", () => {
  const [window] = parseUsage(premium({ entitlement: 300, remaining: 0, overage_count: 20 })).windows;
  assert.equal(window.amount, 300);
  assert.equal(window.used, 100);
});

test("unknown or malformed quota never becomes zero usage", () => {
  for (const quota of [{}, { entitlement: "many", remaining: "some" },
    { entitlement: 0, remaining: 0 }, { percent_remaining: NaN }]) {
    const result = parseUsage(premium(quota));
    assert.deepEqual(result.windows, []);
    assert.ok(result.error);
  }
});

test("unknown snapshot types do not create routing windows", () => {
  for (const quota of [
    { entitlement: 10, quota_remaining: 0, percent_remaining: 0, unlimited: false },
    { unlimited: true },
  ]) {
    const result = parseUsage({
      copilot_plan: "individual", quota_snapshots: { code_review: quota },
    });
    assert.deepEqual(result.windows, []);
    assert.ok(result.error);
    assert.equal(result.signIn, "kept");
  }
});

test("unknown snapshots do not change known chat and premium quotas", () => {
  const data = { quota_snapshots: {
    premium_interactions: { entitlement: 300, quota_remaining: 200 },
    chat: { unlimited: true },
    completions: { entitlement: 2000, remaining: 0 },
  } };
  const expected = parseUsage(data);
  data.quota_snapshots.code_review = { entitlement: 10, quota_remaining: 0 };
  assert.deepEqual(parseUsage(data), expected);
});

test("credits used alone cannot determine a finite seat's utilization", () => {
  for (const creditsUsed of [0, 400, "400", 2000]) {
    const result = parseUsage(premium({
      unlimited: false, entitlement: "1000", credits_used: creditsUsed,
    }, { token_based_billing: true }));
    assert.deepEqual(result.windows, []);
    assert.ok(result.error);
    assert.equal(result.balance, undefined);
    assert.equal(result.signIn, "kept");
  }
});

test("organization credits do not supply a denominator for a percent-only seat", () => {
  const result = parseUsage(premium({
    entitlement: "1000", percent_remaining: 25, credits_used: 1234.5,
  }, { token_based_billing: true }));
  const [window] = result.windows;
  assert.equal(window.used, 75);
  assert.equal(window.amount, undefined);
  assert.equal(window.limit, undefined);
  assert.equal(window.display, undefined);
  assert.equal(result.balance, undefined);
});

test("GitHub.com and Enterprise use their own OAuth endpoint without redirecting", async () => {
  for (const [enterpriseUrl, origin] of [
    [undefined, "https://api.github.com"],
    ["company.ghe.com", "https://api.company.ghe.com"],
    ["https://company.ghe.com/", "https://api.company.ghe.com"],
  ]) {
    let called = false;
    const result = await readUsage(async () => ({ ...auth, enterpriseUrl }), async (url, init) => {
      called = true;
      assert.equal(url, `${origin}/copilot_internal/user`);
      assert.equal(init.headers.Authorization, "token mock-oauth");
      assert.equal(init.redirect, "error");
      assert.ok(init.signal instanceof AbortSignal);
      return response(premium({ entitlement: 300, remaining: 200 }));
    });
    assert.ok(called);
    assert.equal(result.error, undefined);
  }
});

test("unsafe Enterprise URLs are rejected before sending credentials", async () => {
  for (const enterpriseUrl of ["http://company.ghe.com", "https://user@company.ghe.com",
    "https://company.ghe.com/path", "https://company.ghe.com?query=1"]) {
    let called = false;
    const result = await readUsage(async () => ({ ...auth, enterpriseUrl }), async () => {
      called = true;
      return response({});
    });
    assert.equal(called, false);
    assert.ok(result.error);
    assert.equal(result.signIn, "kept");
  }
});

test("root billing flag is a fallback, the snapshot's explicit flag takes precedence", () => {
  const data = premium({ entitlement: 300, remaining: 200, quota_remaining: 0,
    token_based_billing: false }, { token_based_billing: true });
  const [legacy] = parseUsage(data).windows;
  assert.equal(legacy.amount, 300);
  assert.equal(legacy.unit, "requests");
  delete data.quota_snapshots.premium_interactions.token_based_billing;
  const [credits] = parseUsage(data).windows;
  assert.equal(credits.amount, 300);
  assert.equal(credits.unit, "credits");
});

test("a percent-only snapshot does not invent an absolute balance", () => {
  const result = parseUsage(premium({ percent_remaining: 25 }));
  assert.equal(result.windows[0].used, 75);
  assert.equal(result.windows[0].amount, undefined);
  assert.equal(result.windows[0].limit, undefined);
  assert.equal(result.balance, undefined);
});

test("an entitlement with only a percentage does not display a fabricated zero count", () => {
  const result = parseUsage(premium({ entitlement: "1000", percent_remaining: 25 }));
  assert.equal(result.windows[0].used, 75);
  // The host defaults a missing amount to 0, so a limit must be omitted too.
  assert.equal(result.windows[0].limit, undefined);
  assert.equal(result.windows[0].amount, undefined);
});

test("personal premium overage is informational, limited completions never block chat", () => {
  const result = parseUsage(premium({ entitlement: 300, remaining: 0,
    overage_permitted: true }, { copilot_plan: "individual" }));
  assert.equal(result.windows[0].used, 100);
  assert.equal(result.windows[0].aside, true);
  const completions = parseUsage({ quota_snapshots: {
    completions: { entitlement: 2000, remaining: 0 },
  } }).windows[0];
  assert.equal(completions.used, 100);
  assert.equal(completions.aside, true);
});

test("numeric-string reset timestamps work and nonpositive timestamps fall back", () => {
  for (const value of ["1793491200", "1793491200000", "0", -1]) {
    const [window] = parseUsage(premium({ percent_remaining: 50, quota_reset_at: value })).windows;
    assert.equal(window.resetsAt, "2026-11-01T00:00:00.000Z");
  }
});

test("a quota read never persists or renews either token", async () => {
  const saved = [];
  const requests = [];
  const expired = { ...auth, access: "", expires: 0 };
  const before = structuredClone(expired);
  const hooks = await CopilotAuthPlugin({ client: { auth: { set: async (x) => saved.push(x) } } });
  globalThis.fetch = async (url, init) => {
    requests.push({ url, authorization: new Headers(init?.headers).get("authorization") });
    return response(premium({ entitlement: 300, remaining: 150 }));
  };
  const result = await hooks.auth.usage(async () => expired, { id: "github-copilot" });
  assert.equal(result.windows[0]?.used, 50);
  assert.deepEqual(requests, [{
    url: "https://api.github.com/copilot_internal/user", authorization: "token mock-oauth",
  }]);
  assert.deepEqual(saved, []);
  assert.deepEqual(expired, before);
});

test("an unreadable sign-in stays unknown without sending a request or exposing its error", async () => {
  let called = false;
  const result = await readUsage(async () => {
    throw new Error("mock-oauth credential store could not be read");
  }, async () => {
    called = true;
    return response({});
  });
  assert.equal(called, false);
  assert.equal(result.signIn, "kept");
  assert.deepEqual(result.windows, []);
  assert.ok(result.error);
  assert.ok(!JSON.stringify(result).includes("mock-oauth"));
});

test("only an explicit HTTP 401 expires the sign-in", async () => {
  for (const status of [401, 403, 429, 500]) {
    const result = await readUsage(getAuth, async () => response({}, status));
    assert.equal(result.signIn, status === 401 ? "expired" : "kept");
    assert.deepEqual(result.windows, []);
    assert.match(result.error, new RegExp(String(status)));
  }
});

test("network and invalid JSON errors do not reveal tokens or mark account expired", async () => {
  for (const fetcher of [
    async () => { throw new Error("mock-oauth secret request headers"); },
    async () => new Response("not json"),
    async () => response(null),
  ]) {
    const result = await readUsage(getAuth, fetcher);
    assert.equal(result.signIn, "kept");
    assert.ok(result.error);
    assert.ok(!JSON.stringify(result).includes("mock-oauth"));
    assert.deepEqual(result.windows, []);
  }
});

test("missing sign-in does not make a request or change auth", async () => {
  for (const value of [undefined, {}, { type: "api", key: "mock" }]) {
    let called = false;
    const result = await readUsage(async () => value, async () => {
      called = true;
      return response({});
    });
    assert.equal(called, false);
    assert.ok(result.error);
    assert.equal(result.signIn, "kept");
  }
});

// These seat shapes also occur in magpie's built-in Copilot regression tests
// (internal/provider/copilot_usage_test.go, #1063); all values here are synthetic.
test("Business string counters still count when has_quota is false", () => {
  const result = parseUsage(premium({
    unlimited: false, has_quota: false, entitlement: "1000",
    quota_remaining: "250", percent_remaining: 25,
  }, { token_based_billing: true }));
  assert.equal(result.windows.length, 1);
  assert.equal(result.windows[0].used, 75);
  assert.equal(result.windows[0].amount, 750);
  assert.equal(result.windows[0].limit, 1000);
  assert.equal(result.balance, "250 credits remaining");
});

test("managed seats remain blocking even when overage_permitted is true", () => {
  for (const plan of ["business", "enterprise"]) {
    const result = parseUsage(premium({
      unlimited: false, has_quota: false, entitlement: "1000",
      percent_remaining: 0, overage_permitted: true,
    }, { copilot_plan: plan }));
    assert.equal(result.windows[0]?.used, 100);
    assert.ok(!result.windows[0]?.aside);
  }
});

test("an exhausted Enterprise pool is not unlimited", () => {
  const result = parseUsage(premium({
    unlimited: true, has_quota: false, entitlement: "0", percent_remaining: 0,
    credits_used: 1234.5,
  }, { copilot_plan: "enterprise", token_based_billing: true }));
  assert.equal(result.windows[0]?.used, 100);
  assert.notEqual(result.windows[0]?.display, "Unlimited");
  assert.ok(!result.windows[0]?.aside);
  assert.equal(result.windows[0]?.resetsAt, "2026-11-01T00:00:00.000Z");
});

test("unlimited chat remains unlimited when has_quota is false", () => {
  const result = parseUsage({ quota_snapshots: {
    chat: { unlimited: true, has_quota: false, entitlement: "0" },
    completions: { unlimited: true, has_quota: false, entitlement: "0" },
  } });
  assert.equal(result.windows.length, 2);
  assert.ok(result.windows.every((w) => w.display === "Unlimited" && w.aside));
});

test("a free seat omits absent premium allowance but counts chat and completion percentages", () => {
  const result = parseUsage({ copilot_plan: "free", token_based_billing: true,
    quota_snapshots: {
      chat: { unlimited: false, has_quota: false, entitlement: "200", percent_remaining: 80 },
      completions: { unlimited: false, has_quota: false, entitlement: "4000", percent_remaining: 100 },
      premium_interactions: { unlimited: false, has_quota: false, entitlement: "0", percent_remaining: 0 },
    },
  });
  assert.deepEqual(result.windows.map((w) => w.name), ["Chat", "Completions"]);
  assert.deepEqual(result.windows.map((w) => w.used), [20, 0]);
  assert.equal(result.windows[1].aside, true);
});

// plugins#618 (jinpy666): an idle slot magpie had marked for its dropped
// inference token is told signed in again by a quota read GitHub answers
// with the OAuth token; a 401 there still marks it.
test("a quota read GitHub answers clears a stale mark, a 401 still sets one", async () => {
  const ok = await readUsage(getAuth, async () => response(premium({ entitlement: 300, remaining: 200 })));
  assert.equal(ok.signIn, "renewed");
  const unreadable = await readUsage(getAuth, async () => response({ copilot_plan: "business" }));
  assert.equal(unreadable.signIn, "renewed");
  assert.ok(unreadable.error);
  const refused = await readUsage(getAuth, async () => response({}, 401));
  assert.equal(refused.signIn, "expired");
});
