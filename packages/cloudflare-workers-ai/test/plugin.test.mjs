import test from "node:test";
import assert from "node:assert/strict";
import { CloudflareWorkersAIPlugin } from "../index.mjs";

const ACCOUNT_ID = "a".repeat(32);

function fakeCatalog() {
  return {
    "cloudflare-workers-ai": {
      models: {
        "@cf/meta/llama-3-8b-instruct": {
          name: "Llama 3 8B",
          limit: { context: 8192, output: 4096 },
          tool_call: true,
          cost: { input: 0.05, output: 0.12 },
          modalities: { input: ["text"], output: ["text"] },
        },
        "@cf/deepseek/deepseek-r1": {
          name: "DeepSeek R1",
          reasoning: true,
          tool_call: true,
          reasoning_options: [{ type: "effort", values: ["low", "high"] }],
          modalities: { input: ["text", "image"], output: ["text"] },
          interleaved: { field: "reasoning_content" },
          cost: { input: 0.1, output: 0.2 },
        },
      },
    },
  };
}

function opts(catalogJson = fakeCatalog()) {
  return {
    accountId: ACCOUNT_ID,
    discoveryTTLMs: 3600_000,
    fetchImpl: async () => new Response(JSON.stringify(catalogJson)),
  };
}

test("module parses and exports plugin function", async () => {
  const mod = await import("../index.mjs");
  assert.equal(typeof mod.CloudflareWorkersAIPlugin, "function");
  assert.equal(typeof (await import("../index.mjs")).default, "function");
});

test("registers provider with interpolated account id in models.dev-driven config", async () => {
  const plugin = await CloudflareWorkersAIPlugin({}, opts());
  const cfg = {};
  await plugin.config(cfg);
  const p = cfg.provider["cloudflare-workers-ai"];
  assert.ok(p, "provider registered");
  assert.equal(p.api, `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/v1`);
  assert.equal(p.models["@cf/meta/llama-3-8b-instruct"].name, "Llama 3 8B");
  assert.equal(p.models["@cf/meta/llama-3-8b-instruct"].limit.context, 8192);
  assert.equal(p.models["@cf/deepseek/deepseek-r1"].reasoning, true);
  assert.deepEqual(p.models["@cf/deepseek/deepseek-r1"].variants, {
    low: { reasoningEffort: "low" },
    high: { reasoningEffort: "high" },
  });
});

test("init succeeds without accountId option (no load-time throw)", async () => {
  const noOpts = await CloudflareWorkersAIPlugin({}, { fetchImpl: async () => new Response("{}") });
  const cfg = {};
  await noOpts.config(cfg);
  assert.ok(cfg.provider["cloudflare-workers-ai"], "plugin loads without accountId option");
});

test("loader rejects accounts without a 32-hex accountId", async () => {
  const plugin = await CloudflareWorkersAIPlugin({}, { fetchImpl: async () => new Response("{}") });
  await assert.rejects(
    async () => plugin.auth.loader(async () => ({ key: "tok", metadata: [] })),
    /Account ID/
  );
});

test("discovery falls back to cached catalog on refresh failure", async () => {
  let fail = false;
  const o = {
    accountId: ACCOUNT_ID,
    discoveryTTLMs: 0, // always stale
    fetchImpl: async () => {
      if (fail) return new Response("boom", { status: 500 });
      return new Response(JSON.stringify(fakeCatalog()));
    },
  };
  const plugin = await CloudflareWorkersAIPlugin({}, o);
  const cfg = {};
  await plugin.config(cfg); // primes cache

  fail = true;
  const cfg2 = {};
  await plugin.config(cfg2);
  const p = cfg2.provider["cloudflare-workers-ai"];
  assert.ok(p.models["@cf/meta/llama-3-8b-instruct"], "served cached models after failure");
});

