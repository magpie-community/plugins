import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as entry from "../index.mjs";
import { AtomCodePlugin } from "../index.mjs";
import { signAtomGitRequest } from "../sign.mjs";

/**
 * checkin 钩子的四条路径。
 *
 * 插件的 CodingPlan 调用走全局 fetch（与 sensenova 模板同款测试法），
 * 所以这里 stub globalThis.fetch 按 URL 分流：status-v2 / claim-v2 /
 * raw.atomgit.com（版本探测）各自给脚本。
 */

/** status-v2 的有效套餐响应（登录态健康、无需重领）。 */
const VALID_STATUS = {
  codingplan_free: {
    plan_name: "CodingPlan Lite-体验版",
    plan_type: "Lite-beta",
    status: 1,
    remaining_days: 4,
    expires_at: "2099-10-20",
  },
  current_usage: { usage_percent: 0, window_hours: 5, seconds_until_reset: 1000 },
  rate_limit_windows: [{ window_size_seconds: 18000, call_limit: 200, calls_used: 0, seconds_until_reset: 1000 }],
};

const MANIFEST = '[workspace.package]\nversion = "5.2.3"\nedition = "2021"\n';

function cliAuthFile({
  access = "cli-access",
  refresh = "cli-refresh",
  createdAt = 1800000000,
  expiresIn = 3600,
  id = "42",
  email,
} = {}) {
  return [
    `access_token = ${JSON.stringify(access)}`,
    ...(refresh ? [`refresh_token = ${JSON.stringify(refresh)}`] : []),
    'token_type = "Bearer"',
    `expires_in = ${expiresIn}`,
    `created_at = ${createdAt}`,
    "",
    "[user]",
    `id = ${JSON.stringify(String(id))}`,
    'username = "alice"',
    ...(email ? [`email = ${JSON.stringify(email)}`] : []),
    "",
  ].join("\n");
}

/** broker 回的登录地址，带 force_login（插件应把它摘掉）。 */
const LOGIN_URL = "https://atomgit.com/login?force_login=true";

/**
 * 安装一个按 URL 分流的全局 fetch stub，返回 { calls, restore }。
 * claimResponses 是逐次出队的 {status?, body}；statusBody 为 null 时 status-v2 回 500；
 * modelsBody 为 null 时 models-v2 回空列表。calls 里带上 headers，便于断言凭证去向。
 */
function stubFetch({
  statusBody,
  statusStatus,
  statusResponses = [],
  claimResponses = [],
  modelsBody = null,
  modelsResponses = [],
  modelsStatus = 200,
  refreshResponses = [],
  chatResponses = [],
  authCheckResponses = [],
  authTokenResponses = [],
  authLoginResponses = [],
}) {
  const calls = [];
  const claimQueue = [...claimResponses];
  const refreshQueue = [...refreshResponses];
  const statusQueue = [...statusResponses];
  const chatQueue = [...chatResponses];
  const modelsQueue = [...modelsResponses];
  const authCheckQueue = [...authCheckResponses];
  const authTokenQueue = [...authTokenResponses];
  const authLoginQueue = [...authLoginResponses];
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(typeof input === "string" ? input : input.url);
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
    calls.push({
      url,
      method: init.method ?? "GET",
      headers,
      redirect: init.redirect,
      body: init.body,
    });
    if (url.includes("raw.atomgit.com")) return new Response(MANIFEST, { status: 200 });
    if (url.includes("status-v2")) {
      if (statusQueue.length) {
        const next = statusQueue.shift();
        return new Response(next.body, { status: next.status ?? 200 });
      }
      const status = statusStatus ?? (statusBody === null ? 500 : 200);
      return new Response(statusBody === null ? "boom" : JSON.stringify(statusBody), {
        status,
      });
    }
    if (url.includes("models-v2")) {
      if (modelsQueue.length) {
        const next = modelsQueue.shift();
        return new Response(next.body, { status: next.status ?? 200 });
      }
      return new Response(modelsBody === null ? "[]" : JSON.stringify(modelsBody), { status: modelsStatus });
    }
    if (url.includes("oauth/refresh")) {
      const next = refreshQueue.shift() ?? { status: 500, body: "{}" };
      return new Response(next.body, { status: next.status ?? 200 });
    }
    if (url.includes("auth/login")) {
      if (authLoginQueue.length) {
        const next = authLoginQueue.shift();
        return new Response(next.body, { status: next.status ?? 200 });
      }
      return new Response(JSON.stringify({ login_url: LOGIN_URL, state: "state-1" }), { status: 200 });
    }
    if (url.includes("auth/check")) {
      const next = authCheckQueue.shift() ?? { body: JSON.stringify({ valid: false }) };
      return new Response(next.body, { status: next.status ?? 200 });
    }
    if (url.includes("auth/token")) {
      const next = authTokenQueue.shift() ?? { status: 500, body: "{}" };
      return new Response(next.body, { status: next.status ?? 200 });
    }
    if (url.includes("claim-v2")) {
      const next = claimQueue.shift() ?? { status: 400, body: JSON.stringify({ success: false, message: "no" }) };
      return new Response(next.body, { status: next.status ?? 200 });
    }
    if (url.includes("chat/completions") && chatQueue.length) {
      const next = chatQueue.shift();
      return new Response(next.body ?? "", { status: next.status ?? 200 });
    }
    return new Response("{}", { status: 404 });
  };
  return {
    calls,
    restore() {
      globalThis.fetch = real;
    },
  };
}

const AUTH = { type: "oauth", access: "tok", uid: "u1" };

test("entry exports only the plugin function for OpenCode compatibility", () => {
  assert.deepEqual(Object.keys(entry), ["AtomCodePlugin"]);
});

test("browser OAuth：授权失败返回可读错误，不泄露上游正文", async () => {
  const stub = stubFetch({
    statusBody: VALID_STATUS,
    authLoginResponses: [{ status: 502, body: "sensitive upstream body" }],
  });
  try {
    const plugin = await AtomCodePlugin({}, { autoVersion: false });
    await assert.rejects(
      () => plugin.auth.methods[0].authorize(),
      (error) =>
        /Sign-in failed/i.test(error.message) &&
        !error.message.includes("sensitive upstream body"),
    );
  } finally {
    stub.restore();
  }
});

