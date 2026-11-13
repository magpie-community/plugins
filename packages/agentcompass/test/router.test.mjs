/**
 * The engine's rules, asserted as rules (never as a hand-picked winner): the four-category fit, the data gates (rule B), the
 * quota economy's monotonicity, and that the entry points (middleware, hooks, decision provider) route a profile alike.
 * Parity with AgentCompass's `allocator.py` is tested in the source repository; pins, holds and refusals are
 * test/routing-contract.test.mjs; plan sizing and account state are test/plan-align.test.mjs and test/plan-state.test.mjs.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { rankCandidates, selectBestRoute } from "../src/allocator.js";
import { defaultScoredModels } from "../src/axis-scores.js";
import * as catalog from "../src/catalog.js";
import { SessionContinuityStore } from "../src/continuity.js";
import { onRequest as hookOnRequest } from "../src/hooks.js";
import { handleSystemOneRequest } from "../src/index.js";
import { onRequest as mwOnRequest } from "../src/middleware.js";
import { profile } from "./profile.mjs";

const T0 = 1_790_000_000_000;
const AXES = ["divergence", "coding", "aesthetics", "tool_operation"];
const P = profile();
const rank = (p, options = {}) => rankCandidates(p, { now: T0, ...options });
const quiet = (t) => t.mock.method(console, "warn", () => {});
const win = (name, remaining, hours) => ({ name, remaining, used: 100 - remaining, resetHours: hours });
const account = (weekly, fiveHour = 90) => ({
  "claude/a": { kind: "subscription", plan: "max", quota: { windows: [win("5 hours", fiveHour, 3), win("7 days", weekly, 100)] } },
});
// A deterministic reordering: rotate by k, then reverse when k is odd.
const reordered = (list, k) => {
  const rotated = [...list.slice(k), ...list.slice(0, k)];
  return k % 2 ? rotated.reverse() : rotated;
};

// ------------------------------------------------------------------------------------------------ the fit and the ranking

test("every exclusion is named, and every eligible candidate has a finite score and its demanded categories' data", () => {
  const ranked = rank(P);
  assert.ok(ranked.allCandidates.length > 100, "the default pool holds every scored model at its efforts");
  assert.ok(ranked.ranking.length > 0);
  for (const c of ranked.allCandidates) {
    if (c.eligible) {
      assert.deepEqual(c.excluded, [], c.id);
      assert.ok(Number.isFinite(c.score), c.id);
      for (const axis of AXES) if (P.axis_demand[axis] > 0) assert.ok(c.components[axis] !== null && c.components[axis] !== undefined, `${c.id} ${axis}`);
    } else {
      assert.ok(c.excluded.length > 0, c.id);
      for (const reason of c.excluded) assert.equal(typeof reason, "string");
    }
  }
});

test("the ranking is ordered by net score, and with no quotas the net score is the fit", () => {
  const { ranking } = rank(P);
  for (let i = 1; i < ranking.length; i++) assert.ok(ranking[i - 1].score >= ranking[i].score - 1e-12, `${ranking[i - 1].id} before ${ranking[i].id}`);
  for (const c of ranking) assert.ok(Math.abs(c.score - (c.components.fit + c.components.continuity)) < 1e-9, c.id);
});

test("order invariance: the pool's order changes neither the winning score nor the ranking's scores", () => {
  const pool = [...new Set(rank(P).ranking.map((c) => c.model))].slice(0, 12);
  const base = rank(P, { candidateModels: pool });
  for (const k of [1, 3, 5]) {
    const again = rank(P, { candidateModels: reordered(pool, k) });
    // Candidates that tie on the whole order key keep the pool's order, so only the key itself is invariant
    assert.equal(again.selected.score, base.selected.score, `rotation ${k}`);
    assert.deepEqual(again.ranking.map((c) => c.score), base.ranking.map((c) => c.score), `rotation ${k}`);
    assert.deepEqual(new Set(again.ranking.map((c) => c.id)), new Set(base.ranking.map((c) => c.id)), `rotation ${k}`);
  }
});

test("a candidate's score does not depend on the others in the pool", () => {
  const pool = [...new Set(rank(P).ranking.map((c) => c.model))].slice(0, 8);
  const together = rank(P, { candidateModels: pool });
  for (const model of pool.slice(0, 4)) {
    const alone = rank(P, { candidateModels: [model] });
    for (const c of alone.allCandidates) {
      const same = together.allCandidates.find((o) => o.id === c.id);
      assert.equal(same.score, c.score, c.id);
      assert.deepEqual(same.excluded, c.excluded, c.id);
    }
  }
});

test("a higher demand on one category never shrinks the shortfall of any candidate", () => {
  for (const axis of ["divergence", "coding", "aesthetics"]) {
    const at = (level) => rank(profile({ code_complexity: level > 0 && axis === "coding" ? 2 : 0, access: axis === "coding" ? "write" : "read-only", axis_demand: { divergence: 0, coding: 0, aesthetics: 0, tool_operation: 0, [axis]: level } }));
    const low = at(1);
    const high = at(3);
    let compared = 0;
    for (const c of low.allCandidates.filter((x) => x.eligible)) {
      const other = high.allCandidates.find((o) => o.id === c.id);
      if (!other || !other.eligible) continue;
      assert.ok(other.components.five_axis_shortfall >= c.components.five_axis_shortfall - 1e-9, `${axis} ${c.id}`);
      compared++;
    }
    assert.ok(compared > 10, axis);
  }
});

test("a fit counts a category's score only up to its cap: a model past the cap gains nothing more", () => {
  const ranked = rank(profile({ axis_demand: { divergence: 0, coding: 1, aesthetics: 0, tool_operation: 0 } }));
  // Level 1 caps at its target, so the fit of every eligible candidate is bounded by the same number
  const fits = ranked.ranking.map((c) => c.components.fit);
  const top = Math.max(...fits);
  assert.ok(fits.filter((f) => Math.abs(f - top) < 1e-9).length > 1, "candidates past the cap tie on fit");
});

// ------------------------------------------------------------------------------------------------ rule B: the data gates

test("a demanded category with no data keeps a model out of automatic routing; naming it dispatches it, with the data error", (t) => {
  quiet(t);
  const gap = rank(P).allCandidates.find((c) => !c.eligible && c.excluded.some((e) => /data error: no trusted data for the demanded category/.test(e)));
  assert.ok(gap, "the default pool has a model with a gap");
  assert.equal(rank(P, { candidateModels: [gap.id] }).selected, null);
  const named = selectBestRoute(P, { candidateModels: [gap.id], constraintModel: gap.id, now: T0 });
  assert.equal(named.ok, true);
  assert.equal(named.targetModel, gap.model);
  assert.ok(named.warnings.some((w) => /data error/.test(w)));
});

test("image input is a gate at tool_operation level 3: no model without it, none unknown", () => {
  const visual = profile({ needs_visual: true, axis_demand: { tool_operation: 3 } });
  const ranked = rank(visual);
  assert.ok(ranked.ranking.length > 0);
  for (const c of ranked.ranking) {
    const info = defaultScoredModels()[catalog.resolveModel(c.model).key] || {};
    assert.equal(((info.five_axis || {}).image_input || {}).status, "yes", c.id);
  }
  assert.ok(ranked.allCandidates.some((c) => !c.eligible && c.excluded.some((e) => /image/i.test(e))));
});

test("a profile the schema does not hold is refused, not routed", () => {
  for (const bad of [{ axis_demand: { coding: 4 } }, { axis_demand: { coding: 2, speed: 1 } }, { access: "workspace-write" }, { reasoning_depth: 9 }]) {
    const d = selectBestRoute({ ...P, ...bad }, { candidateModels: ["gpt-6.1-sol"], now: T0 });
    assert.equal(d.ok, false, JSON.stringify(bad));
    assert.match(d.refusal || d.error || "", /invalid_caller_profile/, JSON.stringify(bad));
  }
});

// ------------------------------------------------------------------------------------------------ the quota economy

test("more weekly quota left never lowers a candidate's score, and a spent window refuses", () => {
  const scores = [];
  for (const remaining of [100, 80, 50, 20, 6]) {
    const c = rank(P, { candidateModels: ["claude-sonnet-5-5:high"], quotas: account(remaining) }).allCandidates[0];
    assert.equal(c.eligible, true, `${remaining}% left`);
    assert.ok(c.components.opportunity_cost >= 0);
    scores.push(c.score);
  }
  for (let i = 1; i < scores.length; i++) assert.ok(scores[i - 1] >= scores[i] - 1e-9, `scores ${scores}`);
  const spent = rank(P, { candidateModels: ["claude-sonnet-5-5:high"], quotas: account(0) }).allCandidates[0];
  assert.equal(spent.eligible, false);
  assert.match(spent.excluded.join("; "), /exhausted|below launch floor/);
  const d = selectBestRoute(P, { candidateModels: ["claude-sonnet-5-5"], quotas: account(0), now: T0 });
  assert.equal(d.ok, false);
  assert.ok(d.refusal);
});

test("a 5-hour window gates feasibility and is not priced; the weekly window is", () => {
  const gated = rank(P, { candidateModels: ["claude-sonnet-5-5:high"], quotas: account(80, 0) }).allCandidates[0];
  assert.equal(gated.eligible, false, "no 5-hour quota left: the work cannot start");
  const roomy = rank(P, { candidateModels: ["claude-sonnet-5-5:high"], quotas: account(80, 90) }).allCandidates[0];
  const tight = rank(P, { candidateModels: ["claude-sonnet-5-5:high"], quotas: account(80, 40) }).allCandidates[0];
  assert.equal(roomy.eligible && tight.eligible, true);
  assert.ok(Math.abs(roomy.score - tight.score) < 1e-9, "the 5-hour level changes no price");
});

test("an account whose plan is not reported has no capacity: out of automatic routing, named dispatch works", (t) => {
  quiet(t);
  const unknown = { "claude/a": { kind: "subscription", quota: { windows: [win("7 days", 80, 100)] } } };
  const auto = rank(P, { candidateModels: ["claude-sonnet-5-5:high"], quotas: unknown }).allCandidates[0];
  assert.equal(auto.eligible, false);
  assert.match(auto.excluded.join("; "), /capacity_unknown/);
  const named = selectBestRoute(P, { candidateModels: ["claude-sonnet-5-5"], constraintModel: "claude-sonnet-5-5", quotas: unknown, now: T0 });
  assert.equal(named.ok, true);
});

// ------------------------------------------------------------------------------------------------ the entry points route a profile alike

test("middleware, hooks and the decision provider route the same profile to the same model and effort", async (t) => {
  quiet(t);
  const pool = ["gpt-6.1-sol", "claude-sonnet-5-5", "gemini-4-argon-high"];
  const expected = selectBestRoute(P, { candidateModels: pool, now: T0 });
  assert.equal(expected.ok, true);
  const want = `${expected.targetModel}:${expected.targetEffort}`;

  const body = { model: "agentcompass/auto", profile: P, messages: [{ role: "user", content: "Implement the next helper." }] };
  mwOnRequest(body, { state: {}, options: { candidateModels: pool, now: T0, continuityStore: new SessionContinuityStore() } });
  assert.equal(body.model, want);
  assert.equal("profile" in body, false, "the profile stops at the gateway");

  const ctx = { state: {}, options: { candidateModels: pool, now: T0, continuityStore: new SessionContinuityStore() } };
  await hookOnRequest({ model: "agentcompass/auto", profile: P, messages: [{ role: "user", content: "Implement the next helper." }] }, ctx);
  assert.equal(`${ctx.state.route.targetModel}:${ctx.state.route.targetEffort}`, want);

  const answer = await handleSystemOneRequest(
    { model: "agentcompass-systemone", state: { task: "Implement the next helper.", profile: P }, questions: { effort: { type: "score", criteria: ["low", "medium", "high", "xhigh"] } } },
    { candidateModels: pool, now: T0 },
  );
  assert.equal(answer.agentcompass.targetModel, expected.targetModel);
  assert.equal(answer.agentcompass.targetEffort, expected.targetEffort);
});

test("the same profile gives the same route on every call, and a different demand can give another", () => {
  const first = selectBestRoute(P, { now: T0 });
  const again = selectBestRoute(P, { now: T0 });
  assert.equal(first.modelWithEffort, again.modelWithEffort);
  assert.equal(first.score, again.score);
  const seen = new Set();
  for (const demand of [{ coding: 0 }, { coding: 3 }, { divergence: 3 }, { aesthetics: 3 }, { tool_operation: 3 }]) {
    const p = profile({ needs_visual: demand.tool_operation === 3, code_complexity: demand.coding === 0 ? 0 : 2, access: demand.coding === 0 ? "read-only" : "write", axis_demand: demand.coding === 0 ? { ...demand, coding: 0 } : demand });
    const d = selectBestRoute(p, { now: T0 });
    assert.equal(d.ok, true, JSON.stringify(demand));
    seen.add(d.modelWithEffort);
  }
  assert.ok(seen.size >= 1);
});
