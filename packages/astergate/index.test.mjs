import assert from "node:assert/strict";
import { constants, createDecipheriv, generateKeyPairSync, privateDecrypt } from "node:crypto";
import { test } from "node:test";
import asterMagpie from "./index.mjs";

const origin = "https://beta.astergate.cc";
const auth = { type: "api", key: "fixture-key" };
const getAuth = async () => auth;

test("usage logs in with JWE and reports each Claude window without routing on it", async (t) => {
  const challenge = "a".repeat(64);
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const paths = [];
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(input);
    paths.push(url.pathname);
    assert.equal(url.origin, origin);
    assert.equal(init.redirect, "error");
    assert.equal(init.headers["x-usage-origin"], origin);
    assert.equal(init.headers["x-usage-client"], "1");
    assert.equal(init.headers.authorization, undefined);
    if (url.pathname.endsWith("/challenge")) {
      assert.equal(init.method, "POST");
      assert.equal(init.headers.origin, origin);
      return Response.json({ challenge, public_key: publicKey.export({ type: "spki", format: "der" }).toString("base64url") });
    }
    if (url.pathname.endsWith("/login")) {
      const { challenge: echoed, jwe } = JSON.parse(init.body);
      assert.equal(echoed, challenge);
      const [protectedHeader, wrappedKey, iv, ciphertext, tag] = jwe.split(".");
      const decode = (value) => Buffer.from(value, "base64url");
      assert.deepEqual(JSON.parse(decode(protectedHeader)), { alg: "RSA-OAEP-256", enc: "A256GCM" });
      const contentKey = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, decode(wrappedKey));
      const aes = createDecipheriv("aes-256-gcm", contentKey, decode(iv));
      aes.setAAD(Buffer.from(protectedHeader));
      aes.setAuthTag(decode(tag));
      const plaintext = Buffer.concat([aes.update(decode(ciphertext)), aes.final()]);
      assert.deepEqual(JSON.parse(plaintext), { key: auth.key, challenge, origin });
      return new Response(null, { headers: { "set-cookie": "session=fake; Path=/usage-session; Secure; HttpOnly" } });
    }
    assert.equal(init.headers.cookie, "session=fake");
    assert.equal(url.searchParams.get("timezone"), "UTC");
    return Response.json({
      accounts: [
        { provider: "claude", windows: [{ kind: "five_hour", used_ratio: 0.2, resets_at: "2026-11-22T00:00:00Z" }] },
        { provider: "claude", windows: [{ kind: "weekly", used_ratio: 0 }, { kind: "five_hour", used_ratio: null }] },
        { provider: "codex", windows: [{ kind: "weekly", used_ratio: 0.9 }] },
      ],
      budget: { weekly: { limit_usd: 100, spent_usd: 30 } },
    });
  });
  const plugin = await asterMagpie();
  const result = await plugin.auth.usage(getAuth);
  assert.deepEqual(paths, ["/usage-session/challenge", "/usage-session/login", "/usage-session/report"]);
  assert.deepEqual(result.windows.map(({ name, used, span, aside }) => [name, used, span, aside]), [
    ["5 小时 · Claude 1", 20, 18_000, true],
    ["每周 · Claude 2", 0, 604_800, true],
    ["Key 每周预算", 30, 604_800, true],
  ]);
  assert.equal(result.windows[0].resetsAt, "2026-11-22T00:00:00Z");
  assert.equal(result.windows[0].display, "剩余 80%");
});

test("model discovery and Messages only send the key to AsterGate", async (t) => {
  const stream = new Response("event: message_stop\ndata: {}\n\n", {
    headers: { "content-type": "text/event-stream" },
  });
  t.mock.method(globalThis, "fetch", async (input, init) => {
    assert.equal(init.redirect, "error");
    assert.equal(new Headers(init.headers).get("x-api-key"), auth.key);
    if (input === origin + "/v1/models") {
      return Response.json({ data: [{ id: "claude-test", display_name: "Claude Test" }, { id: "gpt-test" }] });
    }
    assert.equal(input, origin + "/v1/messages?beta=true");
    assert.deepEqual([...init.headers], [
      ["anthropic-beta", "test"], ["anthropic-version", "2023-06-01"], ["x-api-key", auth.key],
    ]);
    assert.equal(init.body, '{"stream":true}');
    return stream;
  });
  const plugin = await asterMagpie();
  const config = {};
  await plugin.config(config);
  assert.equal(config.provider.astergate.npm, "@ai-sdk/anthropic");
  const models = await plugin.provider.models(config.provider.astergate, { auth });
  assert.deepEqual(Object.keys(models), ["claude-test"]);
  assert.equal(models["claude-test"].api.url, origin + "/v1");
  const loader = await plugin.auth.loader(getAuth);
  assert.equal(await loader.fetch(origin + "/v1/messages?beta=true", {
    headers: { "anthropic-beta": "test", authorization: "Bearer downstream" },
    body: '{"stream":true}',
  }), stream);
  await assert.rejects(loader.fetch("https://example.com/v1/messages"), /destination/);
});

test("quota transport failures and a rejected model key have distinct sign-in states", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 401 }));
  const plugin = await asterMagpie();
  assert.deepEqual(await plugin.auth.usage(getAuth), {
    error: "AsterGate usage challenge returned HTTP 401", signIn: "kept",
  });
  await assert.rejects(plugin.provider.models({}, { auth }), { signIn: "expired" });
});
