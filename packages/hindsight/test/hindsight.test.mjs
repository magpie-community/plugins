import test from "node:test";
import assert from "node:assert/strict";
import { ApiError, authHeaders, credential, Hindsight, recallTimeoutMs } from "../lib/hindsight.mjs";
import { configuration } from "../lib/config.mjs";

const config = extra => configuration(extra);

test("auth headers are absent unless a key is configured", () => {
  assert.deepEqual(authHeaders(config(), {}), {});
  assert.deepEqual(authHeaders(config({ api_key: "abc123" })), { Authorization: "Bearer abc123" });
  assert.deepEqual(authHeaders(config({ api_key: "abc123", api_key_header: "X-Api-Key", api_key_prefix: "" })), { "X-Api-Key": "abc123" });
  assert.deepEqual(authHeaders(undefined), {});
});

test("an environment variable can hold the credential instead of the options file", () => {
  const env = { HINDSIGHT_AUTHORIZATION: "env-token" };
  const fromEnv = config({ authorizationEnv: "HINDSIGHT_AUTHORIZATION" });
  assert.deepEqual(authHeaders(fromEnv, env), { Authorization: "Bearer env-token" });
  // An explicit key still wins, so a stale variable cannot shadow it.
  assert.equal(credential(config({ authorizationEnv: "HINDSIGHT_AUTHORIZATION", api_key: "explicit" }), env), "Bearer explicit");
  // A value that already carries a scheme is not doubled.
  assert.equal(credential(fromEnv, { HINDSIGHT_AUTHORIZATION: "Bearer pasted" }), "Bearer pasted");
  // An unset or empty variable authenticates nothing.
  assert.equal(credential(fromEnv, {}), "");
  assert.equal(credential(fromEnv, { HINDSIGHT_AUTHORIZATION: "   " }), "");
  assert.equal(credential(config(), env), "");
});

test("recall and retain send the configured credential", async () => {
  const seen = [];
  const fetcher = async (url, init) => {
    seen.push({ url, headers: init.headers });
    return url.endsWith("/memories/recall")
      ? Response.json({ results: [{ text: "memory one" }] })
      : Response.json({ success: true });
  };
  const client = new Hindsight(config({ api_key: "sk-test", capture: true }), fetcher);

  assert.deepEqual(await client.recall("q"), ["memory one"]);
  await client.retain("q", "a", "doc-1", "claude", "chat");

  assert.equal(seen.length, 2);
  for (const call of seen) {
    assert.equal(call.headers.Authorization, "Bearer sk-test");
    assert.equal(call.headers["User-Agent"], "magpie-hindsight/1.0.0");
    assert.equal(call.headers["Content-Type"], "application/json");
  }
  assert.equal(seen[0].headers["X-Api-Key"], undefined);
});

test("an unauthenticated Hindsight is reported as unauthorized, not invalid", async () => {
  const client = new Hindsight(config(), async () => Response.json({ error: "nope" }, { status: 401 }));
  await assert.rejects(() => client.recall("q"), error => error instanceof ApiError && error.code === "unauthorized");
});

test("recall timeout leaves the host a reserve without exceeding its budget", () => {
  assert.equal(recallTimeoutMs(5000), 4800);
  assert.equal(recallTimeoutMs(10000), 9800);
  // A 100 ms gateway budget cannot afford a fixed 200 ms reserve.
  const tiny = recallTimeoutMs(100);
  assert.ok(tiny < 100, `recall must finish before the gateway budget, got ${tiny}`);
  assert.ok(tiny >= 50);
  for (const budget of [100, 250, 1000, 5000, 10000]) {
    const timeout = recallTimeoutMs(budget);
    assert.ok(timeout > 0 && timeout < budget + 1, `bad timeout ${timeout} for budget ${budget}`);
  }
});
