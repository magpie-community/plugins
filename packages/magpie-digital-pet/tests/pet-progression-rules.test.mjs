// tests/pet-progression-rules.test.mjs
// Contract for expeditions, daily goals and achievements (Task 3).

import assert from "node:assert/strict";

import {
  EXPEDITIONS,
  claimExpedition,
  createDefaultCareState,
  evaluateAchievements,
  evaluateDailyGoals,
  startExpedition,
} from "../lib/pet.care-rules.mjs";

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}`);
    console.error(error);
  }
}

function runningExpedition(overrides = {}) {
  return {
    expeditionId: "exp-p1-0",
    partnerId: "p1",
    kind: "patrol",
    status: "running",
    startedAt: 0,
    endsAt: 300_000,
    ...overrides,
  };
}

test("EXPEDITIONS lists the three tiers with exact durations and rewards", () => {
  assert.deepEqual(EXPEDITIONS, {
    patrol: { durationMs: 300_000, fragments: 3, bond: 1 },
    field: { durationMs: 900_000, fragments: 8, bond: 2 },
    night: { durationMs: 1_800_000, fragments: 15, bond: 3 },
  });
});

test("startExpedition refuses while another expedition is running", () => {
  const careState = createDefaultCareState("p1", 0);
  const result = startExpedition({ careState, activeExpedition: runningExpedition(), kind: "field", nowMs: 1000 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "expedition-active");
  assert.equal(result.expedition, undefined);
  assert.equal(result.careState, careState);
});

test("startExpedition refuses an unknown expedition kind", () => {
  const careState = createDefaultCareState("p1", 0);
  const result = startExpedition({ careState, activeExpedition: null, kind: "space", nowMs: 0 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unknown-expedition");
});

test("startExpedition requires at least 15 energy", () => {
  const tired = { ...createDefaultCareState("p1", 0), energy: 14 };
  const refused = startExpedition({ careState: tired, activeExpedition: null, kind: "patrol", nowMs: 0 });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "low-energy");
  assert.equal(refused.careState, tired);

  const rested = { ...createDefaultCareState("p1", 0), energy: 15 };
  const accepted = startExpedition({ careState: rested, activeExpedition: null, kind: "patrol", nowMs: 0 });
  assert.equal(accepted.ok, true);
});

test("startExpedition spends 10 energy and returns a running expedition without mutating input", () => {
  const careState = createDefaultCareState("p1", 0);
  const result = startExpedition({ careState, activeExpedition: null, kind: "field", nowMs: 5000 });
  assert.equal(result.ok, true);
  assert.equal(result.careState.energy, 70);
  assert.equal(result.careState.updatedAt, 5000);
  assert.equal(careState.energy, 80);

  const expedition = result.expedition;
  assert.equal(typeof expedition.expeditionId, "string");
  assert.equal(expedition.expeditionId.length > 0, true);
  assert.equal(expedition.partnerId, "p1");
  assert.equal(expedition.kind, "field");
  assert.equal(expedition.status, "running");
  assert.equal(expedition.startedAt, 5000);
  assert.equal(expedition.endsAt, 5000 + EXPEDITIONS.field.durationMs);
});

test("claimExpedition refuses before endsAt", () => {
  const expedition = runningExpedition();
  const result = claimExpedition({ expedition, nowMs: 299_999, random: () => 0 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "not-finished");
  assert.equal(result.reward, undefined);
});

test("claimExpedition refuses an already claimed expedition", () => {
  const expedition = runningExpedition({ status: "claimed" });
  const result = claimExpedition({ expedition, nowMs: 300_000, random: () => 0 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "already-claimed");
});

test("claimExpedition refuses when there is no expedition", () => {
  const result = claimExpedition({ expedition: null, nowMs: 300_000, random: () => 0 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no-expedition");
});

test("claimExpedition pays out the exact EXPEDITIONS reward at endsAt", () => {
  for (const [kind, def] of Object.entries(EXPEDITIONS)) {
    const expedition = runningExpedition({ kind, endsAt: def.durationMs });
    const result = claimExpedition({ expedition, nowMs: def.durationMs, random: () => 0 });
    assert.equal(result.ok, true);
    assert.equal(result.reward.fragments, def.fragments);
    assert.equal(result.reward.bond, def.bond);
    assert.equal(typeof result.reward.note, "string");
    assert.equal(result.reward.note.length > 0, true);
  }
});

test("claimExpedition is deterministic for the same random source", () => {
  const expedition = runningExpedition();
  const first = claimExpedition({ expedition, nowMs: 300_000, random: () => 0.42 });
  const second = claimExpedition({ expedition, nowMs: 300_000, random: () => 0.42 });
  assert.deepEqual(first.reward, second.reward);

  const other = claimExpedition({ expedition, nowMs: 300_000, random: () => 0.99 });
  assert.equal(other.ok, true);
});

test("evaluateDailyGoals applies the fixed 2 care / 1 expedition / 10 feed thresholds", () => {
  const goals = evaluateDailyGoals({ careEventsToday: 2, fedRequestsToday: 10, expeditionClaimsToday: 1 });
  assert.equal(goals.length, 3);
  const byId = Object.fromEntries(goals.map((goal) => [goal.id, goal]));
  assert.deepEqual(byId.care, { id: "care", target: 2, progress: 2, done: true });
  assert.deepEqual(byId.expedition, { id: "expedition", target: 1, progress: 1, done: true });
  assert.deepEqual(byId.feed, { id: "feed", target: 10, progress: 10, done: true });
});

test("evaluateDailyGoals reports partial progress and caps it at the target", () => {
  const goals = evaluateDailyGoals({ careEventsToday: 1, fedRequestsToday: 25, expeditionClaimsToday: 0 });
  const byId = Object.fromEntries(goals.map((goal) => [goal.id, goal]));
  assert.deepEqual(byId.care, { id: "care", target: 2, progress: 1, done: false });
  assert.deepEqual(byId.feed, { id: "feed", target: 10, progress: 10, done: true });
  assert.deepEqual(byId.expedition, { id: "expedition", target: 1, progress: 0, done: false });
});

test("evaluateAchievements unlocks exactly the six documented ids", () => {
  const none = evaluateAchievements({
    careEventCount: { total: 0, clean: 0, expedition: 0 },
    fragments: 0,
    evolutionCount: 0,
  });
  assert.deepEqual(none, []);

  const all = evaluateAchievements({
    careEventCount: { total: 10, clean: 1, expedition: 1 },
    fragments: 100,
    evolutionCount: 1,
  });
  assert.deepEqual(
    [...all].sort(),
    ["care-10", "first-care", "first-clean", "first-evolution", "first-expedition", "fragments-100"],
  );
});

test("evaluateAchievements respects each individual threshold", () => {
  const firstCare = evaluateAchievements({
    careEventCount: { total: 1, clean: 0, expedition: 0 },
    fragments: 99,
    evolutionCount: 0,
  });
  assert.deepEqual(firstCare, ["first-care"]);

  const firstClean = evaluateAchievements({
    careEventCount: { total: 3, clean: 1, expedition: 0 },
    fragments: 0,
    evolutionCount: 0,
  });
  assert.deepEqual([...firstClean].sort(), ["first-care", "first-clean"]);

  const firstExpedition = evaluateAchievements({
    careEventCount: { total: 0, clean: 0, expedition: 1 },
    fragments: 0,
    evolutionCount: 0,
  });
  assert.deepEqual(firstExpedition, ["first-expedition"]);

  const careTen = evaluateAchievements({
    careEventCount: { total: 10, clean: 0, expedition: 0 },
    fragments: 0,
    evolutionCount: 0,
  });
  assert.deepEqual([...careTen].sort(), ["care-10", "first-care"]);

  const fragments = evaluateAchievements({
    careEventCount: { total: 0, clean: 0, expedition: 0 },
    fragments: 100,
    evolutionCount: 0,
  });
  assert.deepEqual(fragments, ["fragments-100"]);

  const evolved = evaluateAchievements({
    careEventCount: { total: 0, clean: 0, expedition: 0 },
    fragments: 0,
    evolutionCount: 1,
  });
  assert.deepEqual(evolved, ["first-evolution"]);
});

if (failures > 0) {
  console.error(`${failures} test(s) failed`);
  process.exit(1);
}
console.log("all pet-progression-rules tests passed");