test("browser OAuth：check → token → success，并声明浏览器来源", async () => {
  const stub = stubFetch({
    statusBody: VALID_STATUS,
    authCheckResponses: [{ body: JSON.stringify({ valid: true }) }],
    authTokenResponses: [
      {
        body: JSON.stringify({
          access_token: "browser-access",
          refresh_token: "browser-refresh",
          expires_in: 0,
          user: { id: 7, username: "bob", name: "Bob" },
        }),
      },
    ],
  });
  try {
    const plugin = await AtomCodePlugin(
      {},
      { autoVersion: false, autoClaim: false, locale: "en" },
    );
    const flow = await plugin.auth.methods[0].authorize();
    const result = await flow.callback();
    assert.equal(result.type, "success");
    assert.equal(result.source, "atomcode-browser");
    assert.equal(result.access, "browser-access");
    assert.equal(result.accountId, "bob");
    assert.equal(result.email, undefined);
    assert.ok(result.expires > Date.now() + 6 * 24 * 3600_000);
  } finally {
    stub.restore();
  }
}, { timeout: 10_000 });

async function checkinWith(setup, getAuth = async () => AUTH) {
  const stub = stubFetch(setup);
  try {
    const plugin = await AtomCodePlugin({}, {});
    return { result: await plugin.auth.checkin(getAuth), calls: stub.calls };
  } finally {
    stub.restore();
  }
}

test("checkin：套餐仍有效 → done，不打领取接口", async () => {
  const { result, calls } = await checkinWith({ statusBody: VALID_STATUS });
  assert.equal(result.outcome, "done");
  assert.match(result.message, /Lite/);
  assert.equal(calls.filter((c) => c.url.includes("claim-v2")).length, 0, "有效期内不应打领取接口");
});

test("checkin：套餐过期 → 重领成功 → claimed，带套餐名", async () => {
  const expired = {
    ...VALID_STATUS,
    codingplan_free: { ...VALID_STATUS.codingplan_free, remaining_days: 0, expires_at: "2020-01-01" },
  };
  const { result } = await checkinWith({
    statusBody: expired,
    claimResponses: [
      { body: JSON.stringify({ success: true, duplicate: false, plan_name: "CodingPlan Lite-体验版", plan_type: "Lite" }) },
    ],
  });
  assert.equal(result.outcome, "claimed");
  assert.match(result.message, /CodingPlan Lite-体验版/);
});

test("checkin：duplicate（本来就持有）→ done 而不是 claimed", async () => {
  const expired = {
    ...VALID_STATUS,
    codingplan_free: { ...VALID_STATUS.codingplan_free, remaining_days: 0, expires_at: "2020-01-01" },
  };
  const { result } = await checkinWith({
    statusBody: expired,
    claimResponses: [{ body: JSON.stringify({ success: false, duplicate: true, plan_type: "Lite" }) }],
  });
  assert.equal(result.outcome, "done");
});

test("checkin：名额耗尽 → ineligible，透出上游 message", async () => {
  const expired = {
    ...VALID_STATUS,
    codingplan_free: { ...VALID_STATUS.codingplan_free, remaining_days: 0, expires_at: "2020-01-01" },
  };
  const full = { status: 400, body: JSON.stringify({ success: false, message: "全平台日限额已满" }) };
  const { result } = await checkinWith({
    statusBody: expired,
    claimResponses: [full, full, full],
  });
  assert.equal(result.outcome, "ineligible");
  assert.match(result.message, /日限额|no tier/);
});

test("checkin：未登录 → failed 提示登录，CodingPlan 请求一个都不发", async () => {
  // 插件构造时的版本探测会先打一次 raw.atomgit.com（正常），这里只看 CodingPlan。
  const { result, calls } = await checkinWith({ statusBody: VALID_STATUS }, async () => undefined);
  assert.equal(result.outcome, "failed");
  assert.equal(calls.filter((c) => c.url.includes("gitcode") || c.url.includes("coding-plan")).length, 0);
});

test("checkin：status 500（网络/服务异常）→ 仍尝试领取，由领取结果说话", async () => {
  const { result } = await checkinWith({
    statusBody: null,
    claimResponses: [{ body: JSON.stringify({ success: true, duplicate: false, plan_name: "CodingPlan Lite" }) }],
  });
  assert.equal(result.outcome, "claimed");
});

test("checkin：英文 locale 的套餐名使用英文括号", async () => {
  const stub = stubFetch({ statusBody: VALID_STATUS });
  try {
    const plugin = await AtomCodePlugin({}, { locale: "en", autoVersion: false });
    const result = await plugin.auth.checkin(async () => AUTH);
    assert.equal(result.message, "The plan is still active; nothing to claim (CodingPlan Lite-体验版)");
    assert.doesNotMatch(result.message, /（/);
  } finally {
    stub.restore();
  }
});

test("config：seed 模型、用户覆盖和 provider 元数据正确合并", async () => {
  const plugin = await AtomCodePlugin({}, { autoVersion: false });
  const cfg = {
    provider: {
      atomcode: {
        models: { custom: { name: "Custom" } },
        maxConcurrency: 2,
      },
    },
  };
  await plugin.config(cfg);

  assert.equal(cfg.provider.atomcode.name, "ATOMCODE");
  assert.equal(cfg.provider.atomcode.npm, "@ai-sdk/openai-compatible");
  assert.equal(cfg.provider.atomcode.api, GATEWAY);
  assert.ok(cfg.provider.atomcode.models["qwen3.8-27b"]);
  assert.deepEqual(cfg.provider.atomcode.models.custom, { name: "Custom" });
  assert.equal(cfg.provider.atomcode.maxConcurrency, 2);
});

/** 网关根地址（与 internal.mjs 的 DEFAULT_GATEWAY_BASE_URL 一致）。 */
const GATEWAY = "https://llm-api.atomgit.com/v1";

test("provider.models：上游给的自定义 base_url 不在白名单 → 退回官方网关", async () => {
  const stub = stubFetch({
    statusBody: VALID_STATUS,
    modelsBody: [
      { display_model_name: "qwen3.8-27b", context_window: 262144, base_url: "https://evil.example/v1" },
      { display_model_name: "glm5.3-flash", context_window: 512000, base_url: "https://raw.atomgit.com/v1" },
    ],
  });
  try {
    const plugin = await AtomCodePlugin({}, { locale: "en", autoVersion: false });
    const models = await plugin.provider.models({}, { auth: AUTH });
    assert.equal(models["qwen3.8-27b"].api.url, GATEWAY, "非法地址必须被换成官方网关");
    assert.equal(models["glm5.3-flash"].api.url, GATEWAY, "其他 atomgit 子域也必须退回网关");
  } finally {
    stub.restore();
  }
});

