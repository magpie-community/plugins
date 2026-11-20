/**
 * What the run on Magpie 0.1.4603 found, each tested as the rule it states (never a winner copied from output):
 *
 * 1. A request costs the same work at any turn of a session, on a runtime that never saw it: Magpie hands each request a pooled
 *    runtime (`internal/middleware/middleware.go` `mw.pool`) and stops `onRequest` at 250 ms (`requestLimit`). This is a test of the
 *    cause, not of the clock: the market runs `bun test` on shared runners, where a wall-clock bound would fail for a slow runner
 *    and pass a slow plugin on a fast one. It counts what the time scaled with: the reads of the catalogue's rows (each ranking of
 *    the pool reads every candidate's row), which grew with the turns `replayedState` decides again.
 * 2. The converter leaves Magpie's routing groups out.
 * 3. A pin goes out under the name typed when the pool lists it on the route's preset.
 * 4. A bare row of a model that takes no effort goes out with none.
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
import { MODELS, PROVIDER_NAMES, canonicalModel, magpieOptions } from "../src/catalog.js";
import { SessionContinuityStore } from "../src/continuity.js";
import { onProvider, onRequest } from "../src/middleware.js";
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

test("a request reads the pool's rows a bounded number of times at any turn, on a runtime that never saw the session", () => {
  // The shipped scored rows, given as the host's own catalogue so every read of a row is counted; routing is the same.
  let reads = 0;
  const models = new Proxy(defaultScoredModels(), {
    get(target, key, receiver) {
      if (typeof key === "string") reads++;
      return Reflect.get(target, key, receiver);
    },
  });
  const options = { injectProtocolEffort: true, candidateModels: POOL, catalog: { models, providerNames: PROVIDER_NAMES } };
  const pins = ["anthropic/claude-opus-5-5", "claude-opus-5-5", "opencode-zen/claude-opus-5-5", "claude-opus-5-5"];
  const cost = ({ affinityMode, pinned }, turn) => {
    const body = { model: "agentcompass/auto", profile: PROFILE, messages: conversation(`a session (${affinityMode || "cache"})`, turn) };
    if (pinned && turn <= pins.length) body.pinned_model = pins[turn - 1];
    // A store of its own per request: the runtime serving it never saw the session, so its earlier turns are decided again.
    const ctx = { protocol: "chat", state: {}, reject, options: { ...options, ...(affinityMode ? { affinityMode } : {}), continuityStore: new SessionContinuityStore() } };
    reads = 0;
    quiet(() => onRequest(body, ctx));
    assert.ok(ctx.state.route?.targetModel, `turn ${turn} routed`);
    return reads;
  };
  for (const session of [{}, { affinityMode: "session", pinned: true }]) {
    cost(session, 1); // names resolved once for the tables, as on a runtime that served a request before
    const one = cost(session, 1);
    assert.ok(one > POOL.length, `a ranking reads every candidate's row (${one} reads, ${POOL.length} rows)`);
    for (let turn = 2; turn <= 8; turn++) {
      // At most two rankings (the turn the replay starts from, and the one after it) whatever the turn; a pin's hold is judged
      // once. Before, each replayed turn ranked the pool again: turn k read about min(k, 5) times as much as turn 1.
      const reading = cost(session, turn);
      assert.ok(reading <= 2.5 * one, `${JSON.stringify(session)} turn ${turn}: ${reading} reads, ${one} at turn 1`);
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
    assert.ok(warnings.some((w) => w.includes(m.id) && /routing group/.test(w) && /unchecked/.test(w)), `${m.id} is named with why`);
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
  // A row whose efforts are given (the operator's list, or a converter row of Magpie's levels) runs at those.
  const listed = send("agentcompass/auto", { candidateModels: [{ model: `mistral/${name}`, efforts: ["low"] }] });
  assert.equal(listed.onRequest.model, `mistral/${name}:low`);
  // A bare row of a model that takes efforts is sent at the one routed.
  const reasoning = send("agentcompass/auto", { candidateModels: ["openai/gpt-6-sol"] });
  assert.ok(!MODELS["gpt-6-sol"]?.operating_point);
  assert.equal(reasoning.onRequest.model, `openai/gpt-6-sol:${reasoning.route.targetEffort}`);
});
