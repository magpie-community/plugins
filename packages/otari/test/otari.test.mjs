import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OtariPlugin, _internal } from "../index.mjs";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(body, status = 200) {
  return new Response(body, { status });
}

function modelFixture(overrides = {}) {
  return {
    id: "deepseek/deepseek-v4.1-flash",
    name: "DeepSeek V4.1 Flash",
    type: "chat",
    context_window: 128000,
    max_output_tokens: 8192,
    architecture: {
      input_modalities: ["text", "image"],
      output_modalities: ["text"],
    },
    supported_parameters: ["temperature", "tools", "reasoning_effort"],
    pricing: {
      input_price_per_million: 0.14,
      output_price_per_million: 0.28,
      cache_read_price_per_million: 0.01,
      cache_write_price_per_million: 0.02,
    },
    ...overrides,
  };
}

test("normalizes global, EU, origin-only and custom base URLs", () => {
  assert.equal(_internal.normalizeBaseURL(), _internal.DEFAULT_BASE_URL);
  assert.equal(
    _internal.normalizeBaseURL("https://eu.api.otari.ai/"),
    _internal.EU_BASE_URL,
  );
  assert.equal(
    _internal.normalizeBaseURL("http://localhost:8000"),
    "http://localhost:8000/api/v1",
  );
  assert.equal(
    _internal.normalizeBaseURL("http://localhost:8000/custom/v1/"),
    "http://localhost:8000/custom/v1",
  );
  assert.throws(() => _internal.normalizeBaseURL("ftp://example.com"));
  assert.throws(() =>
    _internal.normalizeBaseURL("https://example.com/api/v1?x=1"),
  );
  assert.throws(() =>
    _internal.normalizeBaseURL("https://user:pass@example.com/api/v1"),
  );
});

test("resolves region and custom base URL from auth metadata", () => {
  assert.equal(
    _internal.baseURLFromAuth({ metadata: { region: "eu" } }),
    _internal.EU_BASE_URL,
  );
  assert.equal(
    _internal.baseURLFromAuth({ metadata: { baseURL: "http://localhost:8000" } }),
    "http://localhost:8000/api/v1",
  );
  assert.equal(
    _internal.baseURLFromAuth({ metadata: { region: "global" } }),
    _internal.DEFAULT_BASE_URL,
  );
});

test("normalizes provider ids and falls back to the default", () => {
  assert.equal(_internal.normalizeProviderID("otari-provider"), "otari-provider");
  assert.equal(_internal.normalizeProviderID(" Otari_Plugin "), "otari_plugin");
  assert.equal(_internal.normalizeProviderID("bad id"), "otari");
  assert.equal(_internal.normalizeProviderID(null), "otari");
});

test("does not mistake a workspace token for a management key", () => {
  assert.equal(
    _internal.managementKeyFromAuth({
      metadata: { managementKey: "otk_v1_workspace" },
    }),
    "",
  );
  assert.equal(
    _internal.managementKeyFromAuth({
      metadata: { masterKey: "master-secret" },
    }),
    "master-secret",
  );
});

test("maps Otari model metadata, pricing and capabilities", () => {
  const mapped = _internal.mapModel(modelFixture(), {
    baseURL: _internal.DEFAULT_BASE_URL,
  });

  assert.equal(mapped.id, "deepseek/deepseek-v4.1-flash");
  assert.equal(mapped.name, "DeepSeek V4.1 Flash");
  assert.equal(mapped.api.id, mapped.id);
  assert.equal(mapped.api.npm, "@ai-sdk/openai-compatible");
  assert.deepEqual(mapped.limit, { context: 128000, output: 8192 });
  assert.deepEqual(mapped.cost, {
    input: 0.14,
    output: 0.28,
    cache: { read: 0.01, write: 0.02 },
  });
  assert.equal(mapped.capabilities.reasoning, true);
  assert.equal(mapped.capabilities.toolcall, true);
  assert.equal(mapped.capabilities.attachment, true);
  assert.equal(mapped.capabilities.input.image, true);
  assert.equal(mapped.temperature, true);
});

test("marks models served by the organization's own provider key", () => {
  const own = _internal.mapModel(
    modelFixture({ pricing_source: "organization" }),
  );
  assert.equal(own.organizationOwned, true);
  assert.equal(
    own.name,
    "[organization Inference providers] DeepSeek V4.1 Flash",
  );

  const providerNamed = _internal.mapModel(
    modelFixture({ pricing_source: "organization", owned_by: "deepseek" }),
  );
  assert.equal(
    providerNamed.name,
    "[organization Inference providers: deepseek] DeepSeek V4.1 Flash",
  );

  const hosted = _internal.mapModel(
    modelFixture({ pricing_source: "configured" }),
  );
  assert.equal(hosted.organizationOwned, undefined);
  assert.equal(hosted.name, "DeepSeek V4.1 Flash");
});