test("provider.models：sanitize 后 key 冲突时保留两个模型", async () => {
  const stub = stubFetch({
    statusBody: VALID_STATUS,
    modelsBody: [
      { display_model_name: "model/a", context_window: 1000 },
      { display_model_name: "model_a", context_window: 2000 },
    ],
  });
  try {
    const plugin = await AtomCodePlugin({}, { autoVersion: false });
    const models = await plugin.provider.models({}, { auth: AUTH });
    assert.equal(models["model_a"].api.id, "model/a");
    assert.equal(models["model_a_2"].api.id, "model_a");
    assert.equal(models["model_a_2"].limit.context, 2000);
  } finally {
    stub.restore();
  }
});

test("provider.models：特殊模型名不会改写结果对象原型", async () => {
  const stub = stubFetch({
    statusBody: VALID_STATUS,
    modelsBody: [
      { display_model_name: "__proto__", context_window: 1000 },
      { display_model_name: "constructor", context_window: 2000 },
    ],
  });
  try {
    const plugin = await AtomCodePlugin({}, { autoVersion: false });
    const models = await plugin.provider.models({}, { auth: AUTH });
    assert.equal(Object.getPrototypeOf(models), null);
    assert.equal(Object.hasOwn(models, "__proto__"), true);
    assert.equal(models.__proto__.api.id, "__proto__");
    assert.equal(models.constructor.api.id, "constructor");
  } finally {
    stub.restore();
  }
});

test("provider.models：目录读取失败时返回带 fallback 标记的内置列表", async () => {
  const stub = stubFetch({ statusBody: null });
  try {
    const plugin = await AtomCodePlugin({}, { autoVersion: false });
    const models = await plugin.provider.models({}, { auth: AUTH });
    assert.equal(models[Symbol.for("magpie.fellBack")], true);
    assert.ok(models["qwen3.8-27b"]);
  } finally {
    stub.restore();
  }
});

test("provider.models：401 让账号进入重新登录状态", async () => {
  const stub = stubFetch({ statusBody: { error: "expired" }, statusStatus: 401 });
  try {
    const plugin = await AtomCodePlugin({}, { autoVersion: false });
    await assert.rejects(
      () => plugin.provider.models({}, { auth: AUTH }),
      (error) => error.signIn === "expired",
    );
  } finally {
    stub.restore();
  }
});

test("provider.models：401 会续期并重新读取目录", async () => {
  const stub = stubFetch({
    statusResponses: [
      { status: 401, body: "{}" },
      { status: 200, body: JSON.stringify(VALID_STATUS) },
    ],
    modelsBody: [{ display_model_name: "qwen3.8-27b", context_window: 262144 }],
    refreshResponses: [
      {
        body: JSON.stringify({
          access_token: "models-retry-access",
          refresh_token: "models-retry-refresh",
          expires_in: 3600,
        }),
      },
    ],
  });
  try {
    const plugin = await AtomCodePlugin({}, { autoVersion: false });
    const models = await plugin.provider.models(
      {},
      {
        auth: {
          ...AUTH,
          refresh: "models-old-refresh",
          expires: Date.now() + 3600_000,
        },
      },
    );
    assert.ok(models["qwen3.8-27b"]);
    assert.equal(stub.calls.filter((call) => call.url.includes("oauth/refresh")).length, 1);
  } finally {
    stub.restore();
  }
});

test("provider.models：空目录会触发一次领取并重新读取模型", async () => {
  const expired = {
    ...VALID_STATUS,
    codingplan_free: {
      ...VALID_STATUS.codingplan_free,
      remaining_days: 0,
      expires_at: "2020-01-01",
    },
  };
  const stub = stubFetch({
    statusResponses: [
      { status: 200, body: JSON.stringify(expired) },
      { status: 200, body: JSON.stringify(expired) },
      { status: 200, body: JSON.stringify(expired) },
    ],
    modelsResponses: [
      { status: 200, body: "[]" },
      {
        status: 200,
        body: JSON.stringify([
          { display_model_name: "deepseek-flash", context_window: 1000000 },
        ]),
      },
    ],
    claimResponses: [
      {
        status: 200,
        body: JSON.stringify({
          success: true,
          duplicate: false,
          plan_name: "CodingPlan Lite",
          plan_type: "Lite",
        }),
      },
    ],
  });
  try {
    const plugin = await AtomCodePlugin({}, { autoVersion: false });
    const models = await plugin.provider.models({}, { auth: AUTH });
    assert.ok(models["deepseek-flash"]);
    assert.equal(stub.calls.filter((call) => call.url.includes("claim-v2")).length, 1);
  } finally {
    stub.restore();
  }
});

test("loader：发往网关的请求照常带凭证与签名", async () => {
  const stub = stubFetch({ statusBody: VALID_STATUS });
  try {
    const plugin = await AtomCodePlugin({}, { autoVersion: false });
    const { fetch: patched } = await plugin.auth.loader(async () => AUTH);
    await patched(`${GATEWAY}/chat/completions`, { method: "POST", body: JSON.stringify({ model: "m" }) });
    const call = stub.calls.find((c) => c.url.includes("chat/completions"));
    assert.ok(call, "官方网关的请求应当发出");
    assert.equal(call.headers.get("authorization"), "Bearer tok");
    assert.match(call.headers.get("x-atomcode-sig") ?? "", /^v1:[0-9a-f]{64}$/);
    assert.equal(call.headers.get("user-agent"), "atomcode/5.2.3");
    assert.equal(call.redirect, "error");
  } finally {
    stub.restore();
  }
});

test("loader：校验后冻结目标字符串，URL 在取凭证期间被改也不能换目的地", async () => {
  const stub = stubFetch({ statusBody: VALID_STATUS });
  try {
    const plugin = await AtomCodePlugin({}, { autoVersion: false });
    const target = new URL(`${GATEWAY}/chat/completions`);
    const { fetch: patched } = await plugin.auth.loader(async () => {
      target.hostname = "evil.example";
      return AUTH;
    });
    await patched(target, { method: "POST", body: "{}" });
    assert.equal(stub.calls.filter((call) => call.url.includes("evil.example")).length, 0);
    assert.ok(stub.calls.some((call) => call.url.includes("llm-api.atomgit.com")));
  } finally {
    stub.restore();
  }
});

