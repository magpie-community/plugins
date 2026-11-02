import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import { CopilotAuthPlugin } from "./index.mjs";
import { getUrls, normalizeDomain } from "./endpoints.mjs";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const reply = (data) => new Response(JSON.stringify(data));
const signedIn = (extra = {}) => ({
  type: "oauth", refresh: "mock-github-oauth", access: "mock-copilot-token",
  expires: Date.now() + 60000, ...extra,
});

async function withLocalEndpoint(check) {
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      return Response.json({
        method: request.method, headers: Object.fromEntries(request.headers),
        body: await request.text(),
      });
    },
  });
  try {
    await check(`http://127.0.0.1:${server.port}/responses`);
  } finally {
    server.stop(true);
  }
}

function assertClientHeaders(input) {
  const headers = new Headers(input);
  assert.equal(headers.get("user-agent"), "GitHubCopilotChat/0.68.0");
  assert.equal(headers.get("editor-version"), "vscode/1.140.0");
  assert.equal(headers.get("editor-plugin-version"), "copilot-chat/0.68.0");
  assert.equal(headers.get("copilot-integration-id"), "vscode-chat");
}

test("one provider id, OAuth login and magpie's usage hook", async () => {
  const hooks = await CopilotAuthPlugin({ client: {} });
  assert.deepEqual(Object.keys(hooks), ["auth"]);
  assert.equal(hooks.auth.provider, "github-copilot");
  assert.equal(typeof hooks.auth.usage, "function");
  assert.equal(typeof hooks.auth.loader, "function");
  assert.equal(hooks.auth.methods[0].type, "oauth");
});

test("host parsing accepts GHE domains or HTTPS origins, not credential-bearing URLs", () => {
  for (const input of ["company.ghe.com", "https://company.ghe.com/", " COMPANY.GHE.COM "]) {
    assert.equal(normalizeDomain(input), "company.ghe.com");
  }
  for (const input of ["", undefined, "http://company.ghe.com", "https://user@company.ghe.com",
    "https://company.ghe.com/path", "https://company.ghe.com?x=1", "https://company.ghe.com#x",
    "https://company.ghe.com:8443", "https://localhost"]) {
    assert.throws(() => normalizeDomain(input));
  }
  assert.equal(getUrls().USER_URL, "https://api.github.com/copilot_internal/user");
  assert.equal(getUrls("company.ghe.com").USER_URL,
    "https://api.company.ghe.com/copilot_internal/user");
});

test("loader preserves public and Enterprise inference origins and zero token pricing", async () => {
  for (const [enterpriseUrl, baseURL] of [
    [undefined, "https://api.githubcopilot.com"],
    ["company.ghe.com", "https://copilot-api.company.ghe.com"],
  ]) {
    globalThis.fetch = async () => assert.fail("loader must not make a model request");
    const hooks = await CopilotAuthPlugin({ client: {} });
    const provider = { models: { mock: { cost: { input: 1, output: 2 } } } };
    const loader = await hooks.auth.loader(async () => signedIn({ enterpriseUrl }), provider);
    assert.equal(loader.baseURL, baseURL);
    assert.equal(loader.apiKey, "");
    assert.deepEqual(provider.models.mock.cost,
      { input: 0, output: 0, cache: { read: 0, write: 0 } });
  }
});

test("request signing preserves body, initiator and vision headers without a quota request", async () => {
  for (const [body, initiator, vision] of [
    [{ messages: [{ role: "user", content: "hello" }] }, "user", false],
    [{ messages: [{ role: "tool", content: "done" }] }, "agent", false],
    [{ input: [{ type: "function_call_output", output: "done" }] }, "agent", false],
    [{ input: [{ role: "user", content: [{ type: "input_image", image_url: "mock" }] }] }, "user", true],
  ]) {
    const seen = [];
    const saved = [];
    globalThis.fetch = async (url, init) => {
      seen.push({ url, init });
      return new Response("mock-ok");
    };
    const hooks = await CopilotAuthPlugin({ client: { auth: { set: async (v) => saved.push(v) } } });
    const loader = await hooks.auth.loader(async () => signedIn(), { models: {} });
    const result = await loader.fetch("https://api.githubcopilot.com/responses", {
      method: "POST", headers: { authorization: "wrong", "x-api-key": "wrong" },
      body: JSON.stringify(body),
    });
    assert.equal(await result.text(), "mock-ok");
    assert.equal(seen.length, 1);
    const headers = new Headers(seen[0].init.headers);
    assert.equal(headers.get("authorization"), "Bearer mock-copilot-token");
    assert.equal(headers.get("x-api-key"), null);
    assert.equal(headers.get("x-initiator"), initiator);
    assert.equal(headers.get("copilot-vision-request"), vision ? "true" : null);
    assert.equal(seen[0].init.body, JSON.stringify(body));
    assert.deepEqual(saved, []);
  }
});