test("labels an organization model with its provider key name", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    const value = String(url);
    calls.push(value);
    if (value.includes("/organizations/me/provider-keys")) {
      return jsonResponse({
        data: [
          {
            id: "key-1",
            provider: "deepseek",
            slug: "mydeepseek",
            name: "mydeepseek",
            serving_count: 1,
          },
        ],
      });
    }
    if (value.endsWith("/organizations/me")) {
      return jsonResponse({
        organization: { name: "kaba's organization" },
      });
    }
    if (value.includes("/models?provider=mydeepseek")) {
      return jsonResponse({
        data: [
          modelFixture({
            pricing_source: "organization",
            owned_by: "deepseek",
          }),
        ],
      });
    }
    if (value.endsWith("/models")) {
      return jsonResponse({
        data: [modelFixture({ pricing_source: "configured" })],
      });
    }
    throw new Error(`unexpected URL: ${value}`);
  };

  const models = await _internal.listProviderModels(
    { models: _internal.bootstrapModels() },
    {
      auth: {
        type: "api",
        key: "otk_test",
        metadata: { dashboardSession: "session-value" },
      },
      fetchImpl,
    },
  );
  assert.equal(
    models["mydeepseek:deepseek-v4.1-flash"].name,
    "[mydeepseek] DeepSeek V4.1 Flash",
  );
  assert.equal(
    models["mydeepseek:deepseek-v4.1-flash"].api.id,
    "mydeepseek:deepseek-v4.1-flash",
  );
  assert.ok(
    calls.some((value) => value.includes("/models?provider=mydeepseek")),
    "the plugin must ask for the provider key's own listing",
  );
});

test("keeps model discovery when the Dashboard session has expired", async () => {
  const fetchImpl = async (url) => {
    const value = String(url);
    if (value.endsWith("/models")) {
      return jsonResponse({
        data: [modelFixture({ pricing_source: "configured" })],
      });
    }
    return textResponse("session expired", 401);
  };

  const models = await _internal.listProviderModels(
    { models: _internal.bootstrapModels() },
    {
      auth: {
        type: "api",
        key: "otk_test",
        metadata: { dashboardSession: "expired-session" },
      },
      fetchImpl,
    },
  );
  assert.equal(
    models["deepseek/deepseek-v4.1-flash"].name,
    "DeepSeek V4.1 Flash",
  );
});

test("exposes routing policies as Magpie models", async () => {
  const fetchImpl = async (url) => {
    const value = String(url);
    if (value.includes("/organizations/me/keys")) {
      return jsonResponse([
        { key_prefix: "otk_", key_suffix: "test", workspace_id: "ws-1" },
      ]);
    }
    if (value.includes("/organizations/me/provider-keys")) {
      return jsonResponse({ data: [] });
    }
    if (value.endsWith("/organizations/me")) {
      return jsonResponse({ organization: { name: "kaba's organization" } });
    }
    if (value.includes("/organizations/me/routing-policies")) {
      return jsonResponse([
        { name: "fast", workspace_id: "ws-1", spec: {} },
        { name: "other", workspace_id: "ws-2", spec: {} },
      ]);
    }
    if (value.endsWith("/models")) {
      return jsonResponse({ data: [modelFixture()] });
    }
    throw new Error(`unexpected URL: ${value}`);
  };

  const models = await _internal.listProviderModels(
    { models: _internal.bootstrapModels() },
    {
      auth: {
        type: "api",
        key: "otk_test",
        metadata: { dashboardSession: "session-value" },
      },
      fetchImpl,
    },
  );

  assert.equal(models["fast"].id, "fast");
  assert.equal(models["fast"].api.id, "fast");
  assert.equal(models["fast"].otariPolicy, true);
  assert.equal(models["fast"].name, "Otari 策略 · fast");
  assert.equal(models["other"], undefined);
  assert.equal(
    models["deepseek/deepseek-v4.1-flash"].id,
    "deepseek/deepseek-v4.1-flash",
  );
});

test("tags Otari requests with the Magpie session and model", async () => {
  const hooks = await OtariPlugin({
    client: { app: { log: async () => {} } },
  });
  const output = { headers: {} };
  await hooks["chat.headers"](
    {
      sessionID: "sess,1=2",
      model: { providerID: "otari", id: "policy/fast" },
    },
    output,
  );
  assert.equal(
    output.headers["Otari-Tags"],
    "app=magpie,session=sess%2C1%3D2,model=policy%2Ffast",
  );

  const other = { headers: {} };
  await hooks["chat.headers"](
    { sessionID: "s", model: { providerID: "other", id: "x" } },
    other,
  );
  assert.equal(other.headers["Otari-Tags"], undefined);
});