test("loader：流式请求补 include_usage，并按最终字节签名", async () => {
  const stub = stubFetch({ statusBody: VALID_STATUS });
  try {
    const plugin = await AtomCodePlugin({}, { autoVersion: false });
    const { fetch: patched } = await plugin.auth.loader(async () => AUTH);
    const original = JSON.stringify({ model: "m", stream: true, messages: [] });
    await patched(`${GATEWAY}/chat/completions`, { method: "POST", body: original });
    const call = stub.calls.find((entry) => entry.url.includes("chat/completions"));
    const sent = JSON.parse(call.body);
    assert.equal(sent.stream_options.include_usage, true);
    const expected = signAtomGitRequest({
      method: "POST",
      path: "/v1/chat/completions",
      body: call.body,
      oauthToken: AUTH.access,
      userId: AUTH.uid,
      clientVersion: "5.2.3",
      timestamp: Number(call.headers.get("x-atomcode-ts")),
      nonce: call.headers.get("x-atomcode-nonce"),
    });
    assert.equal(call.headers.get("x-atomcode-sig"), expected["X-AtomCode-Sig"]);
  } finally {
    stub.restore();
  }
});

test("loader：显式 include_usage=false 和不可重放 body 不被静默改写", async () => {
  const stub = stubFetch({ statusBody: VALID_STATUS });
  try {
    const plugin = await AtomCodePlugin({}, { autoVersion: false });
    const { fetch: patched } = await plugin.auth.loader(async () => AUTH);
    const explicit = JSON.stringify({ stream: true, stream_options: { include_usage: false } });
    await patched(`${GATEWAY}/chat/completions`, { method: "POST", body: explicit });
    assert.equal(
      stub.calls.find((entry) => entry.url.includes("chat/completions")).body,
      explicit,
    );
    await assert.rejects(
      () => patched(`${GATEWAY}/chat/completions`, {
        method: "POST",
        body: new ReadableStream(),
        duplex: "half",
      }),
      /unsupported request body/i,
    );
  } finally {
    stub.restore();
  }
});

test("loader：非网关目标的请求被拦下，一个请求都不发出", async () => {
  const stub = stubFetch({ statusBody: VALID_STATUS });
  try {
    const plugin = await AtomCodePlugin({}, { autoVersion: false });
    const { fetch: patched } = await plugin.auth.loader(async () => AUTH);
    await assert.rejects(
      () => patched("https://evil.example/v1/chat/completions", { method: "POST", body: "{}" }),
      (error) => error instanceof Error && /evil\.example/.test(error.message),
    );
    assert.equal(stub.calls.filter((c) => c.url.includes("evil.example")).length, 0, "凭证不得离开网关");
  } finally {
    stub.restore();
  }
});

test("loader：同域名的 http 明文地址同样被拦下", async () => {
  const stub = stubFetch({ statusBody: VALID_STATUS });
  try {
    const plugin = await AtomCodePlugin({}, { autoVersion: false });
    const { fetch: patched } = await plugin.auth.loader(async () => AUTH);
    await assert.rejects(
      () => patched("http://llm-api.atomgit.com/v1/chat/completions", { method: "POST", body: "{}" }),
      (error) => error instanceof Error && /llm-api\.atomgit\.com/.test(error.message),
    );
    assert.equal(stub.calls.filter((c) => c.url.startsWith("http://")).length, 0, "明文请求不得发出");
  } finally {
    stub.restore();
  }
});

