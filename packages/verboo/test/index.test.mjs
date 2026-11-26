import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin, { _internal } from "../index.mjs";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

async function withMockFetch(mockImpl, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = mockImpl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
    _internal.resetState();
  }
}

test("plugin export shape matches Magpie/OpenCode v1 contract", async () => {
  assert.equal(plugin.id, "magpie-verboo");
  assert.equal(typeof plugin.server, "function");

  const hooks = await plugin.server({});
  assert.equal(typeof hooks.config, "function");
  assert.equal(hooks.auth.provider, "verboo");
  assert.equal(hooks.auth.rotating, true);
  assert.equal(hooks.auth.icon, _internal.ICON_URL);
  assert.equal(hooks.auth.refreshLead, 60_000);
  assert.equal(typeof hooks.auth.refresh, "function");
  assert.equal(typeof hooks.auth.usage, "function");
  assert.equal(typeof hooks.auth.loader, "function");
  assert.equal(hooks.provider.id, "verboo");
  assert.equal(typeof hooks.provider.models, "function");

  assert.equal(hooks.auth.methods.length, 1);
  assert.equal(hooks.auth.methods[0].type, "oauth");
  assert.equal(hooks.auth.methods[0].labels.en, "Sign in with Verboo");
});

test("config hook merges defaults without overwriting user overrides", async () => {
  const hooks = await plugin.server({});

  const fresh = {};
  await hooks.config(fresh);
  assert.equal(fresh.provider.verboo.name, "Verboo Code");
  assert.equal(fresh.provider.verboo.npm, "@ai-sdk/openai-compatible");
  assert.equal(fresh.provider.verboo.api, _internal.BASE_URL);
  assert.deepEqual(fresh.provider.verboo.models, {});

  const partial = { provider: { verboo: { name: "My Verboo" } } };
  await hooks.config(partial);
  assert.equal(partial.provider.verboo.name, "My Verboo");
  assert.equal(partial.provider.verboo.api, _internal.BASE_URL);
  assert.equal(partial.provider.verboo.npm, "@ai-sdk/openai-compatible");
});

test("credential accepts valid OAuth tokens and rejects non-OAuth or malformed credentials", () => {
  assert.equal(_internal.credential(undefined), undefined);
  assert.throws(() => _internal.credential({ type: "api", key: "legacy_key" }), (e) => e.signIn === "expired");

  assert.equal(_internal.credential({ type: "oauth", access: "  tok_123  " }), "tok_123");
  assert.throws(() => _internal.credential({ type: "oauth", access: "" }), (e) => e.signIn === "expired");
  assert.throws(() => _internal.credential({ type: "oauth", access: "tok bad" }), (e) => e.signIn === "expired");
});

test("modelCatalog maps capabilities, limits, trimmed names, and Magpie 'none' variant", () => {
  const catalog = _internal.modelCatalog([
    {
      id: "max/deepseek-v4",
      display_name: "  DeepSeek V4  ",
      context_window: 131072,
      max_output_tokens: 16384,
      vision: true,
      reasoning: { effort_levels: ["off", "low", "medium", "high"], default_effort: "medium" },
    },
    {
      id: "fast/non-reasoning",
      name: "Fast Chat",
      contextWindow: 65536,
      max_completion_tokens: 4096,
      vision: false,
      reasoning: { effort_levels: ["off"] },
    },
    {
      id: "bare-reasoning",
      reasoning: true,
    },
    {
      id: "   ",
    },
  ]);

  assert.deepEqual(Object.keys(catalog), ["max/deepseek-v4", "fast/non-reasoning", "bare-reasoning"]);

  const ds = catalog["max/deepseek-v4"];
  assert.equal(ds.name, "DeepSeek V4");
  assert.deepEqual(ds.limit, { context: 131072, output: 16384 });
  assert.equal(ds.capabilities.input.image, true);
  assert.equal(ds.capabilities.attachment, true);
  assert.equal(ds.capabilities.reasoning, true);
  assert.deepEqual(Object.keys(ds.variants), ["none", "low", "medium", "high"]);

  const fast = catalog["fast/non-reasoning"];
  assert.equal(fast.capabilities.reasoning, false);
  assert.equal(fast.capabilities.input.image, false);
  assert.equal(fast.limit.output, 4096);
  assert.equal(fast.variants, undefined);

  const bare = catalog["bare-reasoning"];
  assert.equal(bare.capabilities.reasoning, true);
  assert.equal(bare.variants, undefined);
  assert.deepEqual(bare.limit, { context: 32768, output: 8192 });

  assert.throws(
    () => _internal.modelCatalog([{ id: "dup" }, { id: "dup" }]),
    /模型列表格式无效/,
  );
  assert.throws(
    () => _internal.modelCatalog([{ id: "  " }]),
    /没有有效的模型 ID/,
  );
});