test("falls back to the organization name when two keys serve one provider", async () => {
  const fetchImpl = async (url) => {
    const value = String(url);
    if (value.includes("/organizations/me/provider-keys")) {
      return jsonResponse({
        data: [
          {
            id: "key-1",
            provider: "deepseek",
            slug: "ds-one",
            name: "ds-one",
            serving_count: 1,
          },
          {
            id: "key-2",
            provider: "deepseek",
            slug: "ds-two",
            name: "ds-two",
            serving_count: 1,
          },
        ],
      });
    }
    if (value.endsWith("/organizations/me")) {
      return jsonResponse({
        organization: { name: "kaba's organization" },
      });
    }
    if (value.includes("/models?provider=")) {
      return textResponse("unavailable", 500);
    }
    if (value.endsWith("/models")) {
      return jsonResponse({
        data: [
          modelFixture({
            pricing_source: "organization",
            owned_by: "deepseek",
          }),
        ],
      });
    }
    throw new Error(`unexpected URL: ${value}`);
  };

  const models = await _internal.listProviderModels(
    { models: _internal.bootstrapModels() },
    {
      auth: {
        type: "api",
        key: "otk_test",
        metadata: { dashboardSession: "session-value" },
      },
      fetchImpl,
    },
  );
  assert.equal(
    models["deepseek/deepseek-v4.1-flash"].name,
    "[kaba's organization] DeepSeek V4.1 Flash",
  );
});

test("adds a model only the organization provider key lists", async () => {
  const fetchImpl = async (url) => {
    const value = String(url);
    if (value.includes("/organizations/me/provider-keys")) {
      return jsonResponse({
        data: [
          {
            id: "key-1",
            provider: "deepseek",
            slug: "mydeepseek",
            name: "mydeepseek",
            serving_count: 1,
          },
        ],
      });
    }
    if (value.endsWith("/organizations/me")) {
      return jsonResponse({
        organization: { name: "kaba's organization" },
      });
    }
    if (value.includes("/models?provider=mydeepseek")) {
      return jsonResponse({
        data: [
          {
            id: "deepseek/only-org",
            name: "Only Org",
            owned_by: "deepseek",
            type: "chat",
            pricing_source: "organization",
          },
        ],
      });
    }
    if (value.endsWith("/models")) {
      return jsonResponse({ data: [modelFixture()] });
    }
    throw new Error(`unexpected URL: ${value}`);
  };

  const models = await _internal.listProviderModels(
    { models: _internal.bootstrapModels() },
    {
      auth: {
        type: "api",
        key: "otk_test",
        metadata: { dashboardSession: "session-value" },
      },
      fetchImpl,
    },
  );
  assert.equal(models["mydeepseek:only-org"].name, "[mydeepseek] Only Org");
  assert.equal(models["mydeepseek:only-org"].organizationOwned, true);
  assert.equal(models["mydeepseek:only-org"].api.id, "mydeepseek:only-org");
});

test("does not invent pricing and marks zero-priced models free", () => {
  const noPrice = _internal.mapModel(
    modelFixture({ pricing: null, supported_parameters: null }),
  );
  assert.equal(noPrice.cost, undefined);
  assert.equal(noPrice.free, undefined);
  assert.equal(noPrice.capabilities.toolcall, true);

  const free = _internal.mapModel(
    modelFixture({
      pricing: {
        input_price_per_million: 0,
        output_price_per_million: 0,
        cache_read_price_per_million: 0,
        cache_write_price_per_million: 0,
      },
    }),
  );
  assert.equal(free.free, true);
  assert.deepEqual(free.cost, {
    input: 0,
    output: 0,
    cache: { read: 0, write: 0 },
  });
});

test("marks a model free only when every stated price is zero", () => {
  const zero = {
    input_price_per_million: 0,
    output_price_per_million: 0,
  };
  assert.equal(_internal.isFreePricing(zero), true);

  // A missing input rate is unknown, not free.
  assert.equal(_internal.isFreePricing({ output_price_per_million: 0 }), false);

  // Priced per request or image, not per token.
  assert.equal(_internal.isFreePricing({ ...zero, unit: "request" }), false);

  // Free only inside the first tier: a long request is still billed.
  assert.equal(
    _internal.isFreePricing({
      ...zero,
      pricing_tiers: [
        { min_input_tokens: 32000, input_price_per_million: 5 },
      ],
    }),
    false,
  );

  // Tiers that stay at zero do not make it paid.
  assert.equal(
    _internal.isFreePricing({
      ...zero,
      pricing_tiers: [
        { min_input_tokens: 32000, input_price_per_million: 0 },
      ],
    }),
    true,
  );
});

test("does not mark a model free when its input price is missing", () => {
  const mapped = _internal.mapModel(
    modelFixture({ pricing: { output_price_per_million: 0 } }),
  );
  assert.equal(mapped.free, undefined);
});

test("fetches only chat models and keeps nested slashes in ids", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), headers: new Headers(init.headers) });
    return jsonResponse({
      data: [
        modelFixture(),
        modelFixture({ id: "image/model", type: "image" }),
      ],
    });
  };

  const models = await _internal.fetchModels({
    auth: { type: "api", key: "otk_test" },
    fetchImpl,
  });
  assert.equal(models.length, 1);
  assert.equal(models[0].id, "deepseek/deepseek-v4.1-flash");
  assert.match(seen[0].url, /\/models$/);
  assert.equal(seen[0].headers.get("authorization"), "Bearer otk_test");
});

test("marks 401 model reads as an expired sign-in", async () => {
  await assert.rejects(
    () =>
      _internal.fetchModels({
        auth: { type: "api", key: "otk_bad" },
        fetchImpl: async () => textResponse("bad key", 401),
      }),
    (error) => error.status === 401 && error.signIn === "expired",
  );
});