test("outgoing requests preserve host Headers, objects and tuples without duplicate signing headers", async () => {
  await withLocalEndpoint(async (url) => {
    const hooks = await CopilotAuthPlugin({ client: {} });
    const loader = await hooks.auth.loader(async () => signedIn(), { models: {} });
    const hostHeaders = {
      "Content-Type": "application/json", Accept: "text/event-stream",
      "X-From-Chat-Headers": "1", "AUTHORIZATION": "wrong", "X-API-Key": "wrong",
      "x-initiator": "wrong", "openai-intent": "wrong", "user-agent": "wrong",
      "editor-version": "wrong", "editor-plugin-version": "wrong",
      "copilot-integration-id": "wrong",
    };
    const body = JSON.stringify({ messages: [{ role: "user", content: "hello" }] });
    for (const headers of [new Headers(hostHeaders), hostHeaders, Object.entries(hostHeaders)]) {
      const before = [...new Headers(headers)];
      const result = await loader.fetch(url, { method: "POST", headers, body });
      const sent = await result.json();
      assert.equal(sent.headers["content-type"], "application/json");
      assert.equal(sent.headers.accept, "text/event-stream");
      assert.equal(sent.headers["x-from-chat-headers"], "1");
      assert.equal(sent.headers.authorization, "Bearer mock-copilot-token");
      assert.equal(sent.headers["x-api-key"], undefined);
      assert.equal(sent.headers["x-initiator"], "user");
      assert.equal(sent.headers["openai-intent"], "conversation-edits");
      assertClientHeaders(sent.headers);
      assert.equal(sent.method, "POST");
      assert.equal(sent.body, body);
      assert.deepEqual([...new Headers(headers)], before);
    }
  });
});

test("outgoing Chat and Responses requests carry the signed initiator and vision headers", async () => {
  await withLocalEndpoint(async (url) => {
    const hooks = await CopilotAuthPlugin({ client: {} });
    const loader = await hooks.auth.loader(async () => signedIn(), { models: {} });
    for (const [body, initiator, vision] of [
      [{ messages: [{ role: "user", content: "hello" }] }, "user", false],
      [{ messages: [{ role: "tool", content: "done" }] }, "agent", false],
      [{ messages: [{ role: "assistant", content: "continue" }] }, "agent", false],
      [{ messages: [{ role: "user", content: [{ type: "image_url", image_url: "mock" }] }] }, "user", true],
      [{ input: [{ type: "function_call_output", output: "done" }] }, "agent", false],
      [{ input: [{ role: "assistant", content: "continue" }] }, "agent", false],
      [{ input: [{ role: "user", content: [{ type: "input_image", image_url: "mock" }] }] }, "user", true],
    ]) {
      const result = await loader.fetch(url, {
        method: "POST", headers: new Headers({ "Content-Type": "application/json" }),
        body: JSON.stringify(body),
      });
      const sent = await result.json();
      assert.equal(sent.headers.authorization, "Bearer mock-copilot-token");
      assert.equal(sent.headers["x-initiator"], initiator);
      assert.equal(sent.headers["copilot-vision-request"], vision ? "true" : undefined);
      assert.equal(sent.body, JSON.stringify(body));
    }
  });
});

test("outgoing requests pass through as Responses when auth stops being OAuth", async () => {
  await withLocalEndpoint(async (url) => {
    let auth = signedIn();
    const hooks = await CopilotAuthPlugin({ client: { auth: {
      set: async () => assert.fail("non-OAuth passthrough must not persist auth"),
    } } });
    const loader = await hooks.auth.loader(async () => auth, { models: {} });
    for (auth of [{ type: "api", key: "mock-api-key" }, null, undefined]) {
      const result = await loader.fetch(url, {
        method: "POST", headers: new Headers({
          "Content-Type": "application/json", Authorization: "Bearer mock-host-token",
          "X-From-Chat-Headers": "1",
        }), body: "{}",
      });
      assert.ok(result instanceof Response);
      const sent = await result.json();
      assert.equal(sent.headers.authorization, "Bearer mock-host-token");
      assert.equal(sent.headers["content-type"], "application/json");
      assert.equal(sent.headers["x-from-chat-headers"], "1");
      assert.equal(sent.headers["editor-version"], undefined);
      assert.equal(sent.headers["x-initiator"], undefined);
      assert.equal(sent.method, "POST");
      assert.equal(sent.body, "{}");
    }
  });
});

