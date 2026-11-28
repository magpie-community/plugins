import { test } from "node:test";
import assert from "node:assert/strict";

import { AtomCodePlugin } from "../index.mjs";

/**
 * Public seams: auth.refresh, provider.models, auth.usage, and loader.fetch.
 *
 * A host polls these every few seconds. After the OAuth broker answers 502,
 * those polls must not call the broker again until an exponential backoff
 * (cap + jitter) has elapsed, and a success or a new refresh token starts
 * the wait over. Permanent OAuth refusals (4xx / invalid_grant) are not
 * probed again until the credential itself changes.
 */

const GATEWAY = "https://llm-api.atomgit.com/v1/chat/completions";
const DAY_MS = 24 * 60 * 60 * 1000;

function account(over = {}) {
  return {
    type: "oauth",
    access: "tok",
    refresh: "refresh-1",
    uid: "u1",
    expires: Date.now() - 1000,
    ...over,
  };
}

const LIVE_STATUS = JSON.stringify({
  codingplan_free: {
    plan_name: "CodingPlan Lite",
    remaining_days: 4,
    expires_at: "2099-01-01",
  },
});
const LIVE_MODELS = JSON.stringify([
  { display_model_name: "live-model", context_window: 8192 },
]);

function installFetch({ refresh, hangRefresh = false, codingPlan, gateway } = {}) {
  const calls = [];
  let resolveHang;
  const hang = new Promise((resolve) => {
    resolveHang = resolve;
  });
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(typeof input === "string" ? input : input?.url);
    const headers = new Headers(
      init.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    calls.push({ url, method: init.method ?? "GET", headers });
    if (url.includes("oauth/refresh")) {
      if (hangRefresh) await hang;
      const next = typeof refresh === "function" ? refresh() : refresh;
      if (next instanceof Error) throw next;
      return new Response(next?.body ?? "{}", { status: next?.status ?? 502 });
    }
    if (url.includes("chat/completions")) {
      const next = typeof gateway === "function" ? gateway(url, headers) : gateway;
      if (next) return new Response(next.body ?? "{}", { status: next.status ?? 200 });
      return new Response("{}", { status: 200 });
    }
    if (url.includes("status-v2") || url.includes("models-v2") || url.includes("claim-v2")) {
      const next = typeof codingPlan === "function" ? codingPlan(url, headers) : codingPlan;
      if (next) return new Response(next.body ?? "{}", { status: next.status ?? 200 });
      return new Response("{}", { status: 401 });
    }
    return new Response("{}", { status: 404 });
  };
  return {
    calls,
    count: (part) => calls.filter((call) => call.url.includes(part)).length,
    release: () => resolveHang(),
    restore() {
      globalThis.fetch = real;
    },
  };
}

async function createPlugin(clock, extra = {}) {
  return AtomCodePlugin(
    {
      client: {
        app: { log: ({ body }) => extra.logs?.push(body.message) },
        auth: { set: async () => {} },
      },
    },
    {
      autoVersion: false,
      locale: "en",
      now: () => clock.now,
      random: () => clock.random ?? 0.5,
      refreshBackoffBaseMs: clock.baseMs ?? 1000,
      refreshBackoffCapMs: clock.capMs ?? 60_000,
    },
  );
}

const broker = (status, body) => ({ status, body });

test("a 502 refresh is not repeated until the backoff elapses", async () => {
  const clock = { now: 0, random: 0.5, baseMs: 1000, capMs: 60_000 };
  const stub = installFetch({ refresh: broker(502, "{}") });
  try {
    const plugin = await createPlugin(clock);
    const auth = account();
    await plugin.auth.refresh(auth);
    await plugin.auth.refresh(auth);
    await plugin.auth.refresh(auth);
    assert.equal(stub.count("oauth/refresh"), 1);

    clock.now = 999;
    await plugin.auth.refresh(auth);
    assert.equal(stub.count("oauth/refresh"), 1);

    clock.now = 1000;
    await plugin.auth.refresh(auth);
    assert.equal(stub.count("oauth/refresh"), 2);
  } finally {
    stub.restore();
  }
});

test("refresh backoff doubles and then stays at the cap", async () => {
  const clock = { now: 0, random: 0.5, baseMs: 1000, capMs: 4000 };
  const stub = installFetch({ refresh: broker(502, "{}") });
  try {
    const plugin = await createPlugin(clock);
    const auth = account();
    await plugin.auth.refresh(auth);
    for (const [at, expected] of [
      [1000, 2],
      [3000, 3],
      [7000, 4],
      [10_999, 4],
      [11_000, 5],
    ]) {
      clock.now = at;
      await plugin.auth.refresh(auth);
      assert.equal(stub.count("oauth/refresh"), expected, `at ${at}ms`);
    }
  } finally {
    stub.restore();
  }
});