test("falls back to current pricing when /models omits it", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).includes("/models")) {
      return jsonResponse({
        data: [modelFixture({ pricing: null })],
      });
    }
    if (String(url).includes("/pricing/current")) {
      return jsonResponse({
        count: 1,
        data: [
          {
            kind: "model",
            model_key: "deepseek/deepseek-v4.1-flash",
            input_price_per_million: 0.5,
            output_price_per_million: 1.5,
            cache_read_price_per_million: 0.05,
            cache_write_price_per_million: 0.1,
          },
        ],
      });
    }
    throw new Error(`unexpected URL: ${url}`);
  };

  const models = await _internal.listProviderModels(
    { models: _internal.bootstrapModels() },
    { auth: { type: "api", key: "otk_test" }, fetchImpl },
  );
  assert.equal(calls.length, 2);
  assert.deepEqual(models["deepseek/deepseek-v4.1-flash"].cost, {
    input: 0.5,
    output: 1.5,
    cache: { read: 0.05, write: 0.1 },
  });
});

test("keeps model discovery working when the pricing endpoint fails", async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes("/models")) {
      return jsonResponse({ data: [modelFixture({ pricing: null })] });
    }
    return textResponse("pricing unavailable", 500);
  };

  const models = await _internal.listProviderModels(
    { models: _internal.bootstrapModels() },
    { auth: { type: "api", key: "otk_test" }, fetchImpl },
  );
  assert.equal(models["deepseek/deepseek-v4.1-flash"].cost, undefined);
});

test("builds usage, budget and wallet windows", () => {
  const usage = _internal.buildUsage({
    summary: {
      totals: {
        cost: 1.2345,
        request_count: 3,
        total_tokens: 150,
        error_count: 1,
      },
    },
    budget: {
      budgets_enforced: true,
      remaining_usd: 8.5,
      limits: [
        {
          scope: "api_token",
          limit_usd: 10,
          used_usd: 1.5,
          remaining_usd: 8.5,
          resets_at: "2026-12-01T00:00:00Z",
        },
      ],
    },
  });

  assert.equal(usage.windows.length, 3);
  assert.equal(usage.windows[0].name, "预算 (API Key)");
  assert.equal(usage.windows[0].used, 15);
  assert.equal(usage.windows[0].amount, 1.5);
  assert.equal(usage.windows[0].limit, 10);
  assert.equal(usage.windows[0].resetsAt, "2026-12-01T00:00:00Z");
  assert.equal(usage.windows[1].name, "余额");
  assert.equal(usage.windows[1].balance, 8.5);
  assert.equal(usage.windows[1].aside, true);
  assert.equal(usage.windows[2].name, "最近 30 天");
  assert.match(usage.windows[2].display, /3 次请求/);
});

test("omits the wallet window when remaining_usd is null", () => {
  const usage = _internal.buildUsage({
    budget: {
      budgets_enforced: true,
      remaining_usd: null,
      limits: [],
    },
  });
  assert.equal(usage.windows.length, 0);
  assert.equal(usage.signIn, "kept");
});

test("loads usage and budget, tolerating a missing budget endpoint", async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes("/key/usage/summary")) {
      return jsonResponse({
        totals: {
          cost: 0.25,
          request_count: 2,
          total_tokens: 42,
          error_count: 0,
        },
      });
    }
    return textResponse("not found", 404);
  };

  const { usage, errors } = await _internal.loadUsage({
    auth: { type: "api", key: "otk_test" },
    fetchImpl,
  });
  assert.equal(errors.length, 0);
  assert.equal(usage.windows.length, 1);
  assert.equal(usage.windows[0].name, "最近 30 天");
});

test("keeps budget data when usage fails", async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes("/key/usage/summary")) {
      return textResponse("boom", 500);
    }
    return jsonResponse({
      budgets_enforced: true,
      remaining_usd: 2,
      limits: [],
    });
  };

  const { usage, errors } = await _internal.loadUsage({
    auth: { type: "api", key: "otk_test" },
    fetchImpl,
  });
  assert.equal(errors.length, 1);
  assert.equal(usage.windows[0].name, "余额");
  assert.equal(usage.windows[0].balance, 2);
});

test("a 401 from usage endpoints does not expire the inference sign-in", async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes("/key/usage/summary")) {
      return textResponse("bad key", 401);
    }
    return textResponse("bad key", 401);
  };

  const { usage, errors } = await _internal.loadUsage({
    auth: { type: "api", key: "otk_bad" },
    fetchImpl,
  });
  assert.equal(errors.length, 2);
  assert.equal(usage.signIn, "kept");
  assert.match(usage.error, /重新登录/);
  assert.match(usage.error, /sign in again/);
  assert.equal(usage.windows.length, 0);
});

