/**
 * What the run on Magpie 0.1.4603 found, each tested as the rule it states (never a winner copied from output):
 *
 * 1. A request costs the same work at any turn of a session, on a runtime that never saw it: Magpie hands each request a pooled
 *    runtime (`internal/middleware/middleware.go` `mw.pool`) and stops `onRequest` at 250 ms (`requestLimit`). This is a test of the
 *    cause, not of the clock: the market runs `bun test` on shared runners, where a wall-clock bound would fail for a slow runner
 *    and pass a slow plugin on a fast one. It counts what the time scaled with: the reads of the catalogue's rows (each ranking of
 *    the pool reads every candidate's row), which grew with the turns `replayedState` decides again, and the lookups in the alias
 *    table (each name resolved anew reads it), which a request repeated every resolution for. The memo keys are the input itself.
 * 2. The converter leaves Magpie's routing groups out.
 * 3. A pin goes out under the name typed when the pool lists it on the route's preset.
 * 4. A bare row of a model that takes no effort goes out with none; the decision and the session keep the engine's effort.
 * 5. A hold on a state rebuilt from the message history says so, and names no earlier route.
 *
 * test/fixtures/magpie-v1-models-0.1.4603.json is the `GET /v1/models` answer of the real Magpie 0.1.4603 build in the sandbox run
 * (its own catalogue of the presets openai, anthropic, google, deepseek, mistral and opencode-zen, pointed at a local mock), with
 * the fields the converter reads.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { selectBestRoute } from "../src/allocator.js";
import { defaultScoredModels } from "../src/axis-scores.js";
import { MODELS, MODEL_ALIASES, PROVIDER_NAMES, canonicalModel, magpieOptions, resolveListed, resolveModel } from "../src/catalog.js";
import { SessionContinuityStore } from "../src/continuity.js";
import { holdJudge, onProvider, onRequest, routeDecider } from "../src/middleware.js";
import { GROUP_PREFIXES, candidatesFromModels } from "../scripts/candidates-from-models.mjs";
import { profile } from "./profile.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LISTING = JSON.parse(fs.readFileSync(path.join(REPO, "test", "fixtures", "magpie-v1-models-0.1.4603.json"), "utf8"));
const POOL = candidatesFromModels(LISTING);
const PROFILE = profile();
const quiet = (fn) => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    return fn();
  } finally {
    console.warn = warn;
  }
};
const reject = (status, message) => ({ rejected: status, message });

/** A conversation of `turn` user turns, the history a client resends: the same at every turn. */
function conversation(first, turn) {
  const messages = [{ role: "user", content: first }];
  for (let i = 2; i <= turn; i++) messages.push({ role: "assistant", content: "ok" }, { role: "user", content: `step ${i}` });
  return messages;
}

test("a request reads the pool's rows a bounded number of times at any turn, and resolves no name twice, on a runtime that never saw the session", () => {
  // The shipped scored rows and aliases, given as the host's own catalogue so every read of a row and every lookup of a name in the
  // alias table is counted; routing is the same. Magpie's default (no catalogue in the options) reads the same tables as module
  // constants, so a memo keyed by the tables lives as long there.
  let reads = 0;
  let lookups = 0;
  const models = new Proxy(defaultScoredModels(), {
    get(target, key, receiver) {
      if (typeof key === "string") reads++;
      return Reflect.get(target, key, receiver);
    },
  });
  const counted = (bump) => ({
    get: (target, key, receiver) => (typeof key === "string" && bump(), Reflect.get(target, key, receiver)),
    has: (target, key) => (bump(), Reflect.has(target, key)),
    getOwnPropertyDescriptor: (target, key) => (bump(), Reflect.getOwnPropertyDescriptor(target, key)),
  });
  const aliases = new Proxy({ ...MODEL_ALIASES }, counted(() => lookups++));
  const options = { injectProtocolEffort: true, candidateModels: POOL, catalog: { models, aliases, providerNames: PROVIDER_NAMES } };
  const pins = ["anthropic/claude-opus-5-5", "claude-opus-5-5", "opencode-zen/claude-opus-5-5", "claude-opus-5-5"];
  const cost = ({ affinityMode, pinned }, turn) => {
    const body = { model: "agentcompass/auto", profile: PROFILE, messages: conversation(`a session (${affinityMode || "cache"})`, turn) };
    if (pinned && turn <= pins.length) body.pinned_model = pins[turn - 1];
    // A store of its own per request: the runtime serving it never saw the session, so its earlier turns are decided again.
    const ctx = { protocol: "chat", state: {}, reject, options: { ...options, ...(affinityMode ? { affinityMode } : {}), continuityStore: new SessionContinuityStore() } };
    reads = 0;
    lookups = 0;
    quiet(() => onRequest(body, ctx));
    assert.ok(ctx.state.route?.targetModel, `turn ${turn} routed`);
    return { reads, lookups };
  };
  // The first request on these tables resolves its names; every later one finds them resolved (a name resolved anew reads the
  // alias table at each step of its spellings, so a request that resolved every name again read it about 8,000 times).
  const first = cost({}, 1).lookups;
  assert.ok(first > 0, "the first request resolves names");
  for (const session of [{}, { affinityMode: "session", pinned: true }]) {
    const one = cost(session, 1).reads;
    assert.ok(one > POOL.length, `a ranking reads every candidate's row (${one} reads, ${POOL.length} rows)`);
    for (let turn = 2; turn <= 8; turn++) {
      // At most two rankings (the turn the replay starts from, and the one after it) whatever the turn; a pin's hold is judged
      // once. Before, each replayed turn ranked the pool again: turn k read about min(k, 5) times as much as turn 1.
      const { reads: reading, lookups: looked } = cost(session, turn);
      assert.ok(reading <= 2.5 * one, `${JSON.stringify(session)} turn ${turn}: ${reading} reads, ${one} at turn 1`);
      assert.ok(looked <= first / 10, `${JSON.stringify(session)} turn ${turn}: ${looked} alias lookups, ${first} on the first request`);
    }
  }
});