test("auth loader forwards chat/completions with bearer token", async () => {
  let seen = {};
  const o = opts();
  o.fetchImpl = async (url, init) => {
    if (typeof url === "string" && url.includes("models.dev")) {
      return new Response(JSON.stringify(fakeCatalog()));
    }
    seen = { url, init };
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const plugin = await CloudflareWorkersAIPlugin({}, o);
  const result = await plugin.auth.loader(async () => ({ methods: [{ key: "tok" }, { key: "" }] }));
  assert.equal(result.baseURL, `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/v1`);
  assert.equal(result.apiKey, "tok");

  const req = new Request(`${result.baseURL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-aig-authorization": "z" },
    body: JSON.stringify({ model: "@cf/meta/llama-3-8b-instruct", messages: [] }),
  });
  const resp = await result.fetch(req, {});
  assert.equal(resp.status, 200);
  assert.equal(seen.init.headers.get("authorization"), "Bearer tok");
  assert.equal(seen.init.headers.get("cf-aig-authorization"), "z");
  assert.match(seen.url, /\/chat\/completions$/);
});

test("auth loader rejects unknown models but passes other endpoints through", async () => {
  const plugin = await CloudflareWorkersAIPlugin({}, opts());
  const cfg = {}; await plugin.config(cfg); // prime the model catalog
  const result = await plugin.auth.loader(async () => ({ key: "tok", metadata: { accountId: "" } }));
  await assert.rejects(
    async () =>
      result.fetch(
        new Request(`${result.baseURL}/chat/completions`, {
          method: "POST",
          body: JSON.stringify({ model: "@cf/nope" }),
        }),
        {}
      ),
    /last known Workers AI catalog/
  );
  // Non-chat paths are forwarded untouched to the same base URL
  let forwarded = "";
  const o2 = opts();
  o2.fetchImpl = async (url) => {
    if (typeof url === "string" && url.includes("models.dev")) {
      return new Response(JSON.stringify(fakeCatalog()));
    }
    forwarded = url;
    return new Response("{}", { status: 200 });
  };
  const p2 = await CloudflareWorkersAIPlugin({}, o2);
  const r2 = await p2.auth.loader(async () => ({ key: "tok" }));
  const resp2 = await r2.fetch(`${r2.baseURL}/embeddings`, {
    method: "POST",
    body: JSON.stringify({ text: "x" }),
  });
  assert.equal(resp2.status, 200);
  assert.match(forwarded, /\/embeddings$/);
});

test("a models.dev outage must not take chat requests down (request path never refreshes)", async () => {
  let down = false;
  const o = {
    accountId: ACCOUNT_ID,
    discoveryTTLMs: 1, // every refresh is stale immediately
    fetchImpl: async (url) => {
      if (typeof url === "string" && url.includes("models.dev")) {
        if (down) return new Response("down", { status: 503 });
        return new Response(JSON.stringify(fakeCatalog()));
      }
      return new Response("{}", { status: 200 });
    },
  };
  const plugin = await CloudflareWorkersAIPlugin({}, o);
  const cfg = {};
  await plugin.config(cfg); // prime once while models.dev is up
  const loader = await plugin.auth.loader(async () => ({ key: "tok", metadata: { accountId: "" } }));

  down = true; // TTL passed AND models.dev unreachable
  const resp = await loader.fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/v1/chat/completions`,
    { method: "POST", body: JSON.stringify({ model: "@cf/meta/llama-3-8b-instruct", messages: [] }) }
  );
  assert.equal(resp.status, 200, "known model must still be sent using the last good catalog");

  // an unknown model is rejected locally at once, without touching models.dev
  await assert.rejects(
    async () =>
      loader.fetch(
        `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/v1/chat/completions`,
        { method: "POST", body: JSON.stringify({ model: "@cf/nope", messages: [] }) }
      ),
    /last known Workers AI catalog/
  );
});

test("authorize accepts bare-string and fields-object token shapes", async () => {
  const plugin = await CloudflareWorkersAIPlugin({}, opts());
  const method = plugin.auth.methods[0];
  for (const call of [
    [" tok ", { accountId: "b".repeat(32) }],
    [{ key: "tok", accountId: "b".repeat(32) }],
    [{ token: "tok", accountId: "b".repeat(32) }],
    [{ apiKey: "tok", accountId: "b".repeat(32) }],
  ]) {
    const ok = await method.authorize(...call);
    assert.equal(ok.type, "success", JSON.stringify(call[0]).slice(0, 30));
    assert.equal(ok.key, "tok");
    assert.equal(ok.metadata.accountId, "b".repeat(32));
  }
  const noTok = await method.authorize({}, { accountId: "b".repeat(32) });
  assert.equal(noTok.type, "failed");
});

test("usage reports free-allocation window with next UTC midnight reset", async () => {
  const o = opts();
  o.fetchImpl = async (url, init) => {
    if (typeof url === "string" && url.includes("models.dev")) {
      return new Response(JSON.stringify(fakeCatalog()));
    }
    return new Response("{}", { status: 200 });
  };
  const plugin = await CloudflareWorkersAIPlugin({}, o);
  const u = await plugin.auth.usage(async () => ({
    key: "tok",
    metadata: { accountId: ACCOUNT_ID },
  }));
  assert.ok(u.plan, "plan name present");
  assert.equal(u.windows.length, 1);
  const w = u.windows[0];
  assert.equal(w.limit, 10000);
  assert.equal(w.unit, "neurons");
  assert.equal(new Date(w.resetsAt).getUTCHours(), 0);
  assert.equal(new Date(w.resetsAt).getUTCMinutes(), 0);
  assert.equal(w.span, 86400, "span is in seconds per the magpie plugin contract");
});

test("paid-only models are flagged (Paid) in config and provider.models", async () => {
  const catalog = fakeCatalog();
  catalog["cloudflare-workers-ai"].models["@cf/zai-org/glm-5.3"] = {
    name: "GLM 5.3",
    limit: { context: 128000, output: 32000 },
    modalities: { input: ["text"], output: ["text"] },
  };
  const o = opts(catalog);
  const plugin = await CloudflareWorkersAIPlugin({}, o);
  const cfg = {};
  await plugin.config(cfg);
  assert.match(cfg.provider["cloudflare-workers-ai"].models["@cf/zai-org/glm-5.3"].name, /Paid/, "config decoration");
  assert.equal(cfg.provider["cloudflare-workers-ai"].meta, undefined);
  const pm = cfg.provider["cloudflare-workers-ai"].models["@cf/meta/llama-3-8b-instruct"];
  assert.doesNotMatch(pm.name, /Paid/, "free model not flagged");
});

test("fetch normalizes template-account URLs onto the effective account base", async () => {
  let forwarded = "";
  const o = opts();
  o.fetchImpl = async (url) => {
    if (typeof url === "string" && url.includes("models.dev")) {
      return new Response(JSON.stringify(fakeCatalog()));
    }
    forwarded = url;
    return new Response("{}", { status: 200 });
  };
  const plugin = await CloudflareWorkersAIPlugin({}, o);
  const r = await plugin.auth.loader(async () => ({
    key: "tok",
    metadata: { accountId: ACCOUNT_ID },
  }));
  // gateway addressed us via model metadata URL that still holds the template
  const req = new Request(
    "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1/chat/completions",
    { method: "POST", body: JSON.stringify({ model: "@cf/meta/llama-3-8b-instruct", messages: [] }) }
  );
  await r.fetch(req, {});
  assert.equal(
    forwarded,
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/v1/chat/completions`
  );
  // concrete (non-template) incoming URL must keep its resource suffix too
  await r.fetch(`${r.baseURL}/embeddings`, { method: "POST", body: "{}" });
  assert.match(forwarded, /\/embeddings$/);
});

test("checkedURL rejects non-HTTP(S) baseTemplate at init", async () => {
  await assert.rejects(
    async () =>
      CloudflareWorkersAIPlugin({}, {
        accountId: ACCOUNT_ID,
        baseTemplate: "javascript:alert(1)",
        fetchImpl: async () => new Response(JSON.stringify(fakeCatalog())),
      }),
    /plain HTTP\(S\) base URL/
  );
});

test("interpolateTemplate keeps unknown placeholders intact", async () => {
  const plugin = await CloudflareWorkersAIPlugin({}, {
    baseTemplate: "https://example.com/${UNKNOWN_KEY}/ai/v1",
    fetchImpl: async () => new Response("{}"),
  });
  const cfg = {};
  await plugin.config(cfg);
  assert.equal(
    cfg.provider["cloudflare-workers-ai"].api,
    "https://example.com/${UNKNOWN_KEY}/ai/v1",
    "an unknown placeholder must survive interpolation untouched"
  );
});

test("usage returns the fallback plan for an invalid accountId (no API call)", async () => {
  let apiCalled = "";
  const o = opts();
  o.fetchImpl = async (url) => {
    if (String(url).includes("models.dev")) {
      return new Response(JSON.stringify(fakeCatalog()));
    }
    apiCalled = url;
    return new Response("{}", { status: 200 });
  };
  const plugin = await CloudflareWorkersAIPlugin({}, o);
  const u = await plugin.auth.usage(async () => ({
    key: "tok",
    metadata: { accountId: "..%2Fnot-hex" },
  }));
  assert.equal(u.windows.length, 0, "invalid Account ID must not reach the API path");
  assert.equal(apiCalled, "", "no /accounts/ request was made");
});

function usageOpts(graphqlResponder, plan = "Workers Free") {
  const seen = [];
  const o = opts();
  o.fetchImpl = async (url, init) => {
    if (typeof url === "string" && url.includes("models.dev")) {
      return new Response(JSON.stringify(fakeCatalog()));
    }
    if (typeof url === "string" && url.endsWith("/graphql")) {
      seen.push({ url, init, body: JSON.parse(init?.body ?? "{}") });
      return graphqlResponder();
    }
    return new Response(JSON.stringify({ result: { plan: { name: plan } } }), { status: 200 });
  };
  return { o, seen };
}

test("usage sums today's totalNeurons from GraphQL Analytics into amount", async () => {
  const { o, seen } = usageOpts(() =>
    new Response(JSON.stringify({
      data: {
        viewer: {
          accounts: [{
            aiInferenceAdaptiveGroups: [
              { sum: { totalNeurons: 6659.43 } },
              { sum: { totalNeurons: 3802.57 } },
            ],
          }],
        },
      },
    }), { status: 200 })
  );
  const plugin = await CloudflareWorkersAIPlugin({}, o);
  const u = await plugin.auth.usage(async () => ({
    key: "tok",
    metadata: { accountId: ACCOUNT_ID },
  }));
  assert.equal(u.plan, "Workers Free");
  assert.equal(u.windows.length, 1);
  const w = u.windows[0];
  assert.equal(w.amount, 10462, "bucket sums must land in amount");
  assert.equal(w.limit, 10000);
  assert.equal(w.used, 100, "over the limit clamps to 100% used, which the router benches on");
  assert.equal(w.aside, false, "a confirmed Free plan stops routing at its daily limit");
  assert.equal(w.display, "", "known usage uses magpie's count and Used / Left toggle");
  const call = seen[0];
  assert.ok(call, "GraphQL Analytics endpoint was queried");
  assert.equal(new URL(call.url).pathname, "/client/v4/graphql");
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.headers.authorization, "Bearer tok");
  const midnight = new Date(Math.floor(Date.now() / 86400_000) * 86400_000);
  assert.ok(
    call.body.query.includes(`datetimeHour_geq: "${midnight.toISOString()}"`),
    "window starts at today's UTC midnight"
  );
  assert.ok(call.body.query.includes(`accountTag: "${ACCOUNT_ID}"`));
});

test("usage does not order an aggregate by an unselected dimension", async () => {
  const { o, seen } = usageOpts(() => new Response(JSON.stringify({ data: null, errors: [] })));
  const plugin = await CloudflareWorkersAIPlugin({}, o);
  await plugin.auth.usage(async () => ({ key: "tok", metadata: { accountId: ACCOUNT_ID } }));
  assert.doesNotMatch(seen[0].body.query, /orderBy:/,
    "Cloudflare rejects datetimeHour ordering when the query selects only sum.totalNeurons");
});

test("usage keeps amount null when the token lacks Analytics scope", async () => {
  const { o } = usageOpts(() => new Response("authentication error", { status: 403 }));
  const plugin = await CloudflareWorkersAIPlugin({}, o);
  const u = await plugin.auth.usage(async () => ({
    key: "tok",
    metadata: { accountId: ACCOUNT_ID },
  }));
  assert.equal(u.windows.length, 1, "window still shown");
  assert.equal(u.windows[0].amount, null, "unknown usage must stay null, not zero");
  assert.match(u.windows[0].display, /Account Analytics/);
});

test("usage treats a GraphQL error payload as unknown, and an empty day as zero", async () => {
  const errPayload = usageOpts(() =>
    new Response(JSON.stringify({ errors: [{ code: 10000, message: "no access" }] }), { status: 200 })
  );
  const plugin = await CloudflareWorkersAIPlugin({}, errPayload.o);
  const u = await plugin.auth.usage(async () => ({ key: "tok", metadata: { accountId: ACCOUNT_ID } }));
  assert.equal(u.windows[0].amount, null, "errors payload must not read as zero");

  const emptyDay = usageOpts(() =>
    new Response(JSON.stringify({
      data: { viewer: { accounts: [{ aiInferenceAdaptiveGroups: [] }] } },
    }), { status: 200 })
  );
  const p2 = await CloudflareWorkersAIPlugin({}, emptyDay.o);
  const u2 = await p2.auth.usage(async () => ({ key: "tok", metadata: { accountId: ACCOUNT_ID } }));
  assert.equal(u2.windows[0].amount, 0, "an empty bucket list is a real zero");
  assert.equal(u2.windows[0].used, 0, "an unused day is a numeric reading, not a text-only row");
  assert.equal(u2.windows[0].display, "");

  const partial = usageOpts(() =>
    new Response(JSON.stringify({
      data: { viewer: { accounts: [{ aiInferenceAdaptiveGroups: [{ sum: { totalNeurons: 1234 } }] }] } },
      errors: [{ message: "some buckets timed out" }],
    }), { status: 200 })
  );
  const p3 = await CloudflareWorkersAIPlugin({}, partial.o);
  const u3 = await p3.auth.usage(async () => ({ key: "tok", metadata: { accountId: ACCOUNT_ID } }));
  assert.equal(u3.windows[0].amount, null, "a partial reply — rows and errors together — is not a read");
});

test("a full window does not bench an account whose plan is unknown", async () => {
  // GET /accounts/{id} names no plan for this token, and the day is spent:
  // the card gets a percentage, but the window is set aside from routing:
  // past the allowance a Paid account is billed, not refused.
  const o = opts();
  o.fetchImpl = async (url, init) => {
    if (typeof url === "string" && url.includes("models.dev")) {
      return new Response(JSON.stringify(fakeCatalog()));
    }
    if (typeof url === "string" && url.endsWith("/graphql")) {
      return new Response(JSON.stringify({
        data: { viewer: { accounts: [{ aiInferenceAdaptiveGroups: [{ sum: { totalNeurons: 10462 } }] }] } },
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ result: {} }), { status: 200 }); // no plan in the answer
  };
  const plugin = await CloudflareWorkersAIPlugin({}, o);
  const u = await plugin.auth.usage(async () => ({ key: "tok", metadata: { accountId: ACCOUNT_ID } }));
  assert.equal(u.plan, "Workers Free / Paid (confirm in the dashboard)");
  const w = u.windows[0];
  assert.equal(w.amount, 10462, "the card still sees the real usage");
  assert.equal(w.used, 100, "the card can switch between Used and Left");
  assert.equal(w.aside, true, "an unknown plan must not be benched on its free allowance");
  assert.equal(w.display, "");
});

test("Paid plan shows the free allowance percentage without stopping paid usage", async () => {
  const { o } = usageOpts(() => new Response(JSON.stringify({
    data: { viewer: { accounts: [{ aiInferenceAdaptiveGroups: [{ sum: { totalNeurons: 23821.83 } }] }] } },
  })), "Workers Paid");
  const plugin = await CloudflareWorkersAIPlugin({}, o);
  const { windows: [w] } = await plugin.auth.usage(async () => ({ key: "tok", metadata: { accountId: ACCOUNT_ID } }));
  assert.equal(w.amount, 23821.83, "the count includes usage above the free allocation");
  assert.equal(w.limit, 10000);
  assert.equal(w.used, 100);
  assert.equal(w.aside, true, "the included allowance is not a Paid plan's hard cap");
  assert.equal(w.display, "");
});

function loaderOpts(statusResponder) {
  const o = opts();
  o.fetchImpl = async (url) => {
    if (typeof url === "string" && url.includes("models.dev")) {
      return new Response(JSON.stringify(fakeCatalog()));
    }
    return statusResponder(url);
  };
  return o;
}

test("a 429 code 3036 comes back with Retry-After until next UTC midnight", async () => {
  const spentBody = JSON.stringify({
    errors: [{ code: 3036, message: "you have used up your daily free allocation of 10,000 neurons" }],
  });
  const plugin = await CloudflareWorkersAIPlugin({}, loaderOpts(() => new Response(spentBody, { status: 429 })));
  const r = await plugin.auth.loader(async () => ({ key: "tok", metadata: { accountId: ACCOUNT_ID } }));
  // the plugin reads the clock inside fetch; sampling on both sides of the
  // call bounds that read, so a whole-second boundary between them cannot
  // push Retry-After past the window
  const before = Date.now();
  const resp = await r.fetch(`${r.baseURL}/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "@cf/meta/llama-3-8b-instruct", messages: [] }),
  });
  const after = Date.now();
  assert.equal(resp.status, 429);
  assert.deepEqual(JSON.parse(await resp.text()), JSON.parse(spentBody), "body preserved verbatim");
  const retryAfter = Number(resp.headers.get("retry-after"));
  const secondsToMidnight = (t) => Math.ceil(((Math.floor(t / 86400_000) + 1) * 86400_000 - t) / 1000);
  assert.ok(
    secondsToMidnight(after) <= retryAfter && retryAfter <= secondsToMidnight(before),
    `Retry-After ${retryAfter} must be the seconds to next UTC midnight from a clock read inside fetch (${secondsToMidnight(after)}–${secondsToMidnight(before)})`,
  );
});

test("any other 429 keeps its own words: no Retry-After is added", async () => {
  // a plain rate limit is transient — a day-long rest until UTC midnight
  // would bench a working account for hours
  const plugin = await CloudflareWorkersAIPlugin({}, loaderOpts(() =>
    new Response(JSON.stringify({ errors: [{ code: 700003, message: "rate limited" }] }), { status: 429 })
  ));
  const r = await plugin.auth.loader(async () => ({ key: "tok", metadata: { accountId: ACCOUNT_ID } }));
  const resp = await r.fetch(`${r.baseURL}/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "@cf/meta/llama-3-8b-instruct", messages: [] }),
  });
  assert.equal(resp.status, 429);
  assert.equal(resp.headers.get("retry-after"), null, "only a 3036 may name the midnight rest");
  assert.equal(JSON.parse(await resp.text()).errors[0].code, 700003, "body preserved");
});