test("shapeChatBody handles unspecified, explicit off, clamping, non-reasoning, and unknown models", () => {
  const catalog = _internal.modelCatalog([
    {
      id: "m-with-off",
      reasoning: { effort_levels: ["off", "low", "medium", "high"] },
    },
    {
      id: "m-no-off",
      reasoning: { effort_levels: ["low", "high"] },
    },
    {
      id: "m-plain",
      reasoning: false,
    },
    {
      id: "m-bare",
      reasoning: true,
    },
  ]);
  const index = _internal.buildModelReasoningIndex({ models: catalog });

  // 1. Unspecified effort MUST NOT force thinking: disabled even when model supports off!
  const untouched = JSON.parse(
    _internal.shapeChatBody(JSON.stringify({ model: "m-with-off", messages: [] }), undefined, index),
  );
  assert.equal("thinking" in untouched, false);
  assert.equal("reasoning_effort" in untouched, false);

  // 2. Explicit off/none omits both thinking and reasoning_effort (matches Verboo Code's off: null)
  const explicitOff = JSON.parse(
    _internal.shapeChatBody(
      JSON.stringify({
        model: "m-with-off",
        reasoning_effort: "high",
        thinking: { type: "enabled" },
        messages: [],
      }),
      { "x-magpie-effort": "none" },
      index,
    ),
  );
  assert.equal("thinking" in explicitOff, false);
  assert.equal("reasoning_effort" in explicitOff, false);

  // 3. Explicit off on model without off also strips reasoning_effort & thinking
  const offNoSupport = JSON.parse(
    _internal.shapeChatBody(
      JSON.stringify({ model: "m-no-off", thinking: { type: "enabled" }, messages: [] }),
      { "x-magpie-effort": "off" },
      index,
    ),
  );
  assert.equal("thinking" in offNoSupport, false);
  assert.equal("reasoning_effort" in offNoSupport, false);

  // 4. Clamping: max -> high, minimal -> low, medium on [low, high] ties UP -> high
  const clampedMax = JSON.parse(
    _internal.shapeChatBody(
      JSON.stringify({ model: "m-with-off", messages: [] }),
      { "x-magpie-effort": "max" },
      index,
    ),
  );
  assert.deepEqual(clampedMax.thinking, { type: "enabled" });
  assert.equal(clampedMax.reasoning_effort, "high");

  const clampedMin = JSON.parse(
    _internal.shapeChatBody(
      JSON.stringify({ model: "m-with-off", messages: [] }),
      { "x-magpie-effort": "minimal" },
      index,
    ),
  );
  assert.equal(clampedMin.reasoning_effort, "low");

  const tieUp = JSON.parse(
    _internal.shapeChatBody(
      JSON.stringify({ model: "m-no-off", messages: [] }),
      { "x-magpie-effort": "medium" },
      index,
    ),
  );
  assert.equal(tieUp.reasoning_effort, "high");

  // 5. Non-reasoning model strips reasoning_effort, reasoning.effort, and any residual thinking
  const plain = JSON.parse(
    _internal.shapeChatBody(
      JSON.stringify({
        model: "m-plain",
        reasoning_effort: "high",
        reasoning: { effort: "high" },
        thinking: { type: "enabled" },
        messages: [],
      }),
      { "x-magpie-effort": "high" },
      index,
    ),
  );
  assert.equal("thinking" in plain, false);
  assert.equal("reasoning_effort" in plain, false);
  assert.equal("reasoning" in plain, false);

  // 6. Bare reasoning model passes normalized effort (ultra -> max) and supports Uint8Array body
  const encoded = new TextEncoder().encode(
    JSON.stringify({ model: "m-bare", reasoning: { effort: "ultra", keep: 1 }, messages: [] }),
  );
  const bare = JSON.parse(_internal.shapeChatBody(encoded, undefined, index));
  assert.deepEqual(bare.thinking, { type: "enabled" });
  assert.equal(bare.reasoning_effort, "max");
  assert.deepEqual(bare.reasoning, { keep: 1 });

  // 7. Invalid effort string is stripped
  const invalid = JSON.parse(
    _internal.shapeChatBody(
      JSON.stringify({ model: "m-with-off", reasoning_effort: "super-duper", messages: [] }),
      undefined,
      index,
    ),
  );
  assert.equal("reasoning_effort" in invalid, false);
  assert.equal("thinking" in invalid, false);
});

test("takeCallback rejects malformed queries including empty ?error= without crashing", () => {
  const state = "secret-state-value";
  assert.deepEqual(
    _internal.takeCallback({ method: "GET", url: `/callback?state=${state}&code=abc123` }, state),
    { kind: "code", code: "abc123" },
  );
  assert.deepEqual(
    _internal.takeCallback({ method: "GET", url: `/callback?state=${state}&error=access_denied` }, state),
    { kind: "cancel" },
  );
  assert.deepEqual(
    _internal.takeCallback({ method: "GET", url: `/callback?state=${state}&error=server_error` }, state),
    { kind: "fail" },
  );
  // Regression test: empty ?error= previously produced { code: "" } -> writeHead(undefined) crash!
  assert.deepEqual(
    _internal.takeCallback({ method: "GET", url: `/callback?state=${state}&error=` }, state),
    { kind: "reject", status: 400 },
  );
  assert.deepEqual(
    _internal.takeCallback({ method: "GET", url: `/callback?state=wrong&code=abc123` }, state),
    { kind: "reject", status: 400 },
  );
  assert.deepEqual(
    _internal.takeCallback({ method: "GET", url: `/favicon.ico` }, state),
    { kind: "reject", status: 404 },
  );
  assert.deepEqual(
    _internal.takeCallback({ method: "POST", url: `/callback?state=${state}&code=abc123` }, state),
    { kind: "reject", status: 400 },
  );
});