test("reads wallet and organization usage with a management key", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const path = new URL(String(url)).pathname;
    calls.push({ path, headers: new Headers(init.headers) });
    if (path === "/api/v1/wallet") {
      return jsonResponse({
        organization_id: "org-1",
        balance: "10.00",
        offered_balance: "10.00",
        reserved: "1.50",
        available: "8.50",
        currency: "USD",
        can_add_funds: true,
        fee_rate_bps: 450,
      });
    }
    if (path === "/api/v1/organizations/me/usage/summary") {
      return jsonResponse({
        totals: {
          cost: 1.5,
          request_count: 3,
          total_tokens: 150,
          error_count: 0,
        },
      });
    }
    throw new Error(`unexpected URL: ${url}`);
  };

  const { usage, errors } = await _internal.loadUsage({
    auth: {
      type: "api",
      key: "otk_workspace",
      metadata: { managementKey: "master-secret" },
    },
    fetchImpl,
  });

  assert.equal(errors.length, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers.get("authorization"), "Bearer master-secret");
  assert.equal(calls[1].headers.get("authorization"), "Bearer master-secret");
  assert.equal(usage.windows[0].name, "余额");
  assert.equal(usage.windows[0].balance, 8.5);
  assert.equal(usage.windows[0].unit, "USD");
  assert.equal(usage.windows[1].name, "最近 30 天");
});

test("reads the current key budget and reset time from a dashboard session", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const parsed = new URL(String(url));
    calls.push({ url: parsed, headers: new Headers(init.headers) });
    if (parsed.pathname === "/api/v1/organizations/me/keys") {
      return jsonResponse([
        {
          id: "key-1",
          key_name: "magpie",
          key_prefix: "otk_v1_us_ABC",
          key_suffix: "XYZ",
          workspace_id: "workspace-1",
        },
      ]);
    }
    if (parsed.pathname === "/api/v1/organizations/me/spend-ceilings") {
      return jsonResponse({
        count: 1,
        data: [
          {
            id: "ceiling-1",
            scope_type: "api_token",
            scope_id: "key-1",
            budget_id: "budget-1",
            max_budget: 50,
            current_spend: 1.5,
            reserved_spend: 0.5,
            period_start: "2026-11-06T08:00:00+08:00",
            period_end: "2026-11-07T08:00:00+08:00",
            reset_alignment: "calendar_day",
          },
        ],
      });
    }
    if (parsed.pathname === "/api/v1/organizations/me/budgets") {
      return jsonResponse({
        count: 1,
        data: [
          {
            budget_id: "budget-1",
            name: "magpie (API key)",
            max_budget: 50,
            reset_alignment: "calendar_day",
          },
        ],
      });
    }
    if (parsed.pathname === "/api/v1/organizations/me/usage/summary") {
      return jsonResponse({
        totals: {
          cost: 1.5,
          request_count: 3,
          total_tokens: 150,
          error_count: 0,
        },
      });
    }
    if (parsed.pathname === "/api/v1/wallet") {
      return jsonResponse({
        organization_id: "org-1",
        balance: "2.00",
        offered_balance: "2.00",
        reserved: "0.00",
        available: "2.00",
        currency: "USD",
        can_add_funds: true,
        fee_rate_bps: 450,
      });
    }
    if (
      parsed.pathname === "/api/v1/organizations/me/routing-policies"
    ) {
      return jsonResponse([
        {
          name: "fast",
          source: "storage",
          spec: { type: "fallback", order: ["provider-a", "provider-b"] },
        },
      ]);
    }
    throw new Error(`unexpected URL: ${url}`);
  };

  const { usage, keyBudget } = await _internal.loadUsage({
    auth: {
      type: "api",
      key: "otk_v1_us_ABC123XYZ",
      metadata: {
        baseURL: "https://api.otari.ai/api/v1",
        dashboardSession: "session-abc",
      },
    },
    fetchImpl,
  });

  assert.equal(keyBudget.keyId, "key-1");
  assert.equal(usage.windows[0].name, "Key 预算 (magpie (API key))");
  assert.equal(usage.windows[0].used, 3);
  assert.equal(usage.windows[0].amount, 1.5);
  assert.equal(usage.windows[0].limit, 50);
  assert.equal(usage.windows[0].resetsAt, "2026-11-07T08:00:00+08:00");
  assert.equal(usage.windows[1].name, "余额");
  assert.equal(usage.windows[1].balance, 2);
  assert.equal(usage.windows[2].name, "最近 30 天");
  assert.equal(usage.windows[3].name, "路由：fast");
  assert.match(usage.windows[3].display, /provider-a/);
  assert.equal(calls[0].url.hostname, "otari.ai");
  assert.equal(
    calls[0].headers.get("cookie"),
    "otari_dashboard_session=session-abc",
  );
});

test("authorized fetch preserves body and adds only the missing auth header", async () => {
  let seen;
  const fetchImpl = async (input, init) => {
    seen = { input, init, headers: new Headers(init.headers) };
    return new Response("streamed", { status: 200 });
  };
  const wrapped = _internal.makeAuthorizedFetch("otk_test", fetchImpl);
  const response = await wrapped("https://api.otari.ai/api/v1/chat/completions", {
    method: "POST",
    body: '{"model":"x"}',
    headers: { "x-test": "1" },
  });

  assert.equal(await response.text(), "streamed");
  assert.equal(seen.init.method, "POST");
  assert.equal(seen.init.body, '{"model":"x"}');
  assert.equal(seen.headers.get("x-test"), "1");
  assert.equal(seen.headers.get("authorization"), "Bearer otk_test");
});