test("backoff jitter is ±20% of the delay and never exceeds the cap", async () => {
  const early = installFetch({ refresh: broker(503, "{}") });
  const clock = { now: 0, random: 0, baseMs: 1000, capMs: 60_000 };
  try {
    const plugin = await createPlugin(clock);
    const auth = account();
    await plugin.auth.refresh(auth);
    clock.now = 799;
    await plugin.auth.refresh(auth);
    assert.equal(early.count("oauth/refresh"), 1);
    clock.now = 800;
    await plugin.auth.refresh(auth);
    assert.equal(early.count("oauth/refresh"), 2);
  } finally {
    early.restore();
  }

  const late = installFetch({ refresh: broker(503, "{}") });
  const high = { now: 0, random: 1, baseMs: 1000, capMs: 1000 };
  try {
    const plugin = await createPlugin(high);
    const auth = account();
    await plugin.auth.refresh(auth);
    high.now = 999;
    await plugin.auth.refresh(auth);
    assert.equal(late.count("oauth/refresh"), 1);
    high.now = 1000;
    await plugin.auth.refresh(auth);
    assert.equal(late.count("oauth/refresh"), 2);
  } finally {
    late.restore();
  }
});

test("a successful refresh starts the backoff over", async () => {
  let mode = "fail";
  const clock = { now: 0, random: 0.5, baseMs: 1000, capMs: 60_000 };
  const stub = installFetch({
    refresh: () =>
      mode === "fail"
        ? broker(502, "{}")
        : broker(
            200,
            JSON.stringify({
              access_token: "fresh-access",
              refresh_token: "fresh-refresh",
              expires_in: 3600,
            }),
          ),
  });
  try {
    const plugin = await createPlugin(clock);
    const auth = account();
    await plugin.auth.refresh(auth);
    clock.now = 1000;
    await plugin.auth.refresh(auth);
    assert.equal(stub.count("oauth/refresh"), 2);

    mode = "ok";
    clock.now = 3000;
    const renewed = await plugin.auth.refresh(auth);
    assert.equal(renewed.access, "fresh-access");
    assert.equal(stub.count("oauth/refresh"), 3);

    mode = "fail";
    // The success is remembered for 24h. Once that memory ends, the next
    // failure has to wait the base delay, not the delay of the earlier streak.
    clock.now = 3000 + DAY_MS;
    await plugin.auth.refresh(auth);
    const afterFailure = stub.count("oauth/refresh");
    assert.equal(afterFailure, 4);
    clock.now = 3000 + DAY_MS + 999;
    await plugin.auth.refresh(auth);
    assert.equal(stub.count("oauth/refresh"), afterFailure);
    clock.now = 3000 + DAY_MS + 1000;
    await plugin.auth.refresh(auth);
    assert.equal(stub.count("oauth/refresh"), afterFailure + 1);
  } finally {
    stub.restore();
  }
});

test("a new refresh token is probed at once and keeps its own backoff", async () => {
  const clock = { now: 0, random: 0.5, baseMs: 1000, capMs: 60_000 };
  const stub = installFetch({ refresh: broker(502, "{}") });
  try {
    const plugin = await createPlugin(clock);
    const old = account({ refresh: "old-token", expires: 1 });
    await plugin.auth.refresh(old);
    await plugin.auth.refresh(old);
    assert.equal(stub.count("oauth/refresh"), 1);

    const renewed = account({ refresh: "new-token", expires: 1 });
    await plugin.auth.refresh(renewed);
    assert.equal(stub.count("oauth/refresh"), 2);
    await plugin.auth.refresh(renewed);
    assert.equal(stub.count("oauth/refresh"), 2);

    await plugin.auth.refresh(account({ uid: "u2", refresh: "other-account", expires: 1 }));
    assert.equal(stub.count("oauth/refresh"), 3);
  } finally {
    stub.restore();
  }
});

