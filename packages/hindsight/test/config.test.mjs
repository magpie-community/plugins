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