test("plugin config and loader expose the Otari provider", async () => {
  const hooks = await OtariPlugin({ client: { app: { log: async () => {} } } });
  const cfg = {};
  await hooks.config(cfg);

  assert.equal(hooks.auth.provider, "otari");
  assert.equal(hooks.provider.id, "otari");
  assert.equal(hooks.auth.icon, _internal.ICON_URL);
  assert.equal(hooks.auth.single, undefined);
  const method = hooks.auth.methods[0];
  assert.equal(method.keyless, true);
  assert.deepEqual(
    method.prompts.map((prompt) => prompt.key),
    [
      "region",
      "apiKey",
      "authMode",
      "dashboardSession",
      "email",
      "password",
    ],
  );
  assert.deepEqual(
    method.prompts[0].options.map((option) => option.value),
    ["global", "eu"],
  );
  assert.match(method.prompts[1].message, /必填/);
  assert.deepEqual(
    method.prompts[2].options.map((option) => option.value),
    ["cookie", "account", "skip"],
  );
  assert.equal(method.prompts[3].when.value, "cookie");
  assert.equal(method.prompts[4].when.value, "account");
  assert.equal(method.prompts[5].when.value, "account");
  assert.match(method.prompts[3].message, /无法获取/);
  assert.equal(method.prompts[4].placeholder, "请输入账号");
  assert.equal(method.prompts[5].placeholder, "请输入密码");
  assert.match(method.prompts[5].message, /不保存/);
  assert.equal(hooks.auth.methods.length, 2);
  assert.match(hooks.auth.methods[1].label, /补充现有账号/);
  assert.equal(cfg.provider.otari.name, "Otari");
  assert.equal(cfg.provider.otari.npm, "@ai-sdk/openai-compatible");
  assert.equal(cfg.provider.otari.api, _internal.DEFAULT_BASE_URL);
  assert.ok(cfg.provider.otari.models[_internal.FALLBACK_MODEL_ID]);

  const loader = await hooks.auth.loader(async () => ({
    type: "api",
    key: "otk_test",
    metadata: { region: "eu" },
  }));
  assert.equal(loader.baseURL, _internal.EU_BASE_URL);
  assert.equal(loader.apiKey, "otk_test");
  assert.equal(typeof loader.fetch, "function");
});