test("the converter leaves Magpie's routing groups out, naming each, and keeps their members", () => {
  const listing = { data: [...LISTING.data, { id: "group/my-coding-group", owned_by: "magpie", reasoning_levels: ["low", "high"] }] };
  const warnings = [];
  const rows = candidatesFromModels(listing, (message) => warnings.push(message));
  const groups = listing.data.filter((m) => GROUP_PREFIXES.some((prefix) => m.id.startsWith(prefix)));
  assert.ok(groups.some((m) => m.id.startsWith("auto/")) && groups.some((m) => m.id.startsWith("group/")), "the listing has both kinds of group");
  for (const m of groups) {
    assert.ok(!rows.some((r) => r.model === m.id), `${m.id} is no candidate`);
    assert.ok(warnings.some((w) => w.includes(m.id)), `${m.id} is named on stderr`);
  }
  assert.equal(rows.length, listing.data.length - groups.length, "every other row is kept");
  // A found group's model is offered by the providers that list it, each a row of its own (internal/provider/group.go: one model
  // several providers serve).
  for (const m of groups.filter((g) => g.id.startsWith("auto/"))) {
    const model = m.id.slice("auto/".length);
    assert.ok(rows.some((r) => r.model.endsWith(`/${model}`)), `${model} is offered by its providers' rows`);
  }
});

test("a pin goes out under the name typed when the pool lists it on the route's preset, in either pool order", () => {
  // Magpie's own catalogue lists the deepseek preset's flash row under two names.
  const listings = ["deepseek/deepseek-flash", "deepseek/deepseek-v4-flash"];
  const rows = POOL.filter((r) => listings.includes(r.model));
  assert.equal(rows.length, 2);
  assert.equal(canonicalModel(listings[0]), canonicalModel(listings[1]), "one row, two listings");
  const sent = (pool, pin) => {
    const body = { model: "agentcompass/auto", profile: PROFILE, messages: [{ role: "user", content: `pin ${pin}` }], ...(pin ? { pinned_model: pin } : {}) };
    quiet(() => onRequest(body, { protocol: "chat", state: {}, reject, options: { injectProtocolEffort: true, candidateModels: pool } }));
    return body.model;
  };
  for (const pool of [rows, [...rows].reverse()]) {
    for (const listing of listings) {
      for (const typed of [listing, listing.toUpperCase(), `${listing}:low`, listing.slice("deepseek/".length)]) {
        assert.match(sent(pool, typed), new RegExp(`^${listing.replace(/[.]/g, "\\.")}:`), `${typed} over [${pool.map((r) => r.model)}]`);
      }
    }
    // With no name typed the choice among listings is the ranking's.
    const ranked = quiet(() => selectBestRoute(PROFILE, { candidateModels: pool, catalog: magpieOptions({}).catalog }));
    assert.equal(sent(pool, null).split(":")[0], ranked.targetModel);
  }
});