test("startBrowserLogin completes full PKCE flow, handles invalid hits, and closes cleanly", async () => {
  const realFetch = globalThis.fetch;
  let tokenParams;
  await withMockFetch(async (url, init) => {
    const href = String(url);
    if (href.startsWith("http://127.0.0.1:")) return realFetch(url, init);
    if (href === _internal.TOKEN_URL) {
      tokenParams = Object.fromEntries(new URLSearchParams(init.body));
      return jsonResponse({
        access_token: "acc_new_1",
        refresh_token: "ref_new_1",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }
    throw new Error(`Unexpected fetch: ${href}`);
  }, async () => {
    const flow = await _internal.startBrowserLogin(undefined, { installationId: UUID_A, timeoutMs: 10_000 });
    const authUrl = new URL(flow.url);
    assert.equal(authUrl.origin, _internal.ORIGIN);
    assert.equal(authUrl.pathname, "/oauth/authorize");
    assert.equal(authUrl.searchParams.get("installation_id"), UUID_A);
    assert.equal(authUrl.searchParams.get("code_challenge_method"), "S256");
    const state = authUrl.searchParams.get("state");
    const base = new URL(flow.redirectUri);

    // Hit /favicon.ico -> 404
    const fav = await realFetch(`${base.origin}/favicon.ico`);
    assert.equal(fav.status, 404);
    await fav.text();

    // Hit empty ?error= -> 400 (no crash!)
    const emptyErr = await realFetch(`${flow.redirectUri}?state=${encodeURIComponent(state)}&error=`);
    assert.equal(emptyErr.status, 400);
    await emptyErr.text();

    // Start awaiting result, then deliver real callback
    const resultPromise = flow.result();
    const cbRes = await realFetch(`${flow.redirectUri}?state=${encodeURIComponent(state)}&code=auth_code_xyz`);
    assert.equal(cbRes.status, 200);
    assert.equal(cbRes.headers.get("connection"), "close");
    const html = await cbRes.text();
    assert.match(html, /已登录/);

    const tokens = await resultPromise;
    assert.equal(tokens.access, "acc_new_1");
    assert.equal(tokens.refresh, "ref_new_1");
    assert.equal(tokenParams.code, "auth_code_xyz");
    assert.equal(tokenParams.installation_id, UUID_A);
    assert.equal(tokenParams.grant_type, "authorization_code");
    assert.ok(tokenParams.code_verifier);
  });
});

test("startBrowserLogin handles access_denied cleanly", async () => {
  const realFetch = globalThis.fetch;
  const flow = await _internal.startBrowserLogin(undefined, { installationId: UUID_A, timeoutMs: 10_000 });
  const state = new URL(flow.url).searchParams.get("state");
  const rejection = assert.rejects(flow.result(), (err) => err.cancelled === true);
  const cbRes = await realFetch(`${flow.redirectUri}?state=${encodeURIComponent(state)}&error=access_denied`);
  assert.equal(cbRes.status, 400);
  const html = await cbRes.text();
  assert.match(html, /已取消登录/);
  await rejection;
});

test("oauth authorize/callback end-to-end returns accountId and uid", async () => {
  const realFetch = globalThis.fetch;
  await withMockFetch(async (url, init) => {
    const href = String(url);
    if (href.startsWith("http://127.0.0.1:")) return realFetch(url, init);
    if (href === _internal.TOKEN_URL) {
      return jsonResponse({
        access_token: "acc_oauth_e2e",
        refresh_token: "ref_oauth_e2e",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }
    if (href === _internal.ME_URL) {
      return jsonResponse({ data: { id: UUID_B, email: "user@example.com", name: "User" } });
    }
    throw new Error(`Unexpected fetch: ${href}`);
  }, async () => {
    const hooks = await plugin.server({});
    const started = await hooks.auth.methods[0].authorize();
    assert.equal(started.method, "auto");
    const authUrl = new URL(started.url);
    const redirectUri = authUrl.searchParams.get("redirect_uri");
    const state = authUrl.searchParams.get("state");

    const callbackPromise = started.callback();
    const cbRes = await realFetch(`${redirectUri}?state=${encodeURIComponent(state)}&code=e2e_code`);
    assert.equal(cbRes.status, 200);
    await cbRes.text();

    const result = await callbackPromise;
    assert.equal(result.type, "success");
    assert.equal(result.access, "acc_oauth_e2e");
    assert.equal(result.refresh, "ref_oauth_e2e");
    assert.equal(result.accountId, "user@example.com");
    assert.equal(result.uid, UUID_B);
    assert.ok(result.installationId);
  });
});

test("chatWithRefresh proactively refreshes expiring OAuth tokens and recovers from cross-process rotation", async () => {
  // 1. Proactive refresh before sending
  let stored = {
    type: "oauth",
    access: "expiring_access",
    refresh: "ref_proactive_1",
    expires: Date.now() + 10_000, // within 60s REFRESH_LEAD_MS
    installationId: UUID_A,
  };
  const client = {
    auth: {
      async set({ body }) {
        stored = { ...body };
      },
    },
  };
  const seenAuthHeaders = [];
  await withMockFetch(async (url, init) => {
    const href = String(url);
    if (href === _internal.TOKEN_URL) {
      return jsonResponse({
        access_token: "proactive_fresh_access",
        refresh_token: "ref_proactive_2",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }
    if (href === _internal.CHAT_URL) {
      seenAuthHeaders.push(new Headers(init.headers).get("authorization"));
      return jsonResponse({ ok: true }, 200);
    }
    throw new Error(`Unexpected fetch: ${href}`);
  }, async () => {
    const out = await _internal.chatWithRefresh(
      stored,
      _internal.CHAT_URL,
      { method: "POST", body: JSON.stringify({ model: "m", messages: [] }) },
      client,
      { getAuth: async () => ({ ...stored }) },
    );
    assert.equal(out.response.status, 200);
    assert.equal(out.response.headers.get("x-magpie-sign-in"), "renewed");
    assert.deepEqual(seenAuthHeaders, ["Bearer proactive_fresh_access"]);
    assert.equal(stored.refresh, "ref_proactive_2");
  });

  // 2. Cross-process race: /oauth/token returns invalid_grant because another process just rotated and saved
  let diskAuth = {
    type: "oauth",
    access: "old_access_xproc",
    refresh: "ref_xproc_1",
    expires: Date.now() + 300_000,
    installationId: UUID_A,
  };
  await withMockFetch(async (url, init) => {
    const href = String(url);
    if (href === _internal.CHAT_URL) {
      const h = new Headers(init.headers).get("authorization");
      if (h === "Bearer old_access_xproc") return jsonResponse({ error: "stale" }, 401);
      assert.equal(h, "Bearer other_proc_access");
      return jsonResponse({ ok: true }, 200);
    }
    if (href === _internal.TOKEN_URL) {
      // Simulate another Magpie process saving the rotated token while our refresh was in flight
      diskAuth = {
        ...diskAuth,
        access: "other_proc_access",
        refresh: "ref_xproc_2",
        expires: Date.now() + 3600_000,
      };
      return jsonResponse({ error: "invalid_grant" }, 400);
    }
    throw new Error(`Unexpected fetch: ${href}`);
  }, async () => {
    const out = await _internal.chatWithRefresh(
      { ...diskAuth },
      _internal.CHAT_URL,
      { method: "POST", body: JSON.stringify({ model: "m", messages: [] }) },
      client,
      { getAuth: async () => ({ ...diskAuth }) },
    );
    assert.equal(out.response.status, 200);
    assert.equal(out.auth.access, "other_proc_access");
  });
});

test("aborting a caller waiting on refresh rejects caller promptly without losing rotated token", async () => {
  let stored = {
    type: "oauth",
    access: "old_abort_access",
    refresh: "ref_abort_1",
    expires: Date.now() + 300_000,
    installationId: UUID_A,
  };
  let savedPromiseResolve;
  const savedPromise = new Promise((r) => {
    savedPromiseResolve = r;
  });
  const client = {
    auth: {
      async set({ body }) {
        stored = { ...body };
        savedPromiseResolve();
      },
    },
  };
  const ctl = new AbortController();

  await withMockFetch(async (url) => {
    const href = String(url);
    if (href === _internal.CHAT_URL) return jsonResponse({ error: "expired" }, 401);
    if (href === _internal.TOKEN_URL) {
      await new Promise((r) => setTimeout(r, 60));
      return jsonResponse({
        access_token: "saved_after_abort",
        refresh_token: "ref_abort_2",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }
    throw new Error(`Unexpected fetch: ${href}`);
  }, async () => {
    setTimeout(() => ctl.abort(), 15);
    await assert.rejects(
      () =>
        _internal.chatWithRefresh(
          { ...stored },
          _internal.CHAT_URL,
          { method: "POST", body: JSON.stringify({ model: "m", messages: [] }), signal: ctl.signal },
          client,
          { getAuth: async () => ({ ...stored }) },
        ),
      (err) => err.name === "AbortError",
    );
    // Background refresh must still finish and persist the rotated token!
    await savedPromise;
    assert.equal(stored.access, "saved_after_abort");
    assert.equal(stored.refresh, "ref_abort_2");
  });
});

test("auth.usage refreshes OAuth on 401 and formats trial token windows and past_due plans", async () => {
  let stored = {
    type: "oauth",
    access: "stale_usage_tok",
    refresh: "ref_usage_1",
    expires: Date.now() + 300_000,
    installationId: UUID_A,
  };
  const client = {
    auth: {
      async set({ body }) {
        stored = { ...body };
      },
    },
  };

  await withMockFetch(async (url, init) => {
    const href = String(url);
    if (href === _internal.TOKEN_URL) {
      return jsonResponse({
        access_token: "fresh_usage_tok",
        refresh_token: "ref_usage_2",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }
    const authHeader = new Headers(init.headers).get("authorization");
    if (authHeader !== "Bearer fresh_usage_tok") return jsonResponse({ error: "unauthorized" }, 401);
    if (href === _internal.ME_URL) return jsonResponse({ data: { id: UUID_B, email: "trial@example.com" } });
    if (href === _internal.SUBSCRIPTIONS_URL) {
      return jsonResponse({
        data: [
          {
            id: "sub_past",
            groupId: UUID_A,
            group: { name: "Pro" },
            status: "past_due",
            currentPeriodEnd: "2026-11-30T00:00:00Z",
            cancelAtPeriodEnd: true,
          },
        ],
      });
    }
    if (href === _internal.STAMINA_URL) return new Response("", { status: 404 });
    if (href === _internal.TRIAL_STATUS_URL) {
      return jsonResponse({
        data: {
          asOf: "2026-11-26T00:00:00Z",
          paidGroupIds: [],
          trials: [
            {
              id: "tr_1",
              groupId: UUID_A,
              source: "free_tokens",
              state: "ending",
              endsAt: "2026-12-05T00:00:00Z",
              tokensRemaining: 250_000,
              tokenLimit: 1_000_000,
            },
          ],
        },
      });
    }
    throw new Error(`Unexpected fetch: ${href}`);
  }, async () => {
    const hooks = await plugin.server({ client });
    const usage = await hooks.auth.usage(async () => ({ ...stored }), {});
    assert.equal(usage.signIn, "renewed");
    assert.equal(usage.user, "trial@example.com");
    assert.equal(usage.plan, "Pro (逾期)");
    assert.equal(usage.windows.length, 1);
    assert.equal(usage.windows[0].name, "Free Tokens");
    assert.equal(usage.windows[0].used, 75);
    assert.equal(usage.windows[0].amount, 750_000);
    assert.equal(usage.windows[0].limit, 1_000_000);
    assert.equal(usage.windows[0].unit, "tokens");
    assert.equal(usage.windows[0].aside, undefined);
  });
});

test("module exports are compatible with Magpie plugin loader servers(mod)", async () => {
  const mod = await import("../index.mjs");
  const d = mod.default;
  assert.ok(d && typeof d === "object" && "server" in d);
  assert.equal(typeof d.server, "function");
  // Even if scanned by legacy fallback, _internal must not be a function or carry .server
  assert.equal(typeof mod._internal, "object");
  assert.equal(mod._internal.server, undefined);
});

test("chatWithRefresh deduplicates concurrent 401s and avoids re-spending rotated refresh token", async () => {
  let stored = {
    type: "oauth",
    access: "old_access",
    refresh: "rot_refresh_1",
    expires: Date.now() + 300_000,
    installationId: UUID_A,
  };
  let tokenCalls = 0;
  let chatCalls = 0;
  let setCalls = 0;
  const client = {
    auth: {
      async set({ body }) {
        setCalls++;
        stored = { ...body };
      },
    },
  };

  await withMockFetch(async (url, init) => {
    const href = String(url);
    if (href === _internal.TOKEN_URL) {
      tokenCalls++;
      const params = new URLSearchParams(init.body);
      assert.equal(params.get("refresh_token"), "rot_refresh_1");
      await new Promise((r) => setTimeout(r, 30));
      return jsonResponse({
        access_token: "fresh_access_2",
        refresh_token: "rot_refresh_2",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }
    if (href === _internal.CHAT_URL) {
      chatCalls++;
      const authHeader = new Headers(init.headers).get("authorization");
      if (authHeader === "Bearer old_access") {
        return jsonResponse({ error: "expired" }, 401);
      }
      assert.equal(authHeader, "Bearer fresh_access_2");
      return jsonResponse({ id: "cmpl_1", choices: [] }, 200);
    }
    throw new Error(`Unexpected URL: ${href}`);
  }, async () => {
    const hooks = await plugin.server({ client });
    const loader = await hooks.auth.loader(async () => ({ ...stored }), { models: {} });

    // Launch two concurrent requests with old_access -> both get 401
    const [r1, r2] = await Promise.all([
      loader.fetch(_internal.CHAT_URL, { method: "POST", body: JSON.stringify({ model: "m", messages: [] }) }),
      loader.fetch(_internal.CHAT_URL, { method: "POST", body: JSON.stringify({ model: "m", messages: [] }) }),
    ]);
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.equal(r1.headers.get("x-magpie-sign-in"), "renewed");
    assert.equal(tokenCalls, 1, "rotating refresh token must only be exchanged once");
    assert.equal(setCalls, 1, "refreshed grant must be stored once");
    assert.equal(chatCalls, 4);
    assert.equal(stored.access, "fresh_access_2");
    assert.equal(stored.refresh, "rot_refresh_2");

    // Simulate a late 3rd request from a stale closure after rotation already happened:
    // re-reading getAuth() before refresh prevents re-sending rot_refresh_1!
    const staleAuth = {
      type: "oauth",
      access: "old_access",
      refresh: "rot_refresh_1",
      expires: Date.now() + 300_000,
      installationId: UUID_A,
    };
    const r3 = await _internal.chatWithRefresh(
      staleAuth,
      _internal.CHAT_URL,
      { method: "POST", body: JSON.stringify({ model: "m", messages: [] }) },
      client,
      { getAuth: async () => ({ ...stored }) },
    );
    assert.equal(r3.response.status, 200);
    assert.equal(tokenCalls, 1, "must reuse already-rotated token from getAuth()");
  });
});

test("chatWithRefresh supports Request objects, lowercase method, and rejects disallowed URLs", async () => {
  const oauthAuth = {
    type: "oauth",
    access: "tok_req_test",
    refresh: "ref_req_test",
    expires: Date.now() + 300_000,
    installationId: UUID_A,
  };
  await withMockFetch(async (url, init) => {
    assert.equal(String(url), _internal.CHAT_URL);
    assert.equal(init.method, "POST");
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer tok_req_test");
    assert.equal(new Headers(init.headers).get("user-agent"), _internal.USER_AGENT);
    const parsed = JSON.parse(init.body);
    assert.equal(parsed.reasoning_effort, "high");
    return jsonResponse({ ok: true }, 200);
  }, async () => {
    const req = new Request(_internal.CHAT_URL, {
      method: "post",
      headers: { "x-magpie-effort": "high" },
      body: JSON.stringify({ model: "m", messages: [] }),
    });
    const out = await _internal.chatWithRefresh(oauthAuth, req, undefined, undefined);
    assert.equal(out.response.status, 200);
  });

  await assert.rejects(
    () => _internal.chatWithRefresh(oauthAuth, "https://evil.example/chat/completions", { method: "POST" }),
    /仅支持模型列表和 Chat Completions/,
  );
});

test("provider.models retries transient 503 and refreshes OAuth token on 401 before failing", async () => {
  let stored = {
    type: "oauth",
    access: "stale_access",
    refresh: "ref_models_1",
    expires: Date.now() + 300_000,
    installationId: UUID_A,
  };
  let modelAttempts = 0;
  let tokenAttempts = 0;
  const client = {
    auth: {
      async set({ body }) {
        stored = { ...body };
      },
    },
  };

  await withMockFetch(async (url, init) => {
    const href = String(url);
    if (href === _internal.MODELS_URL) {
      modelAttempts++;
      const authHeader = new Headers(init.headers).get("authorization");
      if (modelAttempts === 1) return jsonResponse({ error: "gateway error" }, 503, { "retry-after": "0" });
      if (authHeader === "Bearer stale_access") return jsonResponse({ error: "unauthorized" }, 401);
      return jsonResponse({
        data: [{ id: "pro/deepseek", display_name: "DeepSeek", context_window: 128000, vision: false }],
      });
    }
    if (href === _internal.TOKEN_URL) {
      tokenAttempts++;
      return jsonResponse({
        access_token: "fresh_models_access",
        refresh_token: "ref_models_2",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }
    throw new Error(`Unexpected fetch: ${href}`);
  }, async () => {
    const hooks = await plugin.server({ client });
    const models = await hooks.provider.models({ models: {} }, { auth: { ...stored } });
    assert.ok(models["pro/deepseek"]);
    assert.equal(tokenAttempts, 1);
    assert.equal(modelAttempts, 3);
    assert.equal(stored.access, "fresh_models_access");
  });
});

test("exchangeToken marks both HTTP 401 and 400 invalid_grant as signIn expired", async () => {
  await withMockFetch(async () => jsonResponse({ error: "unauthorized" }, 401), async () => {
    await assert.rejects(
      () => _internal.exchangeToken({ grant_type: "refresh_token", refresh_token: "x" }),
      (err) => err.signIn === "expired",
    );
  });

  await withMockFetch(async () => jsonResponse({ error: "invalid_grant" }, 400), async () => {
    await assert.rejects(
      () => _internal.exchangeToken({ grant_type: "refresh_token", refresh_token: "x" }),
      (err) => err.signIn === "expired",
    );
  });

  await withMockFetch(async () => jsonResponse({ error: "temporarily_unavailable" }, 503), async () => {
    await assert.rejects(
      () => _internal.exchangeToken({ grant_type: "refresh_token", refresh_token: "x" }),
      (err) => err.signIn === undefined,
    );
  });
});

test("auth.usage summarizes OAuth subscriptions, stamina (aside: true), and trials with 404 resilience", async () => {
  const oauthAuth = {
    type: "oauth",
    access: "valid_access",
    refresh: "ref_usage",
    expires: Date.now() + 300_000,
    installationId: UUID_A,
  };

  await withMockFetch(async (url) => {
    const href = String(url);
    if (href === _internal.ME_URL) {
      return jsonResponse({ data: { id: UUID_B, name: "Ada", email: "ada@example.com" } });
    }
    if (href === _internal.SUBSCRIPTIONS_URL) {
      return jsonResponse({
        data: [
          {
            id: "sub_1",
            groupId: UUID_A,
            group: { name: "Max", slug: "max" },
            status: "active",
            currentPeriodEnd: "2026-12-01T00:00:00Z",
            cancelAtPeriodEnd: false,
          },
        ],
      });
    }
    if (href === _internal.STAMINA_URL) {
      return jsonResponse({
        data: [
          {
            groupId: UUID_A,
            groupName: "Max",
            remainingPercent: 72.5,
            nextOutputTps: 120,
            recovering: true,
            fullAt: "2026-11-26T06:00:00Z",
            accountingPending: false,
            asOf: "2026-11-26T05:00:00Z",
          },
        ],
      });
    }
    if (href === _internal.TRIAL_STATUS_URL) {
      return new Response("", { status: 404 });
    }
    throw new Error(`Unexpected URL: ${href}`);
  }, async () => {
    const hooks = await plugin.server({});
    const usage = await hooks.auth.usage(async () => ({ ...oauthAuth }), {});
    assert.equal(usage.user, "ada@example.com");
    assert.equal(usage.plan, "Max");
    assert.equal(usage.until, "2026-12-01T00:00:00Z");
    assert.equal(usage.renew, "auto");
    assert.equal(usage.signIn, undefined);
    assert.equal(usage.windows.length, 1);
    assert.equal(usage.windows[0].name, "Stamina");
    assert.equal(usage.windows[0].used, 27.5);
    assert.equal(usage.windows[0].aside, true);
    assert.equal(usage.windows[0].resetsAt, "2026-11-26T06:00:00Z");
    assert.match(usage.windows[0].display, /73% 剩余 · 120 tok\/s · 恢复中/);
  });
});

test("non-OAuth credentials are rejected cleanly across usage, models, and chat", async () => {
  const unsupported = { type: "api", key: "legacy_key" };
  let fetchCalled = false;
  await withMockFetch(async () => {
    fetchCalled = true;
    return jsonResponse({ data: [] }, 200);
  }, async () => {
    const hooks = await plugin.server({});

    const usage = await hooks.auth.usage(async () => ({ ...unsupported }), {});
    assert.equal(usage.signIn, "expired");
    assert.deepEqual(usage.windows, []);

    await assert.rejects(
      () => hooks.provider.models({ models: {} }, { auth: { ...unsupported } }),
      (err) => err.signIn === "expired",
    );

    const out = await _internal.chatWithRefresh(
      { ...unsupported },
      _internal.CHAT_URL,
      { method: "POST", body: JSON.stringify({ model: "m", messages: [] }) },
    );
    assert.equal(out.response.status, 401);
    assert.equal(out.response.headers.get("x-magpie-sign-in"), "expired");
    assert.equal(fetchCalled, false, "non-OAuth credentials must never send network requests");
  });
});

test("installationIdOf creates, persists, normalizes, and repairs installation-id files", () => {
  const dir = mkdtempSync(join(tmpdir(), "magpie-verboo-test-"));
  try {
    const file = join(dir, "nested", "installation-id");
    const first = _internal.installationIdOf(file);
    assert.match(first, /^[0-9a-f-]{36}$/);
    assert.equal(readFileSync(file, "utf8").trim(), first);

    const second = _internal.installationIdOf(file);
    assert.equal(second, first);

    // Overwrite with uppercase UUID -> should normalize lowercase
    writeFileSync(file, `${UUID_A.toUpperCase()}\n`, "utf8");
    assert.equal(_internal.installationIdOf(file), UUID_A);

    // Corrupt file -> should regenerate valid UUID
    writeFileSync(file, "not-a-uuid\n", "utf8");
    const repaired = _internal.installationIdOf(file);
    assert.match(repaired, /^[0-9a-f-]{36}$/);
    assert.notEqual(repaired, "not-a-uuid");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("multi-account loaders keep model reasoning metadata strictly isolated per account", async () => {
  const hooks = await plugin.server({});
  const accountAModels = _internal.modelCatalog([
    { id: "shared-model", reasoning: { effort_levels: ["low", "high"] } },
  ]);
  const accountBModels = _internal.modelCatalog([
    { id: "shared-model", reasoning: false },
  ]);
  const authA = {
    type: "oauth",
    access: "tok_iso_A",
    refresh: "ref_iso_A",
    expires: Date.now() + 300_000,
    installationId: UUID_A,
    uid: UUID_A,
  };
  const authB = {
    type: "oauth",
    access: "tok_iso_B",
    refresh: "ref_iso_B",
    expires: Date.now() + 300_000,
    installationId: UUID_A,
    uid: UUID_B,
  };

  const seenBodies = [];
  await withMockFetch(async (_url, init) => {
    seenBodies.push(JSON.parse(init.body));
    return jsonResponse({ ok: true }, 200);
  }, async () => {
    const loaderA = await hooks.auth.loader(async () => ({ ...authA }), { models: accountAModels });
    const loaderB = await hooks.auth.loader(async () => ({ ...authB }), { models: accountBModels });

    await loaderA.fetch(_internal.CHAT_URL, {
      method: "POST",
      headers: { "x-magpie-effort": "high" },
      body: JSON.stringify({ model: "shared-model", messages: [] }),
    });
    await loaderB.fetch(_internal.CHAT_URL, {
      method: "POST",
      headers: { "x-magpie-effort": "high" },
      body: JSON.stringify({ model: "shared-model", messages: [] }),
    });

    assert.equal(seenBodies[0].reasoning_effort, "high");
    assert.deepEqual(seenBodies[0].thinking, { type: "enabled" });
    assert.equal("reasoning_effort" in seenBodies[1], false);
    assert.equal("thinking" in seenBodies[1], false);
  });
});

test("auth.refresh recovers from cross-process and same-process rotating token races without false expiry", async () => {
  let currentAccount = "verboo";
  let diskAuth = {
    type: "oauth",
    access: "acc_v1",
    refresh: "ref_v1",
    expires: Date.now() + 30_000,
    installationId: UUID_A,
    uid: UUID_B,
  };
  let tokenCalls = 0;

  // Case 1: Cross-process rotation ALREADY landed on disk before auth.refresh runs
  await withMockFetch(async (url) => {
    if (String(url) === _internal.TOKEN_URL) {
      tokenCalls++;
      return jsonResponse({ error: "invalid_grant" }, 400);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }, async () => {
    const hooks = await plugin.server({ magpie: { account: () => currentAccount } });
    // Register live getAuth reader as Magpie does when loader/usage runs
    await hooks.auth.loader(async () => ({ ...diskAuth }), { models: {} });

    const staleSnapshot = { ...diskAuth };
    // Another process rotated on disk
    diskAuth = {
      ...diskAuth,
      access: "acc_v2_disk",
      refresh: "ref_v2_disk",
      expires: Date.now() + 3600_000,
    };

    const renewed = await hooks.auth.refresh(staleSnapshot);
    assert.equal(tokenCalls, 0, "must not re-spend ref_v1 when disk already has ref_v2");
    assert.equal(renewed.access, "acc_v2_disk");
    assert.equal(renewed.refresh, "ref_v2_disk");
  });

  // Case 2: Cross-process rotation happens mid-flight during auth.refresh -> invalid_grant recovered via disk re-read
  diskAuth = {
    type: "oauth",
    access: "acc_mid_1",
    refresh: "ref_mid_1",
    expires: Date.now() + 30_000,
    installationId: UUID_A,
    uid: UUID_B,
  };
  tokenCalls = 0;
  await withMockFetch(async (url) => {
    if (String(url) === _internal.TOKEN_URL) {
      tokenCalls++;
      diskAuth = {
        ...diskAuth,
        access: "acc_mid_2",
        refresh: "ref_mid_2",
        expires: Date.now() + 3600_000,
      };
      return jsonResponse({ error: "invalid_grant" }, 400);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }, async () => {
    const hooks = await plugin.server({ magpie: { account: () => currentAccount } });
    await hooks.auth.loader(async () => ({ ...diskAuth }), { models: {} });

    const renewed = await hooks.auth.refresh({ ...diskAuth });
    assert.equal(tokenCalls, 1);
    assert.equal(renewed.access, "acc_mid_2");
    assert.equal(renewed.refresh, "ref_mid_2");
  });

  // Case 3: Same-process rotation (even WITHOUT loader/getAuth registered!) is reused by auth.refresh
  tokenCalls = 0;
  await withMockFetch(async (url) => {
    if (String(url) === _internal.TOKEN_URL) {
      tokenCalls++;
      return jsonResponse({
        access_token: "acc_same_2",
        refresh_token: "ref_same_2",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }, async () => {
    const hooks = await plugin.server({});
    const stale = {
      type: "oauth",
      access: "acc_same_1",
      refresh: "ref_same_1",
      expires: Date.now() + 30_000,
      installationId: UUID_A,
    };
    const first = await hooks.auth.refresh({ ...stale });
    const second = await hooks.auth.refresh({ ...stale });
    assert.equal(tokenCalls, 1, "recentlyRotated cache must serve stale ref_same_1 without hitting /oauth/token again");
    assert.equal(first.access, "acc_same_2");
    assert.equal(second.access, "acc_same_2");
    assert.equal(second.refresh, "ref_same_2");
  });

  // Case 4: Genuinely revoked refresh token (unchanged on disk) still throws signIn: "expired"
  diskAuth = {
    type: "oauth",
    access: "acc_dead",
    refresh: "ref_dead",
    expires: Date.now() + 30_000,
    installationId: UUID_A,
    uid: UUID_B,
  };
  await withMockFetch(async () => jsonResponse({ error: "invalid_grant" }, 400), async () => {
    const hooks = await plugin.server({ magpie: { account: () => currentAccount } });
    await hooks.auth.loader(async () => ({ ...diskAuth }), { models: {} });
    await assert.rejects(() => hooks.auth.refresh({ ...diskAuth }), (err) => err.signIn === "expired");
  });
});

test("provider.models recovers from cross-process and same-process token rotation on 401", async () => {
  let currentAccount = "verboo";
  let diskAuth = {
    type: "oauth",
    access: "models_old_1",
    refresh: "models_ref_1",
    expires: Date.now() + 300_000,
    installationId: UUID_A,
    uid: UUID_B,
  };
  let tokenCalls = 0;

  await withMockFetch(async (url, init) => {
    const href = String(url);
    if (href === _internal.MODELS_URL) {
      const h = new Headers(init.headers).get("authorization");
      if (h === "Bearer models_old_1") {
        // Simulate another process rotating while GET /models was in flight
        diskAuth = {
          ...diskAuth,
          access: "models_new_2",
          refresh: "models_ref_2",
          expires: Date.now() + 3600_000,
        };
        return jsonResponse({ error: "unauthorized" }, 401);
      }
      assert.equal(h, "Bearer models_new_2");
      return jsonResponse({ data: [{ id: "m-recovered", display_name: "Recovered" }] });
    }
    if (href === _internal.TOKEN_URL) {
      tokenCalls++;
      return jsonResponse({ error: "invalid_grant" }, 400);
    }
    throw new Error(`Unexpected fetch: ${href}`);
  }, async () => {
    const hooks = await plugin.server({ magpie: { account: () => currentAccount } });
    await hooks.auth.loader(async () => ({ ...diskAuth }), { models: {} });

    const models = await hooks.provider.models({ models: {} }, { auth: { ...diskAuth } });
    assert.ok(models["m-recovered"]);
    assert.equal(tokenCalls, 0, "provider.models 401 must reuse rotated token from getAuth() without re-spending models_ref_1");
  });
});

test("existing loader picks up refreshed model reasoning metadata dynamically while preserving multi-account isolation", async () => {
  let activeAccount = "verboo";
  const hooks = await plugin.server({
    magpie: {
      account: () => activeAccount,
    },
  });

  const authA = {
    type: "oauth",
    access: "tok_dyn_A",
    refresh: "ref_dyn_A",
    expires: Date.now() + 300_000,
    installationId: UUID_A,
    uid: UUID_A,
  };
  const authB = {
    type: "oauth",
    access: "tok_dyn_B",
    refresh: "ref_dyn_B",
    expires: Date.now() + 300_000,
    installationId: UUID_A,
    uid: UUID_B,
  };

  // Create BOTH loaders BEFORE models are loaded (simulates cold start / stale initial catalog)
  activeAccount = "verboo";
  const loaderA = await hooks.auth.loader(async () => ({ ...authA }), { models: {} });

  activeAccount = "verboo#second";
  const loaderB = await hooks.auth.loader(async () => ({ ...authB }), {
    models: _internal.modelCatalog([
      { id: "model-x", reasoning: { effort_levels: ["low", "high"] } },
    ]),
  });

  const seenBodies = [];
  await withMockFetch(async (url, init) => {
    const href = String(url);
    if (href === _internal.MODELS_URL) {
      const h = new Headers(init.headers).get("authorization");
      if (h === "Bearer tok_dyn_A") {
        return jsonResponse({
          data: [
            { id: "model-x", reasoning: { effort_levels: ["off", "low", "medium"] } },
            { id: "model-plain", reasoning: false },
          ],
        });
      }
      throw new Error(`Unexpected models auth: ${h}`);
    }
    if (href === _internal.CHAT_URL) {
      seenBodies.push(JSON.parse(init.body));
      return jsonResponse({ ok: true }, 200);
    }
    throw new Error(`Unexpected fetch: ${href}`);
  }, async () => {
    // Refresh models ONLY for Account A (Magpie does NOT recreate loaderA!)
    activeAccount = "verboo";
    await hooks.provider.models({ models: {} }, { auth: authA });

    // 1. Account A's EXISTING loader omits thinking & reasoning_effort on explicit off
    await loaderA.fetch(_internal.CHAT_URL, {
      method: "POST",
      headers: { "x-magpie-effort": "off" },
      body: JSON.stringify({ model: "model-x", thinking: { type: "enabled" }, messages: [] }),
    });
    // 2. Account A's EXISTING loader now clamps max -> medium on model-x
    await loaderA.fetch(_internal.CHAT_URL, {
      method: "POST",
      headers: { "x-magpie-effort": "max" },
      body: JSON.stringify({ model: "model-x", messages: [] }),
    });
    // 3. Account A's EXISTING loader now knows model-plain is non-reasoning -> strips thinking/effort
    await loaderA.fetch(_internal.CHAT_URL, {
      method: "POST",
      headers: { "x-magpie-effort": "high" },
      body: JSON.stringify({
        model: "model-plain",
        reasoning_effort: "high",
        thinking: { type: "enabled" },
        messages: [],
      }),
    });

    // 4. Account B's EXISTING loader remains isolated (its model-x still offers [low, high], NOT [off, low, medium]!)
    activeAccount = "verboo#second";
    await loaderB.fetch(_internal.CHAT_URL, {
      method: "POST",
      headers: { "x-magpie-effort": "max" },
      body: JSON.stringify({ model: "model-x", messages: [] }),
    });
    await loaderB.fetch(_internal.CHAT_URL, {
      method: "POST",
      headers: { "x-magpie-effort": "off" },
      body: JSON.stringify({ model: "model-x", messages: [] }),
    });

    assert.equal("thinking" in seenBodies[0], false);
    assert.equal("reasoning_effort" in seenBodies[0], false);

    assert.deepEqual(seenBodies[1].thinking, { type: "enabled" });
    assert.equal(seenBodies[1].reasoning_effort, "medium");

    assert.equal("thinking" in seenBodies[2], false);
    assert.equal("reasoning_effort" in seenBodies[2], false);

    assert.deepEqual(seenBodies[3].thinking, { type: "enabled" });
    assert.equal(seenBodies[3].reasoning_effort, "high");

    assert.equal("thinking" in seenBodies[4], false);
    assert.equal("reasoning_effort" in seenBodies[4], false);
  });
});

test("multi-account isolation holds even when magpie.account() always returns bare provider id 'verboo'", async () => {
  // Simulate calling outside a scoped request where magpie.account("verboo") falls back to "verboo" for ALL accounts
  const unscopedMagpie = { account: () => "verboo" };
  const hooks = await plugin.server({ magpie: unscopedMagpie });

  const oauthA = {
    type: "oauth",
    access: "tok_A",
    refresh: "ref_A",
    expires: Date.now() + 300_000,
    installationId: UUID_A,
    uid: UUID_A,
    accountId: "a@example.com",
  };
  const oauthB = {
    type: "oauth",
    access: "tok_B",
    refresh: "ref_B",
    expires: Date.now() + 300_000,
    installationId: UUID_A,
    uid: UUID_B,
    accountId: "b@example.com",
  };

  let authAState = { ...oauthA };
  let authBState = { ...oauthB };
  const loaderA = await hooks.auth.loader(async () => ({ ...authAState }), { models: {} });
  const loaderB = await hooks.auth.loader(async () => ({ ...authBState }), { models: {} });

  const seenBodies = [];
  let tokenCalls = 0;
  await withMockFetch(async (url, init) => {
    const href = String(url);
    if (href === _internal.MODELS_URL) {
      const h = new Headers(init.headers).get("authorization");
      if (h === "Bearer tok_A") {
        return jsonResponse({
          data: [{ id: "shared-m", reasoning: { effort_levels: ["off", "low"] } }],
        });
      }
      if (h === "Bearer tok_B") {
        return jsonResponse({
          data: [{ id: "shared-m", reasoning: false }],
        });
      }
    }
    if (href === _internal.CHAT_URL) {
      seenBodies.push(JSON.parse(init.body));
      return jsonResponse({ ok: true }, 200);
    }
    if (href === _internal.TOKEN_URL) {
      tokenCalls++;
      return jsonResponse({ error: "invalid_grant" }, 400);
    }
    throw new Error(`Unexpected fetch: ${href}`);
  }, async () => {
    // Refresh models for BOTH accounts while magpie.account() returns bare "verboo"
    await hooks.provider.models({ models: {} }, { auth: { ...authAState } });
    await hooks.provider.models({ models: {} }, { auth: { ...authBState } });

    // Loaders must keep each account's model index separate (not overwritten onto acct:verboo!)
    await loaderA.fetch(_internal.CHAT_URL, {
      method: "POST",
      headers: { "x-magpie-effort": "high" },
      body: JSON.stringify({ model: "shared-m", messages: [] }),
    });
    await loaderB.fetch(_internal.CHAT_URL, {
      method: "POST",
      headers: { "x-magpie-effort": "high" },
      body: JSON.stringify({ model: "shared-m", reasoning_effort: "high", thinking: { type: "enabled" }, messages: [] }),
    });

    assert.deepEqual(seenBodies[0].thinking, { type: "enabled" });
    assert.equal(seenBodies[0].reasoning_effort, "low");
    assert.equal("thinking" in seenBodies[1], false);
    assert.equal("reasoning_effort" in seenBodies[1], false);

    // Also verify getAuth readers did not collide: rotate ONLY Account B on disk, then call auth.refresh for B
    const staleB = { ...authBState };
    authBState = { ...authBState, access: "tok_B_new", refresh: "ref_B_new", expires: Date.now() + 3600_000 };
    const refreshedB = await hooks.auth.refresh(staleB);
    assert.equal(refreshedB.access, "tok_B_new");
    assert.equal(refreshedB.refresh, "ref_B_new");
    assert.equal(tokenCalls, 0);
  });
});

test("cold process recovers rotated token from plugin-auth.json before loader or usage has ever run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "magpie-verboo-cold-"));
  try {
    const authFile = join(dir, "plugin-auth.json");
    const acct1Stale = {
      type: "oauth",
      access: "cold_a_old",
      refresh: "cold_ref_a_old",
      expires: Date.now() + 30_000,
      installationId: UUID_A,
      uid: UUID_A,
      accountId: "a@example.com",
    };
    const acct2Stale = {
      type: "oauth",
      access: "cold_b_old",
      refresh: "cold_ref_b_old",
      expires: Date.now() + 30_000,
      installationId: UUID_A,
      uid: UUID_B,
      accountId: "b@example.com",
    };
    // Another Magpie process already rotated Account 2 and wrote plugin-auth.json
    writeFileSync(
      authFile,
      JSON.stringify({
        verboo: acct1Stale,
        "verboo#second": {
          ...acct2Stale,
          access: "cold_b_rotated",
          refresh: "cold_ref_b_rotated",
          expires: Date.now() + 3600_000,
        },
      }),
      "utf8",
    );

    let tokenCalls = 0;
    await withMockFetch(async (url, init) => {
      const href = String(url);
      if (href === _internal.TOKEN_URL) {
        tokenCalls++;
        // Mid-flight rotation for Account 1 written by another process
        const disk = JSON.parse(readFileSync(authFile, "utf8"));
        disk.verboo = {
          ...acct1Stale,
          access: "cold_a_midflight",
          refresh: "cold_ref_a_midflight",
          expires: Date.now() + 3600_000,
        };
        writeFileSync(authFile, JSON.stringify(disk), "utf8");
        return jsonResponse({ error: "invalid_grant" }, 400);
      }
      if (href === _internal.MODELS_URL) {
        const h = new Headers(init.headers).get("authorization");
        assert.equal(h, "Bearer cold_b_rotated");
        return jsonResponse({ data: [{ id: "cold-model" }] });
      }
      throw new Error(`Unexpected fetch: ${href}`);
    }, async () => {
      // Fresh cold server: NEITHER loader NOR usage has ever been called!
      // And magpie.account() returns bare "verboo" for both!
      const hooks = await plugin.server({
        directory: dir,
        magpie: { account: () => "verboo" },
      });

      // 1. Cold auth.refresh on Account 2 sees rotated token on disk BEFORE hitting /oauth/token
      const res2 = await hooks.auth.refresh({ ...acct2Stale });
      assert.equal(res2.access, "cold_b_rotated");
      assert.equal(res2.refresh, "cold_ref_b_rotated");
      assert.equal(tokenCalls, 0);

      // 2. Cold provider.models on Account 2 picks up cold_b_rotated without hitting /oauth/token
      const models = await hooks.provider.models({ models: {} }, { auth: { ...acct2Stale } });
      assert.ok(models["cold-model"]);
      assert.equal(tokenCalls, 0);

      // 3. Cold auth.refresh on Account 1 recovers from mid-flight invalid_grant via plugin-auth.json
      const res1 = await hooks.auth.refresh({ ...acct1Stale });
      assert.equal(res1.access, "cold_a_midflight");
      assert.equal(res1.refresh, "cold_ref_a_midflight");
      assert.equal(tokenCalls, 1);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