test("API key authorizes first and the optional session is stored", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(String(url));
    calls.push({ url: parsed, headers: new Headers(init.headers) });
    if (parsed.pathname === "/api/v1/models") {
      return jsonResponse({ data: [] });
    }
    if (parsed.pathname === "/api/v1/wallet") {
      return jsonResponse({
        available: "2.00",
        balance: "2.00",
        currency: "USD",
      });
    }
    throw new Error(`unexpected URL: ${url}`);
  };
  try {
    const hooks = await OtariPlugin({ client: { app: { log: async () => {} } } });
    const inputs = {
      region: "global",
      apiKey: "otk_test_key",
      authMode: "cookie",
      dashboardSession: "session-test",
    };
    const result = await hooks.auth.methods[0].authorize(inputs, {});

    assert.equal(result.type, "success");
    assert.equal(result.key, "otk_test_key");
    assert.equal(result.metadata.region, "global");
    assert.equal(result.metadata.dashboardSession, "session-test");
    assert.equal(inputs.apiKey, undefined);
    assert.equal(
      calls.find((call) => call.url.pathname === "/api/v1/wallet").headers.get(
        "cookie",
      ),
      "otari_dashboard_session=session-test",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("API key authorization fails clearly without a key", async () => {
  const hooks = await OtariPlugin({ client: { app: { log: async () => {} } } });
  const result = await hooks.auth.methods[0].authorize(
    { apiKey: "", dashboardSession: "" },
    {},
  );
  assert.equal(result.type, "failed");
  assert.match(result.error, /必填/);
});

test("dashboard login can be skipped without storing a session", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/v1/models") {
      return jsonResponse({ data: [] });
    }
    throw new Error(`unexpected URL: ${url}`);
  };
  try {
    const hooks = await OtariPlugin({ client: { app: { log: async () => {} } } });
    const inputs = {
      region: "global",
      apiKey: "otk_test_key",
      authMode: "skip",
    };
    const result = await hooks.auth.methods[0].authorize(inputs, {});
    assert.equal(result.type, "success");
    assert.equal(result.metadata.dashboardSession, undefined);
    assert.equal(inputs.apiKey, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cookie mode requires a dashboard session", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/v1/models") {
      return jsonResponse({ data: [] });
    }
    throw new Error(`unexpected URL: ${url}`);
  };
  try {
    const hooks = await OtariPlugin({ client: { app: { log: async () => {} } } });
    const result = await hooks.auth.methods[0].authorize(
      {
        region: "global",
        apiKey: "otk_test_key",
        authMode: "cookie",
        dashboardSession: "",
      },
      {},
    );
    assert.equal(result.type, "failed");
    assert.match(result.error, /Dashboard session/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("EU region validation uses the EU API and dashboard hosts", async () => {
  const originalFetch = globalThis.fetch;
  const hosts = [];
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    hosts.push({ host: parsed.hostname, path: parsed.pathname });
    if (parsed.pathname === "/api/v1/models") {
      return jsonResponse({ data: [] });
    }
    if (parsed.pathname === "/api/v1/wallet") {
      return jsonResponse({ available: "1.00", currency: "USD" });
    }
    throw new Error(`unexpected URL: ${url}`);
  };
  try {
    const hooks = await OtariPlugin({ client: { app: { log: async () => {} } } });
    const result = await hooks.auth.methods[0].authorize(
      {
        region: "eu",
        apiKey: "otk_test_key",
        authMode: "cookie",
        dashboardSession: "session-test",
      },
      {},
    );
    assert.equal(result.type, "success");
    assert.equal(result.metadata.region, "eu");
    assert.ok(
      hosts.some(
        (entry) =>
          entry.host === "eu.api.otari.ai" && entry.path === "/api/v1/models",
      ),
    );
    assert.ok(
      hosts.some(
        (entry) =>
          entry.host === "eu.otari.ai" && entry.path === "/api/v1/wallet",
      ),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("account login exchanges email/password for a session and clears the password", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(String(url));
    calls.push({ url: parsed, init });
    if (parsed.pathname === "/api/v1/models") {
      return jsonResponse({ data: [] });
    }
    if (parsed.pathname === "/api/v1/auth/session") {
      return new Response(
        JSON.stringify({
          expires_at: "2026-11-13T06:41:23.547018Z",
          user_id: "user-1",
          active_organization_id: "org-1",
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            "set-cookie":
              "otari_dashboard_session=session-xyz; Path=/; HttpOnly",
          },
        },
      );
    }
    throw new Error(`unexpected URL: ${url}`);
  };
  try {
    const hooks = await OtariPlugin({ client: { app: { log: async () => {} } } });
    const inputs = {
      region: "global",
      apiKey: "otk_test_key",
      authMode: "account",
      email: "test@example.com",
      password: "secret-password",
    };
    const result = await hooks.auth.methods[0].authorize(inputs, {});

    assert.equal(result.type, "success");
    assert.equal(result.key, "otk_test_key");
    assert.equal(result.metadata.dashboardSession, "session-xyz");
    assert.equal(result.metadata.dashboardExpiresAt, "2026-11-13T06:41:23.547018Z");
    assert.equal(result.metadata.dashboardUserId, "user-1");
    assert.equal(result.metadata.accountEmail, "test@example.com");
    assert.equal(result.metadata.password, undefined);
    assert.equal(inputs.password, undefined);
    assert.equal(inputs.apiKey, undefined);

    const loginCall = calls.find(
      (call) => call.url.pathname === "/api/v1/auth/session",
    );
    assert.ok(loginCall);
    const body = JSON.parse(loginCall.init.body);
    assert.equal(body.email, "test@example.com");
    assert.equal(body.password, "secret-password");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("account login requires email and password", async () => {
  const hooks = await OtariPlugin({ client: { app: { log: async () => {} } } });
  const noEmail = await hooks.auth.methods[0].authorize(
    {
      region: "global",
      apiKey: "otk_test",
      authMode: "account",
      email: "",
      password: "x",
    },
    {},
  );
  assert.equal(noEmail.type, "failed");
  assert.match(noEmail.error, /邮箱必填/);

  const noPassword = await hooks.auth.methods[0].authorize(
    {
      region: "global",
      apiKey: "otk_test",
      authMode: "account",
      email: "test@example.com",
      password: "",
    },
    {},
  );
  assert.equal(noPassword.type, "failed");
  assert.match(noPassword.error, /密码必填/);
});

test("failed account login asks for account and password again", async () => {
  const originalFetch = globalThis.fetch;
  let loginCalls = 0;
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/v1/models") {
      return jsonResponse({ data: [] });
    }
    if (parsed.pathname === "/api/v1/auth/session") {
      loginCalls += 1;
      if (loginCalls === 1) {
        return textResponse("wrong password", 401);
      }
      return new Response(
        JSON.stringify({
          expires_at: "2026-11-13T06:41:23.547018Z",
          user_id: "user-1",
          active_organization_id: "org-1",
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            "set-cookie":
              "otari_dashboard_session=retry-session; Path=/; HttpOnly",
          },
        },
      );
    }
    throw new Error(`unexpected URL: ${url}`);
  };
  try {
    const hooks = await OtariPlugin({ client: { app: { log: async () => {} } } });
    const method = hooks.auth.methods[0];
    const inputs = {
      region: "global",
      apiKey: "otk_test_key",
      authMode: "account",
      email: "old@example.com",
      password: "wrong-password",
    };

    const first = await method.authorize(inputs, {});
    assert.equal(first.type, "failed");
    assert.match(first.error, /账号登录失败/);

    const choice = method.ask(inputs);
    assert.equal(choice.key, "authMode");
    assert.deepEqual(
      choice.options.map((option) => option.value),
      ["account", "skip"],
    );

    const emailPrompt = method.ask(inputs);
    assert.equal(emailPrompt.key, "email-r1");
    assert.equal(emailPrompt.placeholder, "请输入账号");
    inputs[emailPrompt.key] = "new@example.com";

    const passwordPrompt = method.ask(inputs);
    assert.equal(passwordPrompt.key, "password-r1");
    assert.equal(passwordPrompt.placeholder, "请输入密码");
    inputs[passwordPrompt.key] = "new-password";

    assert.equal(method.ask(inputs), null);
    const second = await method.authorize(inputs, {});
    assert.equal(second.type, "success");
    assert.equal(second.metadata.dashboardSession, "retry-session");
    assert.equal(second.metadata.accountEmail, "new@example.com");
    assert.equal(inputs.password, undefined);
    assert.equal(inputs["password-r1"], undefined);
    assert.equal(inputs.apiKey, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("failed account login can skip and keep only the API key", async () => {
  const originalFetch = globalThis.fetch;
  let loginCalls = 0;
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/v1/models") {
      return jsonResponse({ data: [] });
    }
    if (parsed.pathname === "/api/v1/auth/session") {
      loginCalls += 1;
      return textResponse("wrong password", 401);
    }
    throw new Error(`unexpected URL: ${url}`);
  };
  try {
    const hooks = await OtariPlugin({ client: { app: { log: async () => {} } } });
    const method = hooks.auth.methods[0];
    const inputs = {
      region: "global",
      apiKey: "otk_test_key",
      authMode: "account",
      email: "old@example.com",
      password: "wrong-password",
    };

    const first = await method.authorize(inputs, {});
    assert.equal(first.type, "failed");
    assert.equal(loginCalls, 1);

    const choice = method.ask(inputs);
    assert.equal(choice.key, "authMode");
    inputs.authMode = "skip";
    assert.equal(method.ask(inputs), null);

    const skipped = await method.authorize(inputs, {});
    assert.equal(skipped.type, "success");
    assert.equal(skipped.metadata.dashboardSession, undefined);
    assert.equal(loginCalls, 1);
    assert.equal(inputs.apiKey, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("plugin options can choose a non-conflicting provider id", async () => {
  const hooks = await OtariPlugin(
    { client: { app: { log: async () => {} } } },
    { providerID: "otari-provider" },
  );
  const cfg = {};
  await hooks.config(cfg);

  assert.equal(hooks.auth.provider, "otari-provider");
  assert.equal(hooks.provider.id, "otari-provider");
  assert.ok(cfg.provider["otari-provider"]);
  assert.equal(cfg.provider["otari-provider"].name, "Otari");
  assert.equal(cfg.provider.otari, undefined);
});

test("supplement login reuses the stored API key without asking again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "magpie-otari-auth-"));
  writeFileSync(
    join(dir, "plugin-auth.json"),
    JSON.stringify({
      otari: {
        type: "api",
        key: "otk_stored_key",
        metadata: { region: "global" },
      },
    }),
  );
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    calls.push(parsed.pathname);
    if (parsed.pathname === "/api/v1/wallet") {
      return jsonResponse({ available: "2.00", currency: "USD" });
    }
    throw new Error(`unexpected URL: ${url}`);
  };
  try {
    const hooks = await OtariPlugin({
      client: { app: { log: async () => {} } },
      directory: dir,
    });
    assert.equal(hooks.auth.methods.length, 2);
    const supplement = hooks.auth.methods[1];
    assert.deepEqual(
      supplement.prompts.map((prompt) => prompt.key),
      ["authMode", "dashboardSession", "email", "password"],
    );
    assert.equal(supplement.ask({}).key, "authMode");
    assert.equal(hooks.auth.single, true);

    const result = await supplement.authorize(
      { authMode: "cookie", dashboardSession: "session-stored" },
      {},
    );
    assert.equal(result.type, "success");
    assert.equal(result.key, "otk_stored_key");
    assert.equal(result.metadata.dashboardSession, "session-stored");
    assert.equal(result.metadata.region, "global");
    assert.equal(hooks.auth.single, false);
    assert.deepEqual(calls, ["/api/v1/wallet"]);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("plugin model hook returns a marked fallback list on upstream failure", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => textResponse("boom", 500);
  try {
    const hooks = await OtariPlugin({ client: { app: { log: async () => {} } } });
    const models = await hooks.provider.models(
      {
        models: {
          fallback: { name: "Fallback" },
        },
      },
      { auth: { type: "api", key: "otk_test" } },
    );
    assert.ok(models.fallback);
    assert.equal(models[_internal.FALLBACK_SYMBOL], true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("plugin model hook propagates an expired sign-in", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => textResponse("bad key", 401);
  try {
    const hooks = await OtariPlugin({ client: { app: { log: async () => {} } } });
    await assert.rejects(
      () =>
        hooks.provider.models(
          { models: _internal.bootstrapModels() },
          { auth: { type: "api", key: "otk_bad" } },
        ),
      (error) => error.status === 401 && error.signIn === "expired",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