test("permanent 4xx and invalid_grant are not probed again until the credential changes", async () => {
  for (const refresh of [
    broker(401, JSON.stringify({ error: "invalid_grant" })),
    broker(400, "{}"),
    broker(403, "{}"),
    broker(422, JSON.stringify({ error: "invalid_grant" })),
  ]) {
    const clock = { now: 0, random: 0.5, baseMs: 1000, capMs: 60_000 };
    const stub = installFetch({ refresh });
    try {
      const plugin = await createPlugin(clock);
      const auth = account({ expires: 1 });
      await assert.rejects(() => plugin.auth.refresh(auth), (error) => error.signIn === "expired");
      clock.now = 60_000;
      await assert.rejects(() => plugin.auth.refresh(auth), (error) => error.signIn === "expired");
      assert.equal(stub.count("oauth/refresh"), 1);
      await assert.rejects(
        () => plugin.auth.refresh(account({ refresh: "replaced-token", expires: 1 })),
        (error) => error.signIn === "expired",
      );
      assert.equal(stub.count("oauth/refresh"), 2);
    } finally {
      stub.restore();
    }
  }
});

test("a network error uses the same backoff and keeps the sign-in", async () => {
  const clock = { now: 0, random: 0.5, baseMs: 1000, capMs: 60_000 };
  const stub = installFetch({ refresh: new Error("fetch failed") });
  try {
    const plugin = await createPlugin(clock);
    const auth = account();
    const kept = await plugin.auth.refresh(auth);
    assert.equal(kept.access, "tok");
    assert.equal(kept.signIn, undefined);
    await plugin.auth.refresh(auth);
    assert.equal(stub.count("oauth/refresh"), 1);
    clock.now = 1000;
    await plugin.auth.refresh(auth);
    assert.equal(stub.count("oauth/refresh"), 2);
  } finally {
    stub.restore();
  }
});

test("concurrent refreshes share one broker call and one backoff", async () => {
  const clock = { now: 0, random: 0.5, baseMs: 1000, capMs: 60_000 };
  const stub = installFetch({ refresh: broker(502, "{}"), hangRefresh: true });
  try {
    const plugin = await createPlugin(clock);
    const auth = account();
    const first = plugin.auth.refresh(auth);
    const second = plugin.auth.refresh(auth);
    await Promise.resolve();
    assert.equal(stub.count("oauth/refresh"), 1);
    stub.release();
    await Promise.all([first, second]);
    assert.equal(stub.count("oauth/refresh"), 1);

    clock.now = 999;
    await plugin.auth.refresh(auth);
    assert.equal(stub.count("oauth/refresh"), 1);
    clock.now = 1000;
    await plugin.auth.refresh(auth);
    assert.equal(stub.count("oauth/refresh"), 2);
  } finally {
    stub.restore();
  }
});

test("models, usage, and requests do not poll an unhealthy account on every tick", async () => {
  const clock = { now: 0, random: 0.5, baseMs: 1000, capMs: 60_000 };
  const logs = [];
  const stub = installFetch({ refresh: broker(502, "{}") });
  try {
    const plugin = await createPlugin(clock, { logs });
    const auth = account();
    const { fetch: patched } = await plugin.auth.loader(async () => auth);
    const sent = await patched(GATEWAY, { method: "POST", body: "{}" });
    assert.equal(sent.status, 200);

    const models = await plugin.provider.models({}, { auth });
    assert.equal(models[Symbol.for("magpie.fellBack")], true);
    assert.ok(models["qwen3.8-27b"]);
    const usage = await plugin.auth.usage(async () => auth);
    assert.equal(usage.signIn, "kept");
    const cooled = await patched(GATEWAY, { method: "POST", body: "{}" });
    assert.equal(cooled.status, 503);

    assert.equal(stub.count("oauth/refresh"), 1);
    assert.equal(stub.count("status-v2"), 0);
    assert.equal(stub.count("models-v2"), 0);
    assert.equal(stub.count("chat/completions"), 1);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /HTTP 502/);

    clock.now = 1000;
    await plugin.auth.refresh(auth);
    assert.equal(stub.count("oauth/refresh"), 2);
  } finally {
    stub.restore();
  }
});

