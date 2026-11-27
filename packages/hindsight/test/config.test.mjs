import test from "node:test";
import assert from "node:assert/strict";
import { agentAllowed, configuration, DEFAULTS } from "../lib/config.mjs";

test("defaults match the public contract", () => {
  const config = configuration();
  assert.equal(config.hindsight_api, "http://127.0.0.1:8888");
  assert.equal(config.bank, "hermes");
  assert.equal(config.recall_max_tokens, 1024);
  assert.equal(config.capture, false);
  assert.deepEqual(config.agents, []);
  assert.equal(config.gatewayTimeoutMs, 5000);
  assert.equal(DEFAULTS.capture, false);
  assert.equal(agentAllowed(config, undefined), true);
});

test("agents with native injection are skipped by default, can be force-enabled", () => {
  const open = configuration();
  assert.equal(agentAllowed(open, "claude"), true);
  assert.equal(agentAllowed(open, "hermes"), false);
  assert.equal(agentAllowed(open, "dsh"), false);
  const forced = configuration({ agents: ["hermes"] });
  assert.equal(agentAllowed(forced, "hermes"), true);
  assert.equal(agentAllowed(forced, "dsh"), false);
});

test("remote Hindsight API is opt-in, insecure remote HTTP needs a second opt-in", () => {
  const remote = { hindsight_api: "https://hindsight.example.com" };
  assert.throws(() => configuration(remote));
  assert.equal(configuration({ ...remote, allowRemote: true }).hindsight_api, "https://hindsight.example.com");
  const insecure = { hindsight_api: "http://hindsight.example.com" };
  assert.throws(() => configuration({ ...insecure, allowRemote: true }));
  assert.equal(configuration({ ...insecure, allowRemote: true, allowInsecureHttp: true }).hindsight_api, "http://hindsight.example.com");
  // Loopback needs no opt-in at all.
  assert.equal(configuration({ hindsight_api: "http://127.0.0.1:8888" }).allowRemote, false);
});

test("overrides are normalized without changing the bank id", () => {
  const config = configuration({
    hindsight_api: "http://localhost:8888/",
    bank: "hermes-dsh",
    recall_max_tokens: 256,
    capture: true,
    agents: ["Hermes Agent", "hermes agent", "DSH"],
    gatewayTimeoutMs: 5000
  });
  assert.equal(config.hindsight_api, "http://localhost:8888");
  assert.equal(config.bank, "hermes-dsh");
  assert.equal(config.recall_max_tokens, 256);
  assert.equal(config.capture, true);
  assert.deepEqual(config.agents, ["hermes agent", "dsh"]);
  assert.equal(config.gatewayTimeoutMs, 5000);
  assert.equal(agentAllowed(config, "HERMES AGENT"), true);
  assert.equal(agentAllowed(config, "other"), false);
});

test("invalid options fail closed", () => {
  const bad = [
    { hindsight_api: "file:///tmp/memory" },
    { hindsight_api: "http://user@localhost:8888" },
    { bank: "" },
    { bank: "hermes/dsh" },
    { recall_max_tokens: 0 },
    { recall_max_tokens: 1.5 },
    { capture: "true" },
    { agents: "all" },
    { agents: [""] },
    { gatewayTimeoutMs: 50 },
    { gatewayTimeoutMs: 10001 }
  ];
  for (const options of bad) assert.throws(() => configuration(options));
});

test("credentials are optional, well-formed and never repurpose request headers", () => {
  const open = configuration();
  assert.equal(open.api_key, "");
  assert.equal(open.api_key_header, "Authorization");
  assert.equal(open.api_key_prefix, "Bearer ");

  const keyed = configuration({ api_key: "secret-value", api_key_header: "X-Api-Key", api_key_prefix: "" });
  assert.equal(keyed.api_key, "secret-value");
  assert.equal(keyed.api_key_header, "X-Api-Key");
  assert.equal(keyed.api_key_prefix, "");

  for (const options of [
    { api_key: "a".repeat(513) },
    { api_key: "bad\nkey" },
    { api_key: "value", api_key_header: "bad header" },
    { api_key: "value", api_key_header: "" },
    { api_key: "value", api_key_header: "Content-Type" },
    { api_key: "value", api_key_header: "host" },
    { api_key_prefix: "Bearer\n" }
  ]) assert.throws(() => configuration(options), `expected rejection: ${JSON.stringify(options)}`);

  // A reserved header name is only a problem when it would actually be sent.
  assert.doesNotThrow(() => configuration({ api_key_header: "Content-Type" }));
});

test("the credential environment variable is a name, not a secret", () => {
  assert.equal(configuration().authorizationEnv, "");
  assert.equal(configuration({ authorizationEnv: "HINDSIGHT_AUTHORIZATION" }).authorizationEnv, "HINDSIGHT_AUTHORIZATION");
  assert.equal(configuration({ authorizationEnv: "_PRIVATE" }).authorizationEnv, "_PRIVATE");
  // null means "not provided" for every option, so it falls back to the default.
  for (const value of ["has space", "1LEADING", "dash-name", "a".repeat(129), 5, true])
    assert.throws(() => configuration({ authorizationEnv: value }), `expected rejection: ${String(value)}`);
});

test("max_replay_blocks defaults to a bounded window and rejects nonsense", () => {
  assert.equal(configuration().max_replay_blocks, 8);
  assert.equal(configuration({ max_replay_blocks: 0 }).max_replay_blocks, 0);
  assert.equal(configuration({ max_replay_blocks: 256 }).max_replay_blocks, 256);
  for (const value of [-1, 257, 1.5, "8", true]) assert.throws(() => configuration({ max_replay_blocks: value }));
});