test("a bare row of a model that takes no effort (a cited operating point) goes out with none; a row that lists its efforts as routed", () => {
  const name = "ministral-8b-2512";
  assert.ok(MODELS[name]?.operating_point, `${name} is a declared operating point`);
  const send = (model, options) => {
    const body = { model, profile: PROFILE, messages: [{ role: "user", content: `write a function (${model})` }] };
    const ctx = { protocol: "chat", state: {}, reject, options: { injectProtocolEffort: true, ...options } };
    quiet(() => onRequest(body, ctx));
    const tried = JSON.parse(JSON.stringify(body));
    quiet(() => onProvider(tried, { ...ctx, provider: { id: "mistral", name: "Mistral", model: name } }));
    return { onRequest: body, onProvider: tried, route: ctx.state.route };
  };
  // modelsByProvider: the preset's own list, a bare name; the request names the model (routeAllModels).
  const bare = send(`mistral/${name}`, { modelsByProvider: { mistral: [name] }, routeAllModels: true });
  for (const [hook, body] of [["onRequest", bare.onRequest], ["onProvider", bare.onProvider]]) {
    assert.ok(!body.model.includes(":"), `${hook}: ${body.model} carries no effort`);
    assert.equal(body.reasoning_effort, undefined, `${hook}: no reasoning_effort`);
  }
  // Only what is sent: the decision keeps the effort the engine routed at, the bundle's.
  assert.notEqual(bare.route.targetEffort, "default");
  assert.equal(bare.route.sentEffort, "default");
  // A row whose efforts are given (the operator's list, or a converter row of Magpie's levels) runs at those.
  const listed = send("agentcompass/auto", { candidateModels: [{ model: `mistral/${name}`, efforts: ["low"] }] });
  assert.equal(listed.onRequest.model, `mistral/${name}:low`);
  // A bare row of a model that takes efforts is sent at the one routed.
  const reasoning = send("agentcompass/auto", { candidateModels: ["openai/gpt-6-sol"] });
  assert.ok(!MODELS["gpt-6-sol"]?.operating_point);
  assert.equal(reasoning.onRequest.model, `openai/gpt-6-sol:${reasoning.route.targetEffort}`);
});

test("a pinned bare row of a model that takes no effort stays held over a session's turns, on one runtime and on fresh ones, at the engine's effort", () => {
  const name = "mistral/ministral-8b-2512";
  const pool = [name, "openai/gpt-6-sol"];
  for (const runtime of ["one", "fresh"]) {
    const shared = new SessionContinuityStore();
    const messages = [{ role: "user", content: `a session on ${name} (${runtime})` }];
    for (let turn = 1; turn <= 8; turn++) {
      if (turn > 1) messages.push({ role: "assistant", content: "ok" }, { role: "user", content: `step ${turn}` });
      const body = { model: "agentcompass/auto", profile: PROFILE, messages: [...messages], pinned_model: name };
      const ctx = { protocol: "chat", state: {}, reject, options: { injectProtocolEffort: true, candidateModels: pool, affinityMode: "session", continuityStore: runtime === "one" ? shared : new SessionContinuityStore() } };
      quiet(() => onRequest(body, ctx));
      const route = ctx.state.route;
      assert.equal(body.model, name, `${runtime} turn ${turn}: sent bare`);
      assert.equal(route.continuation.held, turn > 1, `${runtime} turn ${turn}: ${route.continuation.why}`);
      // The decision is the engine's: the effort it ranked at, the bundle's own, never the send-time configuration.
      const engine = selectBestRoute(PROFILE, { candidateModels: pool, constraintModel: name });
      assert.equal(route.targetEffort, engine.targetEffort, `${runtime} turn ${turn}: the engine's effort`);
      assert.equal(route.bundle?.effort ?? route.targetEffort, route.targetEffort, `${runtime} turn ${turn}: the bundle agrees`);
      assert.equal(route.sentEffort, "default");
    }
  }
  // An effort the caller names is sent as named.
  const body = { model: "agentcompass/auto", profile: PROFILE, messages: [{ role: "user", content: "named effort" }], pinned_model: `${name}:low` };
  quiet(() => onRequest(body, { protocol: "chat", state: {}, reject, options: { injectProtocolEffort: true, candidateModels: pool, continuityStore: new SessionContinuityStore() } }));
  assert.equal(body.model, `${name}:low`);
});