test("an unexpired token CodingPlan rejects is probed once per backoff, then the hold stays quiet", async () => {
  for (const expires of [Date.now() + 3_600_000, Date.now() + 10_000]) {
    const clock = { now: 0, random: 0.5, baseMs: 8_000, capMs: 60_000 };
    const logs = [];
    const stub = installFetch({ refresh: broker(502, "{}") });
    try {
      const plugin = await createPlugin(clock, { logs });
      const auth = account({ access: "rejected-access", refresh: "refresh-1", expires });
      for (const at of [0, 3_000, 4_000, 7_999]) {
        clock.now = at;
        const models = await plugin.provider.models({}, { auth });
        assert.equal(models[Symbol.for("magpie.fellBack")], true);
        assert.ok(models["qwen3.8-27b"]);
      }
      const label = expires - Date.now() > 30_000 ? "1h ahead" : "inside 30s skew";
      assert.equal(stub.count("oauth/refresh"), 1, label);
      assert.equal(stub.count("status-v2"), 1, label);
      assert.equal(logs.filter((line) => /CodingPlan returned HTTP 401/.test(line)).length, 0);
      const logsAfterDiscovery = logs.length;

      const { fetch: patched } = await plugin.auth.loader(async () => auth);
      const cooled = await patched(GATEWAY, { method: "POST", body: "{}" });
      assert.equal(cooled.status, 503);
      const usage = await plugin.auth.usage(async () => auth);
      assert.equal(usage.signIn, "kept");
      const checkin = await plugin.auth.checkin(async () => auth);
      assert.equal(checkin.outcome, "failed");
      assert.equal(stub.count("oauth/refresh"), 1, label);
      assert.equal(stub.count("status-v2"), 1, label);
      assert.equal(stub.count("chat/completions"), 0, label);
      assert.equal(stub.count("claim-v2"), 0, label);
      assert.equal(logs.length, logsAfterDiscovery, label);

      clock.now = 8_000;
      const probed = await plugin.provider.models({}, { auth });
      assert.equal(probed[Symbol.for("magpie.fellBack")], true);
      assert.equal(stub.count("oauth/refresh"), 2, label);
      assert.equal(stub.count("status-v2"), 2, label);

      clock.now = 12_000;
      await plugin.provider.models({}, { auth });
      assert.equal(stub.count("oauth/refresh"), 2, label);
      assert.equal(stub.count("status-v2"), 2, label);
    } finally {
      stub.restore();
    }
  }
});

test("usage and fetch do not keep polling a rejected unexpired token while the hold is active", async () => {
  for (const expires of [Date.now() + 3_600_000, Date.now() + 10_000]) {
    const clock = { now: 0, random: 0.5, baseMs: 8_000, capMs: 60_000 };
    const logs = [];
    const stub = installFetch({
      refresh: broker(502, "{}"),
      gateway: { status: 401, body: "{}" },
    });
    try {
      const plugin = await createPlugin(clock, { logs });
      const auth = account({ access: "rejected-access", refresh: "refresh-1", expires });
      const usage = await plugin.auth.usage(async () => auth);
      assert.equal(usage.signIn, "kept");
      const { fetch: patched } = await plugin.auth.loader(async () => auth);
      const first = await patched(GATEWAY, { method: "POST", body: "{}" });
      assert.ok(first.status === 401 || first.status === 503);
      const brokerAfter = stub.count("oauth/refresh");
      const statusAfter = stub.count("status-v2");
      const chatAfter = stub.count("chat/completions");
      assert.ok(brokerAfter <= 1);
      assert.ok(statusAfter <= 1);
      assert.ok(chatAfter <= 1);

      for (const at of [3_000, 4_000, 7_000]) {
        clock.now = at;
        const again = await plugin.auth.usage(async () => auth);
        assert.equal(again.signIn, "kept");
        const sent = await patched(GATEWAY, { method: "POST", body: "{}" });
        assert.equal(sent.status, 503);
      }
      assert.equal(stub.count("oauth/refresh"), brokerAfter);
      assert.equal(stub.count("status-v2"), statusAfter);
      assert.equal(stub.count("chat/completions"), chatAfter);
      assert.equal(logs.filter((line) => /CodingPlan returned HTTP 401/.test(line)).length, 0);
    } finally {
      stub.restore();
    }
  }
});

test("a broker 502 during proactive refresh still serves a token CodingPlan accepts", async () => {
  const livePlan = (url) =>
    url.includes("models-v2")
      ? { status: 200, body: LIVE_MODELS }
      : { status: 200, body: LIVE_STATUS };
  for (const [expires, brokerCalls] of [
    [Date.now() + 3_600_000, 0],
    [Date.now() + 10_000, 1],
  ]) {
    const clock = { now: 0, random: 0.5, baseMs: 8_000, capMs: 60_000 };
    const stub = installFetch({
      refresh: broker(502, "{}"),
      codingPlan: livePlan,
      gateway: { status: 200, body: "{}" },
    });
    try {
      const plugin = await createPlugin(clock);
      const auth = account({ access: "still-good", expires });
      for (const at of [0, 3_000, 4_000]) {
        clock.now = at;
        const models = await plugin.provider.models({}, { auth });
        assert.equal(models[Symbol.for("magpie.fellBack")], undefined);
        assert.equal(models["live-model"].api.id, "live-model");
      }
      assert.equal(stub.count("oauth/refresh"), brokerCalls);
      const { fetch: patched } = await plugin.auth.loader(async () => auth);
      const sent = await patched(GATEWAY, { method: "POST", body: "{}" });
      assert.equal(sent.status, 200);
      const again = await patched(GATEWAY, { method: "POST", body: "{}" });
      assert.equal(again.status, 200);
      assert.equal(stub.count("chat/completions"), 2);
      assert.equal(stub.count("oauth/refresh"), brokerCalls);
    } finally {
      stub.restore();
    }
  }
});