test("loader：没有登录时移除传入的 authorization 再请求网关", async () => {
  const stub = stubFetch({ statusBody: VALID_STATUS });
  try {
    const plugin = await AtomCodePlugin({}, { autoVersion: false });
    const { fetch: patched } = await plugin.auth.loader(async () => undefined);
    await patched(`${GATEWAY}/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer caller-token" },
      body: "{}",
    });
    const call = stub.calls.find((c) => c.url.includes("chat/completions"));
    assert.equal(call.headers.get("authorization"), null);
  } finally {
    stub.restore();
  }
});

test("loader：过期 token 单次刷新后持久化并签名新 token", async () => {
  const stub = stubFetch({
    statusBody: VALID_STATUS,
    refreshResponses: [
      {
        body: JSON.stringify({
          access_token: "fresh-access",
          refresh_token: "fresh-refresh",
          expires_in: 3600,
        }),
      },
    ],
  });
  const saved = [];
  try {
    const plugin = await AtomCodePlugin(
      { client: { auth: { set: async (payload) => saved.push(payload) } } },
      { autoVersion: false },
    );
    const expired = { ...AUTH, refresh: "old-refresh", expires: Date.now() - 1 };
    const { fetch: patched } = await plugin.auth.loader(async () => expired);
    await patched(`${GATEWAY}/chat/completions`, { method: "POST", body: "{}" });

    const call = stub.calls.find((c) => c.url.includes("chat/completions"));
    assert.equal(call.headers.get("authorization"), "Bearer fresh-access");
    assert.equal(saved.length, 1);
    assert.equal(saved[0].body.access, "fresh-access");
    assert.equal(saved[0].body.refresh, "fresh-refresh");
  } finally {
    stub.restore();
  }
});

test("loader：持久化失败时，后续请求仍复用刷新结果而不是再次轮换", async () => {
  const stub = stubFetch({
    statusBody: VALID_STATUS,
    refreshResponses: [
      {
        body: JSON.stringify({
          access_token: "fresh-once",
          refresh_token: "rotated-once",
          expires_in: 3600,
        }),
      },
    ],
  });
  try {
    const plugin = await AtomCodePlugin(
      {
        client: {
          auth: {
            set: async () => {
              throw new Error("disk full");
            },
          },
        },
      },
      { autoVersion: false },
    );
    const expired = { ...AUTH, refresh: "refresh-once", expires: Date.now() - 1 };
    const { fetch: patched } = await plugin.auth.loader(async () => expired);
    await patched(`${GATEWAY}/chat/completions`, { method: "POST", body: "{}" });
    await patched(`${GATEWAY}/chat/completions`, { method: "POST", body: "{}" });

    const calls = stub.calls.filter((entry) => entry.url.includes("chat/completions"));
    assert.equal(calls.length, 2);
    assert.equal(calls[0].headers.get("authorization"), "Bearer fresh-once");
    assert.equal(calls[1].headers.get("authorization"), "Bearer fresh-once");
    assert.equal(stub.calls.filter((entry) => entry.url.includes("oauth/refresh")).length, 1);
  } finally {
    stub.restore();
  }
});

test("loader：网关 401 后强制续期并只重试一次", async () => {
  const stub = stubFetch({
    statusBody: VALID_STATUS,
    chatResponses: [
      { status: 401, body: "{}" },
      { status: 200, body: "{}" },
    ],
    refreshResponses: [
      {
        body: JSON.stringify({
          access_token: "retry-access",
          refresh_token: "retry-refresh",
          expires_in: 3600,
        }),
      },
    ],
  });
  try {
    const plugin = await AtomCodePlugin({}, { autoVersion: false });
    const auth = {
      ...AUTH,
      refresh: "retry-old-refresh",
      expires: Date.now() + 3600_000,
    };
    const { fetch: patched } = await plugin.auth.loader(async () => auth);
    const response = await patched(`${GATEWAY}/chat/completions`, {
      method: "POST",
      body: "{}",
    });
    assert.equal(response.status, 200);
    const calls = stub.calls.filter((entry) => entry.url.includes("chat/completions"));
    assert.equal(calls.length, 2);
    assert.equal(calls[0].headers.get("authorization"), "Bearer tok");
    assert.equal(calls[1].headers.get("authorization"), "Bearer retry-access");
    assert.equal(stub.calls.filter((entry) => entry.url.includes("oauth/refresh")).length, 1);
  } finally {
    stub.restore();
  }
});

test("loader：过期且没有 refresh token 时标记重新登录", async () => {
  const stub = stubFetch({ statusBody: VALID_STATUS });
  try {
    const plugin = await AtomCodePlugin({}, { autoVersion: false });
    const { fetch: patched } = await plugin.auth.loader(async () => ({
      ...AUTH,
      expires: Date.now() - 1,
    }));
    await assert.rejects(
      () => patched(`${GATEWAY}/chat/completions`, { method: "POST", body: "{}" }),
      (error) => error.signIn === "expired",
    );
  } finally {
    stub.restore();
  }
});

test("loader：续期只遇到网络故障时保留旧 token 并继续请求", async () => {
  const stub = stubFetch({
    statusBody: VALID_STATUS,
    refreshResponses: [{ status: 503, body: "{}" }],
  });
  const logs = [];
  try {
    const plugin = await AtomCodePlugin(
      { client: { app: { log: ({ body }) => logs.push(body.message) } } },
      { autoVersion: false },
    );
    const { fetch: patched } = await plugin.auth.loader(async () => ({
      ...AUTH,
      refresh: "network-refresh",
      expires: Date.now() - 1,
    }));
    await patched(`${GATEWAY}/chat/completions`, { method: "POST", body: "{}" });
    const call = stub.calls.find((entry) => entry.url.includes("chat/completions"));
    assert.equal(call.headers.get("authorization"), "Bearer tok");
    assert.ok(logs.some((line) => /Renewing.*failed/.test(line)));
  } finally {
    stub.restore();
  }
});

test("auth.refresh：刷新成功返回新凭证，失败透出 expired", async () => {
  const stub = stubFetch({
    statusBody: VALID_STATUS,
    refreshResponses: [
      {
        body: JSON.stringify({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 3600,
        }),
      },
      { status: 401, body: "{}" },
    ],
  });
  try {
    const plugin = await AtomCodePlugin({}, { autoVersion: false });
    const next = await plugin.auth.refresh({ ...AUTH, refresh: "old-refresh", expires: Date.now() - 1 });
    assert.equal(next.access, "new-access");
    assert.equal(next.refresh, "new-refresh");
    assert.ok(next.expires > Date.now());

    await assert.rejects(
      () => plugin.auth.refresh({ ...AUTH, refresh: "dead-refresh" }),
      (error) => error.signIn === "expired",
    );
  } finally {
    stub.restore();
  }
});

test("CLI sign-in：续期后原子回写 auth.toml", async () => {
  const home = await mkdtemp(join(tmpdir(), "atomcode-write-"));
  const file = join(home, ".atomcode", "auth.toml");
  await mkdir(join(home, ".atomcode"), { mode: 0o700 });
  await writeFile(
    file,
    cliAuthFile({
      access: "cli-old",
      createdAt: 1700000000,
      id: "42",
      email: "cli@example.com",
    }),
    { mode: 0o600 },
  );
  const stub = stubFetch({
    statusBody: VALID_STATUS,
    refreshResponses: [
      {
        body: JSON.stringify({
          access_token: "cli-new",
          refresh_token: "cli-rotated",
          expires_in: 7200,
        }),
      },
    ],
  });
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const plugin = await AtomCodePlugin({}, { autoVersion: false });
    const auth = {
      type: "oauth",
      source: "atomcode-cli",
      authFile: file,
      access: "cli-old",
      refresh: "cli-refresh",
      expires: Date.now() - 1,
      uid: "42",
      accountId: "cli@example.com",
      email: "cli@example.com",
    };
    const { fetch: patched } = await plugin.auth.loader(async () => auth);
    await patched(`${GATEWAY}/chat/completions`, { method: "POST", body: "{}" });

    const text = await readFile(file, "utf8");
    assert.match(text, /access_token = "cli-new"/);
    assert.match(text, /refresh_token = "cli-rotated"/);
    assert.match(text, /token_type = "Bearer"/);
    assert.match(text, /id = "42"/);
    assert.doesNotMatch(text, /id = 42/);
    const call = stub.calls.find((entry) => entry.url.includes("chat/completions"));
    assert.equal(call.headers.get("authorization"), "Bearer cli-new");
  } finally {
    stub.restore();
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }
});

test("CLI sign-in：auth.toml 账号切换时拒绝混用 uid", async () => {
  const home = await mkdtemp(join(tmpdir(), "atomcode-switch-"));
  const file = join(home, ".atomcode", "auth.toml");
  await mkdir(join(home, ".atomcode"), { mode: 0o700 });
  await writeFile(
    file,
    cliAuthFile({
      access: "other-access",
      refresh: "other-refresh",
      id: "99",
    }),
    { mode: 0o600 },
  );
  const stub = stubFetch({ statusBody: VALID_STATUS });
  try {
    const plugin = await AtomCodePlugin({}, { autoVersion: false });
    const { fetch: patched } = await plugin.auth.loader(async () => ({
      type: "oauth",
      source: "atomcode-cli",
      authFile: file,
      access: "saved-access",
      refresh: "saved-refresh",
      expires: Date.now() + 3600_000,
      uid: "42",
    }));
    await assert.rejects(
      () => patched(`${GATEWAY}/chat/completions`, { method: "POST", body: "{}" }),
      (error) => error.signIn === "expired" && /changed accounts/i.test(error.message),
    );
  } finally {
    stub.restore();
  }
});

test("CLI sign-in：auth.toml 暂时不可读时保留已保存凭证并告警", async () => {
  const stub = stubFetch({ statusBody: VALID_STATUS });
  const logs = [];
  try {
    const plugin = await AtomCodePlugin(
      { client: { app: { log: ({ body }) => logs.push(body.message) } } },
      { autoVersion: false },
    );
    const { fetch: patched } = await plugin.auth.loader(async () => ({
      type: "oauth",
      source: "atomcode-cli",
      authFile: "/definitely/missing/atomcode-auth.toml",
      access: "saved-access",
      refresh: "saved-refresh",
      expires: Date.now() + 3600_000,
      uid: "42",
    }));
    await patched(`${GATEWAY}/chat/completions`, { method: "POST", body: "{}" });
    const call = stub.calls.find((entry) => entry.url.includes("chat/completions"));
    assert.equal(call.headers.get("authorization"), "Bearer saved-access");
    assert.ok(logs.some((line) => /CLI sign-in failed/i.test(line)));
  } finally {
    stub.restore();
  }
});

test("CLI sign-in：第二个登录方式读取 auth.toml，并标记来源", async () => {
  const home = await mkdtemp(join(tmpdir(), "atomcode-plugin-"));
  await mkdir(join(home, ".atomcode"), { mode: 0o700 });
  await writeFile(
    join(home, ".atomcode", "auth.toml"),
    cliAuthFile({
      access: "cli-access",
      id: "42",
      email: "cli@example.com",
    }),
    { mode: 0o600 },
  );
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const plugin = await AtomCodePlugin({}, { autoVersion: false });
    const flow = await plugin.auth.methods[1].authorize();
    const result = await flow.callback();
    assert.equal(result.type, "success");
    assert.equal(result.source, "atomcode-cli");
    assert.equal(result.access, "cli-access");
    assert.equal(result.uid, "42");
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }
});

test("usage：上游 401 同时返回 signIn expired", async () => {
  const stub = stubFetch({ statusBody: { error: "expired" }, statusStatus: 401 });
  try {
    const plugin = await AtomCodePlugin({}, { locale: "en", autoVersion: false });
    const usage = await plugin.auth.usage(async () => AUTH);
    assert.equal(usage.signIn, "expired");
    assert.match(usage.error, /expired|sign in/i);
  } finally {
    stub.restore();
  }
});

test("usage：401 会先强制续期并用新 token 重试一次", async () => {
  const stub = stubFetch({
    statusResponses: [
      { status: 401, body: "{}" },
      { status: 200, body: JSON.stringify(VALID_STATUS) },
    ],
    refreshResponses: [
      {
        body: JSON.stringify({
          access_token: "usage-retry-access",
          refresh_token: "usage-retry-refresh",
          expires_in: 3600,
        }),
      },
    ],
  });
  try {
    const plugin = await AtomCodePlugin({}, { locale: "en", autoVersion: false });
    const usage = await plugin.auth.usage(async () => ({
      ...AUTH,
      refresh: "usage-old-refresh",
      expires: Date.now() + 3600_000,
    }));
    assert.equal(usage.plan, "CodingPlan Lite-体验版");
    assert.equal(stub.calls.filter((call) => call.url.includes("status-v2")).length, 2);
    assert.equal(stub.calls.filter((call) => call.url.includes("oauth/refresh")).length, 1);
    const statusCalls = stub.calls.filter((call) => call.url.includes("status-v2"));
    assert.equal(statusCalls[1].headers.get("authorization"), "Bearer usage-retry-access");
  } finally {
    stub.restore();
  }
});

test("checkin：status 401 会续期后重试并返回 done", async () => {
  const stub = stubFetch({
    statusResponses: [
      { status: 401, body: "{}" },
      { status: 200, body: JSON.stringify(VALID_STATUS) },
    ],
    refreshResponses: [
      {
        body: JSON.stringify({
          access_token: "checkin-retry-access",
          refresh_token: "checkin-retry-refresh",
          expires_in: 3600,
        }),
      },
    ],
  });
  try {
    const plugin = await AtomCodePlugin({}, { autoVersion: false });
    const result = await plugin.auth.checkin(async () => ({
      ...AUTH,
      refresh: "checkin-old-refresh",
      expires: Date.now() + 3600_000,
    }));
    assert.equal(result.outcome, "done");
    const statusCalls = stub.calls.filter((call) => call.url.includes("status-v2"));
    assert.equal(statusCalls.length, 2);
    assert.equal(statusCalls[1].headers.get("authorization"), "Bearer checkin-retry-access");
  } finally {
    stub.restore();
  }
});

test("checkin：并发调用共用一次领取请求", async () => {
  const expired = {
    ...VALID_STATUS,
    codingplan_free: { ...VALID_STATUS.codingplan_free, remaining_days: 0, expires_at: "2020-01-01" },
  };
  const stub = stubFetch({
    statusBody: expired,
    claimResponses: [
      { body: JSON.stringify({ success: true, duplicate: false, plan_name: "CodingPlan Lite" }) },
    ],
  });
  try {
    const plugin = await AtomCodePlugin({}, { autoVersion: false });
    const [a, b] = await Promise.all([
      plugin.auth.checkin(async () => AUTH),
      plugin.auth.checkin(async () => AUTH),
    ]);
    assert.equal(a.outcome, "claimed", JSON.stringify(a));
    assert.equal(b.outcome, "claimed", JSON.stringify(b));
    assert.equal(stub.calls.filter((call) => call.url.includes("claim-v2")).length, 1);
  } finally {
    stub.restore();
  }
});

test("usage：成功结果按账号缓存，未登录不请求上游", async () => {
  const stub = stubFetch({ statusBody: VALID_STATUS });
  try {
    const plugin = await AtomCodePlugin({}, { locale: "en", autoVersion: false });
    const first = await plugin.auth.usage(async () => AUTH);
    const second = await plugin.auth.usage(async () => AUTH);
    assert.equal(first.plan, "CodingPlan Lite-体验版");
    assert.equal(first.windows.length, 1);
    assert.deepEqual(second, first);
    assert.equal(stub.calls.filter((c) => c.url.includes("status-v2")).length, 1);

    const noAccount = await plugin.auth.usage(async () => undefined);
    assert.equal(noAccount.error, "No signed-in AtomCode account");
  } finally {
    stub.restore();
  }
});

test("options：非白名单的 platformBaseURL 被拒，回退官方 broker", async () => {
  const stub = stubFetch({ statusBody: VALID_STATUS });
  try {
    const plugin = await AtomCodePlugin({}, { autoVersion: false, platformBaseURL: "https://evil.example" });
    const started = await plugin.auth.methods[0].authorize();
    assert.equal(stub.calls.filter((c) => c.url.includes("evil.example")).length, 0, "授权请求不得打到非白名单地址");
    assert.ok(
      stub.calls.some((c) => c.url.startsWith("https://acs.atomgit.com/")),
      "应改用官方 broker",
    );
    assert.equal(started.url, "https://atomgit.com/login");
  } finally {
    stub.restore();
  }
});

test("options：http 或非白名单的 codingPlanAPIURL 被拒，回退官方端点", async () => {
  const stub = stubFetch({ statusBody: VALID_STATUS });
  try {
    const plugin = await AtomCodePlugin({}, { autoVersion: false, codingPlanAPIURL: "http://evil.example" });
    await plugin.auth.checkin(async () => AUTH);
    assert.equal(stub.calls.filter((c) => c.url.includes("evil.example")).length, 0, "额度请求不得打到非白名单地址");
    assert.ok(
      stub.calls.some((c) => c.url.startsWith("https://api.gitcode.com/")),
      "应改用官方端点",
    );
  } finally {
    stub.restore();
  }
});

test("options：白名单内的合法覆盖被采纳（上游迁移时的逃生口）", async () => {
  const stub = stubFetch({ statusBody: VALID_STATUS });
  try {
    const plugin = await AtomCodePlugin({}, { autoVersion: false, codingPlanAPIURL: "https://api.gitcode.com/api/v6" });
    await plugin.auth.checkin(async () => AUTH);
    assert.ok(
      stub.calls.some((c) => c.url.startsWith("https://api.gitcode.com/api/v6/")),
      "合法覆盖应当生效",
    );
  } finally {
    stub.restore();
  }
});

test("options：非法数值、版本号和布尔值回退默认并告警", async () => {
  const logs = [];
  const plugin = await AtomCodePlugin(
    {
      client: {
        app: {
          log: ({ body }) => logs.push(body.message),
        },
      },
    },
    {
      autoVersion: false,
      autoClaim: "false",
      clientVersion: "5.2.3\r\nInjected",
      masterKeyHex: "not-a-key",
      quotaTtlMs: Infinity,
      maxOutputTokens: -1,
      diagnosticsPort: 80,
    },
  );

  assert.equal(plugin.auth.refreshLead, 5 * 60 * 1000);
  for (const name of [
    "autoClaim",
    "clientVersion",
    "masterKeyHex",
    "quotaTtlMs",
    "maxOutputTokens",
    "diagnosticsPort",
  ]) {
    assert.ok(logs.some((line) => line.includes(name)), `missing warning for ${name}`);
  }
});

test("options：告警不记录原值，避免泄漏密钥或 URL 凭证", async () => {
  const logs = [];
  const plugin = await AtomCodePlugin(
    { client: { app: { log: ({ body }) => logs.push(body.message) } } },
    {
      autoVersion: false,
      masterKeyHex: "secret-that-must-not-be-logged",
      platformBaseURL: "https://user:password@evil.example",
    },
  );
  await plugin.config({ provider: {} });
  assert.ok(logs.some((line) => line.includes("masterKeyHex")));
  assert.ok(logs.every((line) => !line.includes("secret-that-must-not-be-logged")));
  assert.ok(logs.every((line) => !line.includes("password")));
});

test("options：布尔类型错误会告警，宿主 logger 抛错也不影响加载", async () => {
  const stub = stubFetch({ statusBody: VALID_STATUS });
  try {
    const plugin = await AtomCodePlugin(
      {
        client: {
          app: {
            log: () => {
              throw new Error("logger failed");
            },
          },
        },
      },
      { autoVersion: 1, autoClaim: "true" },
    );
    assert.equal(typeof plugin.auth.loader, "function");
  } finally {
    stub.restore();
  }
});

test("options：合法自定义 masterKey 被采纳且不误告警", async () => {
  const logs = [];
  const masterKeyHex = "ab".repeat(32);
  await AtomCodePlugin(
    { client: { app: { log: ({ body }) => logs.push(body.message) } } },
    { autoVersion: false, masterKeyHex },
  );
  assert.ok(logs.every((line) => !line.includes("masterKeyHex")));
});

test("native settings：声明布尔开关，并让显式旧选项优先于 Magpie 开关", async () => {
  const expired = {
    ...VALID_STATUS,
    codingplan_free: {
      ...VALID_STATUS.codingplan_free,
      remaining_days: 0,
      expires_at: "2020-01-01",
    },
  };
  const stub = stubFetch({
    statusBody: expired,
    modelsBody: [],
    claimResponses: [
      { body: JSON.stringify({ success: true, duplicate: false, plan_name: "CodingPlan Lite" }) },
    ],
  });
  const nativeReads = [];
  try {
    const plugin = await AtomCodePlugin(
      {
        magpie: {
          option: (provider, key) => {
            nativeReads.push([provider, key]);
            if (key === "auto_claim") return false;
            if (key === "auto_version") return true;
            return undefined;
          },
        },
      },
      {
        autoClaim: true,
        autoVersion: false,
        diagnosticsPort: 39278,
      },
    );
    assert.deepEqual(
      plugin.auth.options.map((option) => option.key),
      ["auto_claim", "auto_version"],
    );
    assert.equal(plugin.auth.options[0].labels.zh.length > 0, true);
    assert.equal(plugin.auth.options[0].descriptions.en.length > 0, true);
    assert.equal(plugin.auth.options[0].default, true);
    assert.equal(plugin.auth.options[1].default, true);

    await plugin.provider.models({}, { auth: AUTH });
    assert.equal(
      stub.calls.filter((call) => call.url.includes("claim-v2")).length,
      1,
      "显式 autoClaim=true 应压过原生 false",
    );
    assert.equal(
      stub.calls.filter((call) => call.url.includes("raw.atomgit.com")).length,
      0,
      "显式 autoVersion=false 应压过原生 true",
    );
    assert.deepEqual(nativeReads, [], "显式旧选项存在时不应再读取原生开关");
  } finally {
    stub.restore();
  }
});

test("native settings：未设置旧选项时读取 Magpie 的自动领取开关", async () => {
  const expired = {
    ...VALID_STATUS,
    codingplan_free: {
      ...VALID_STATUS.codingplan_free,
      remaining_days: 0,
      expires_at: "2020-01-01",
    },
  };
  const stub = stubFetch({
    statusBody: expired,
    modelsBody: [],
    claimResponses: [
      { body: JSON.stringify({ success: true, duplicate: false, plan_name: "CodingPlan Lite" }) },
    ],
  });
  try {
    const plugin = await AtomCodePlugin(
      {
        magpie: {
          option: (_provider, key) => (key === "auto_claim" ? false : undefined),
        },
      },
      { autoVersion: false, diagnosticsPort: 39279 },
    );
    await plugin.provider.models({}, { auth: AUTH });
    assert.equal(stub.calls.filter((call) => call.url.includes("claim-v2")).length, 0);
  } finally {
    stub.restore();
  }
});

test("CLI sign-in：自定义绝对路径会进入结果并用于读取", async () => {
  const home = await mkdtemp(join(tmpdir(), "atomcode-custom-path-"));
  const file = join(home, "custom", "atomcode-auth.toml");
  await mkdir(join(home, "custom"), { mode: 0o700 });
  await writeFile(
    file,
    cliAuthFile({
      access: "custom-access",
      refresh: "custom-refresh",
      id: "77",
    }),
    { mode: 0o600 },
  );
  try {
    const plugin = await AtomCodePlugin({}, { autoVersion: false });
    const method = plugin.auth.methods[1];
    assert.equal(method.prompts[0].key, "authFile");
    assert.equal(method.prompts[0].validate("relative.toml"), method.prompts[0].validate("../bad"));
    const flow = await method.authorize({ authFile: file });
    const result = await flow.callback();
    assert.equal(result.type, "success");
    assert.equal(result.authFile, file);
    assert.equal(result.access, "custom-access");
    assert.equal(result.uid, "77");
    await assert.rejects(
      () => method.authorize({ authFile: "relative.toml" }),
      /absolute or start with/,
    );
  } finally {
    // Temporary directory is intentionally left for the OS to clean up.
  }
});

test("loader：凭证类 403 会续期一次，额度类 403 保留登录且不续期", async () => {
  const credentialStub = stubFetch({
    statusBody: VALID_STATUS,
    chatResponses: [
      { status: 403, body: JSON.stringify({ message: "session token expired" }) },
      { status: 200, body: "{}" },
    ],
    refreshResponses: [
      {
        body: JSON.stringify({
          access_token: "forbidden-retry",
          refresh_token: "forbidden-refresh",
          expires_in: 3600,
        }),
      },
    ],
  });
  try {
    const plugin = await AtomCodePlugin({}, { autoVersion: false });
    const auth = {
      ...AUTH,
      refresh: "old-forbidden-refresh",
      expires: Date.now() + 3600_000,
    };
    const { fetch: patched } = await plugin.auth.loader(async () => auth);
    const response = await patched(`${GATEWAY}/chat/completions`, {
      method: "POST",
      body: "{}",
    });
    assert.equal(response.status, 200);
    const calls = credentialStub.calls.filter((call) => call.url.includes("chat/completions"));
    assert.equal(calls.length, 2);
    assert.equal(calls[1].headers.get("authorization"), "Bearer forbidden-retry");
    assert.equal(
      credentialStub.calls.filter((call) => call.url.includes("oauth/refresh")).length,
      1,
    );
  } finally {
    credentialStub.restore();
  }

  const entitlementStub = stubFetch({
    statusBody: VALID_STATUS,
    chatResponses: [{ status: 403, body: JSON.stringify({ message: "quota exhausted" }) }],
  });
  try {
    const plugin = await AtomCodePlugin({}, { autoVersion: false });
    const { fetch: patched } = await plugin.auth.loader(async () => ({
      ...AUTH,
      refresh: "must-not-refresh",
      expires: Date.now() + 3600_000,
    }));
    const response = await patched(`${GATEWAY}/chat/completions`, {
      method: "POST",
      body: "{}",
    });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("x-magpie-sign-in"), "kept");
    assert.match(await response.text(), /quota/);
    assert.equal(
      entitlementStub.calls.filter((call) => call.url.includes("oauth/refresh")).length,
      0,
    );
  } finally {
    entitlementStub.restore();
  }
});

test("usage：重启后网络失败返回磁盘上的 stale 额度而不是清空窗口", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atomcode-stale-usage-"));
  const first = stubFetch({ statusBody: VALID_STATUS });
  try {
    const plugin = await AtomCodePlugin(
      { directory },
      { locale: "en", autoVersion: false },
    );
    const value = await plugin.auth.usage(async () => AUTH);
    assert.equal(value.plan, "CodingPlan Lite-体验版");
    assert.equal(value.windows.length, 1);
  } finally {
    first.restore();
  }

  const offline = stubFetch({ statusBody: null });
  try {
    const plugin = await AtomCodePlugin(
      { directory },
      { locale: "en", autoVersion: false },
    );
    const stale = await plugin.auth.usage(async () => AUTH);
    assert.equal(stale.plan, "CodingPlan Lite-体验版");
    assert.equal(stale.windows.length, 1);
    assert.equal(stale.stale, true);
    assert.equal(stale.signIn, "kept");
    assert.match(stale.error, /last successful snapshot/i);
    const persisted = await readFile(join(directory, "atomcode-state.json"), "utf8");
    assert.doesNotMatch(persisted, /"u1"|"tok"|cli@example\.com/);
  } finally {
    offline.restore();
  }
});

test("provider.models：实时目录失败时重启后使用 last-good 磁盘缓存", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atomcode-cached-models-"));
  const catalogBody = [{ display_model_name: "cached-model", context_window: 12345 }];
  const first = stubFetch({ statusBody: VALID_STATUS, modelsBody: catalogBody });
  try {
    const plugin = await AtomCodePlugin(
      { directory },
      { autoVersion: false },
    );
    const models = await plugin.provider.models({}, { auth: AUTH });
    assert.equal(models["cached-model"].limit.context, 12345);
  } finally {
    first.restore();
  }

  const offline = stubFetch({ statusBody: null });
  try {
    const plugin = await AtomCodePlugin(
      { directory },
      { autoVersion: false },
    );
    const models = await plugin.provider.models({}, { auth: AUTH });
    assert.equal(models["cached-model"].api.id, "cached-model");
    assert.equal(models[Symbol.for("magpie.fellBack")], true);
  } finally {
    offline.restore();
  }
});

test("usage：额度类 403 不把账号标记为 expired", async () => {
  const stub = stubFetch({
    statusBody: { message: "CodingPlan quota exhausted" },
    statusStatus: 403,
  });
  try {
    const plugin = await AtomCodePlugin({}, { locale: "en", autoVersion: false });
    const usage = await plugin.auth.usage(async () => ({
      ...AUTH,
      refresh: "must-not-refresh",
      expires: Date.now() + 3600_000,
    }));
    assert.notEqual(usage.signIn, "expired");
    assert.equal(usage.signIn, "kept");
    assert.equal(stub.calls.filter((call) => call.url.includes("oauth/refresh")).length, 0);
  } finally {
    stub.restore();
  }
});