test("a typed listing the ranking leaves out is not sent: the route stays the engine's and the decision says why", () => {
  const L1 = "deepseek/deepseek-flash";
  const L2 = "deepseek/deepseek-v4-flash";
  assert.ok(PROFILE.primary_level > 1);
  for (const pool of [
    [{ model: L1, efforts: ["high"] }, { model: L2, efforts: ["high"], when: { max_primary_level: 1 } }],
    [{ model: L2, efforts: ["high"], when: { max_primary_level: 1 } }, { model: L1, efforts: ["high"] }],
  ]) {
    const body = { model: "agentcompass/auto", profile: PROFILE, messages: [{ role: "user", content: "typed, left out" }], pinned_model: L2 };
    const ctx = { protocol: "chat", state: {}, reject, options: { injectProtocolEffort: true, candidateModels: pool, continuityStore: new SessionContinuityStore() } };
    quiet(() => onRequest(body, ctx));
    const route = ctx.state.route;
    const engine = selectBestRoute(PROFILE, { candidateModels: pool, constraintModel: L2 });
    assert.equal(route.targetModel, engine.targetModel, "the engine's route");
    assert.ok(!(route.excluded || []).some((line) => line.startsWith(`${route.bundle.model}@`)), "the decision's bundle is not one it excludes");
    assert.ok(route.warnings.some((w) => w.includes(L2) && w.includes(route.targetModel)), "the decision names the listing typed and the one sent");
  }
});

test("a hold on a state rebuilt from the message history says so and names no earlier route; one from the runtime's own record names it", () => {
  const pool = ["openai/gpt-6-sol", "deepseek/deepseek-v4-flash"];
  const shared = new SessionContinuityStore();
  for (const runtime of ["one", "fresh"]) {
    const messages = [{ role: "user", content: `pinned first (${runtime})` }];
    const logged = [];
    for (let turn = 1; turn <= 3; turn++) {
      if (turn > 1) messages.push({ role: "assistant", content: "ok" }, { role: "user", content: `step ${turn}` });
      const body = { model: "agentcompass/auto", profile: PROFILE, messages: [...messages], ...(turn === 1 ? { pinned_model: "deepseek/deepseek-v4-flash" } : {}) };
      const ctx = { protocol: "chat", state: {}, reject, options: { candidateModels: pool, affinityMode: "session", continuityStore: runtime === "one" ? shared : new SessionContinuityStore() } };
      const warn = console.warn;
      console.warn = (line) => logged.push(String(line));
      try {
        onRequest(body, ctx);
      } finally {
        console.warn = warn;
      }
      const c = ctx.state.route.continuation;
      if (turn === 1) continue;
      assert.equal(c.held, true);
      if (runtime === "one") {
        assert.equal(c.stateFrom, "record");
        assert.ok(c.previousModel, "the route of the turn before, from the runtime's own record");
      } else {
        assert.equal(c.stateFrom, "history");
        assert.equal(c.previousModel, null, "no claim of the route an earlier turn ran on");
        assert.match(c.notice, /message history/);
        assert.ok(logged.some((line) => line.includes(c.notice)), "Magpie's log says it too");
      }
    }
  }
});

test("the per-request memos are keyed by their whole input: the pins and the continuity", () => {
  const options = magpieOptions({});
  const pool = ["openai/gpt-6-sol", "deepseek/deepseek-v4-flash"];
  const decide = routeDecider({ options, candidateModels: pool, liveQuotas: undefined, now: Date.now() });
  const none = { unhealthyModels: [], minContextTokens: 0, continuity: { previousModel: null, previousEffort: null, why: "first", cacheWarm: false } };
  const pinned = (model) => decide(PROFILE, { ...none, constraintModel: model }).targetModel;
  assert.notEqual(pinned("openai/gpt-6-sol"), pinned("deepseek/deepseek-v4-flash"), "another pin, another answer");
  // A held worker counts in the score (`workerOf`): the same request with a previous model is another input.
  const cold = decide(PROFILE, none);
  const warm = decide(PROFILE, { ...none, continuity: { ...none.continuity, previousModel: cold.targetModel, previousEffort: cold.targetEffort, why: "cold" } });
  const engine = selectBestRoute(PROFILE, { candidateModels: pool, catalog: options.catalog, continuity: { previousModel: cold.targetModel, previousEffort: cold.targetEffort, why: "cold", cacheWarm: false } });
  assert.equal(warm.score, engine.score, "the continuity reaches the ranking");
  assert.notEqual(warm.score, cold.score, "and changes it here");
  const judge = holdJudge(options, pool, undefined, Date.now());
  const held = { model: "openai/gpt-6-sol", target: "openai/gpt-6-sol", effort: cold.targetEffort, profile: PROFILE };
  assert.notEqual(judge({ constraintModel: "openai/gpt-6-sol" }, held), judge({ constraintModel: "deepseek/deepseek-v4-flash" }, held), "a hold is judged per pin");
});

test("resolving with no models table answers as an empty table does, whatever was resolved with the shipped one before", () => {
  for (const resolve of [resolveModel, resolveListed]) {
    resolve("gpt-6-sol", MODELS);
    assert.deepEqual({ ...resolve("gpt-6-sol", null) }, { ...resolve("gpt-6-sol", {}) });
    assert.equal(resolve("gpt-6-sol", null).source, "unknown");
  }
});