test("a permanent hold clears when access or expires changes even if the refresh token does not", async () => {
  const refresh = broker(401, JSON.stringify({ error: "invalid_grant" }));
  const cases = [
    { access: "new-access", expires: 5_000 },
    { access: "new-access-only" },
    { expires: 9_000 },
  ];
  for (const patch of cases) {
    const clock = { now: 0, random: 0.5, baseMs: 1000, capMs: 60_000 };
    const stub = installFetch({ refresh });
    try {
      const plugin = await createPlugin(clock);
      const auth = account({ access: "old-access", refresh: "same-refresh", expires: 1_000 });
      await assert.rejects(() => plugin.auth.refresh(auth), (error) => error.signIn === "expired");
      clock.now = 60_000;
      await assert.rejects(() => plugin.auth.refresh(auth), (error) => error.signIn === "expired");
      assert.equal(stub.count("oauth/refresh"), 1, JSON.stringify(patch));
      await assert.rejects(
        () => plugin.auth.refresh(account({ ...auth, ...patch })),
        (error) => error.signIn === "expired",
      );
      assert.equal(stub.count("oauth/refresh"), 2, JSON.stringify(patch));
    } finally {
      stub.restore();
    }
  }
});

test("refresh holds drop the oldest account once the map is past its cap", async () => {
  const clock = { now: 0, random: 0.5, baseMs: 1000, capMs: 60_000 };
  const stub = installFetch({
    refresh: broker(401, JSON.stringify({ error: "invalid_grant" })),
  });
  try {
    const plugin = await createPlugin(clock);
    const stored = (i) =>
      account({ uid: `u${i}`, access: `access-${i}`, refresh: `refresh-${i}`, expires: 1 });
    for (let i = 0; i < 33; i++) {
      await assert.rejects(
        () => plugin.auth.refresh(stored(i)),
        (error) => error.signIn === "expired",
      );
    }
    assert.equal(stub.count("oauth/refresh"), 33);
    await assert.rejects(() => plugin.auth.refresh(stored(0)), (error) => error.signIn === "expired");
    assert.equal(stub.count("oauth/refresh"), 34);
    await assert.rejects(() => plugin.auth.refresh(stored(32)), (error) => error.signIn === "expired");
    assert.equal(stub.count("oauth/refresh"), 34);
  } finally {
    stub.restore();
  }
});

test("a new access token with the same refresh token is not stuck on the rejected hold", async () => {
  const clock = { now: 0, random: 0.5, baseMs: 8_000, capMs: 60_000 };
  const stub = installFetch({
    refresh: broker(502, "{}"),
    codingPlan: (url, headers) => {
      if (headers.get("authorization") !== "Bearer fresh-access") {
        return { status: 401, body: "{}" };
      }
      return url.includes("models-v2")
        ? { status: 200, body: LIVE_MODELS }
        : { status: 200, body: LIVE_STATUS };
    },
  });
  try {
    const plugin = await createPlugin(clock);
    const rejected = account({
      access: "rejected-access",
      refresh: "same-refresh",
      expires: Date.now() + 3_600_000,
    });
    const first = await plugin.provider.models({}, { auth: rejected });
    assert.equal(first[Symbol.for("magpie.fellBack")], true);
    assert.equal(stub.count("status-v2"), 1);

    const fresh = account({
      access: "fresh-access",
      refresh: "same-refresh",
      expires: Date.now() + 7_200_000,
    });
    const models = await plugin.provider.models({}, { auth: fresh });
    assert.equal(models["live-model"].api.id, "live-model");
    assert.equal(models[Symbol.for("magpie.fellBack")], undefined);
    assert.equal(stub.count("status-v2"), 2);
    assert.equal(stub.count("oauth/refresh"), 1);
  } finally {
    stub.restore();
  }
});