test("outgoing requests without init use the native magpie Copilot client versions", async () => {
  await withLocalEndpoint(async (url) => {
    const hooks = await CopilotAuthPlugin({ client: {} });
    const loader = await hooks.auth.loader(async () => signedIn(), { models: {} });
    const result = await loader.fetch(url);
    const sent = await result.json();
    assertClientHeaders(sent.headers);
    assert.equal(sent.headers.authorization, "Bearer mock-copilot-token");
    assert.equal(sent.method, "GET");
  });
});

test("refresh saves public and Enterprise tokens under the hook's provider id", async () => {
  for (const enterpriseUrl of [undefined, "company.ghe.com"]) {
    const auth = signedIn({ access: "", expires: 0, enterpriseUrl });
    const saved = [];
    const seen = [];
    const expires = Math.floor(Date.now() / 1000) + 3600;
    globalThis.fetch = async (url, init) => {
      seen.push({ url, init });
      if (url.endsWith("/copilot_internal/v2/token")) return reply({ token: "mock-new-token", expires_at: expires });
      return new Response("mock-ok");
    };
    const hooks = await CopilotAuthPlugin({ client: { auth: { set: async (v) => saved.push(v) } } });
    const loader = await hooks.auth.loader(async () => ({ ...auth }), { models: {} });
    await loader.fetch(`${loader.baseURL}/responses`, { body: "{}", headers: {} });
    assert.equal(seen.length, 2);
    assert.equal(seen[0].url, getUrls(enterpriseUrl).COPILOT_API_KEY_URL);
    assert.equal(seen[0].init.headers.Authorization, "Bearer mock-github-oauth");
    assertClientHeaders(seen[0].init.headers);
    assert.equal(new Headers(seen[1].init.headers).get("authorization"), "Bearer mock-new-token");
    assertClientHeaders(seen[1].init.headers);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].path.id, "github-copilot");
    assert.equal(saved[0].body.enterpriseUrl, enterpriseUrl);
    assert.equal(saved[0].body.expires, expires * 1000 - 300000);
    assert.equal(saved[0].body.refresh, "mock-github-oauth");
  }
});

test("device flow keeps Enterprise metadata without redirecting auth to another provider", async () => {
  for (const [inputs, host] of [
    [{}, "github.com"],
    [{ deploymentType: "enterprise", enterpriseUrl: "https://company.ghe.com/" }, "company.ghe.com"],
  ]) {
    const seen = [];
    globalThis.fetch = async (url, init) => {
      seen.push({ url, body: JSON.parse(init.body), headers: new Headers(init.headers) });
      if (url.endsWith("/login/device/code")) return reply({
        verification_uri: `https://${host}/login/device`, user_code: "MOCK-CODE",
        device_code: "mock-device-code", interval: 1,
      });
      return reply({ access_token: "mock-github-oauth" });
    };
    const hooks = await CopilotAuthPlugin({ client: {} });
    const flow = await hooks.auth.methods[0].authorize(inputs);
    const result = await flow.callback();
    assert.equal(flow.url, `https://${host}/login/device`);
    assert.equal(result.type, "success");
    assert.equal(result.provider, undefined);
    assert.equal(result.refresh, "mock-github-oauth");
    assert.equal(result.enterpriseUrl, host === "github.com" ? undefined : host);
    assert.equal(seen[0].url, `https://${host}/login/device/code`);
    assert.equal(seen[1].url, `https://${host}/login/oauth/access_token`);
    assert.equal(seen[1].body.device_code, "mock-device-code");
    for (const { headers } of seen) {
      assert.equal(headers.get("user-agent"), "GitHubCopilotChat/0.68.0");
    }
  }
});

// plugins#618: only GitHub turning the OAuth token away at the token
// exchange marks the account; another failure leaves it for the next try.
test("a refused token exchange says the sign-in expired, another failure doesn't", async () => {
  for (const [status, signIn] of [[401, "expired"], [403, undefined], [500, undefined]]) {
    const seen = [];
    globalThis.fetch = async (url) => {
      seen.push(url);
      return new Response("{}", { status });
    };
    const hooks = await CopilotAuthPlugin({ client: { auth: { set: async () => assert.fail("saved a refused exchange") } } });
    const loader = await hooks.auth.loader(async () => signedIn({ access: "", expires: 0 }), { models: {} });
    const err = await loader.fetch(`${loader.baseURL}/responses`, { body: "{}", headers: {} }).then(() => undefined, (e) => e);
    assert.ok(err, `HTTP ${status} went through`);
    assert.equal(err.signIn, signIn);
    assert.match(err.message, new RegExp(String(status)));
    assert.ok(!err.message.includes("mock-github-oauth"));
    assert.equal(seen.length, 1);
  }
});
