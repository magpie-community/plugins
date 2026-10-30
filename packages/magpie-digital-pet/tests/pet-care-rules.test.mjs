// tests/pet-care-rules.test.mjs
// Contract for the pure pet care rules module (Task 2).

import assert from "node:assert/strict";

import {
  CARE_ACTIONS,
  CARE_LIMITS,
  applyCareAction,
  careSummary,
  createDefaultCareState,
  decayCareState,
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

const HOUR = 60 * 60 * 1000;

function pick(obj, keys) {
  return keys.map((key) => obj[key]);
}

test("CARE_LIMITS exposes the documented limits", () => {
  assert.deepEqual(CARE_LIMITS, { min: 0, max: 100, maxOfflineMs: 24 * HOUR });
});

test("CARE_ACTIONS lists exactly the five care actions", () => {
  assert.deepEqual(Object.keys(CARE_ACTIONS).sort(), ["clean", "petEgg", "play", "rest", "snack"]);
});

test("createDefaultCareState returns the documented initial values", () => {
  const state = createDefaultCareState("p1", 1000);
  assert.deepEqual(pick(state, ["satiety", "mood", "energy", "hygiene", "bond"]), [72, 70, 80, 75, 0]);
  assert.equal(state.partnerId, "p1");
  assert.equal(state.lastDecayAt, 1000);
  assert.equal(state.updatedAt, 1000);
  assert.deepEqual(state.cooldowns, { snack: 0, play: 0, clean: 0, rest: 0, petEgg: 0 });
});

test("decay caps 48 hours offline to 24 hours and never lowers bond", () => {
  const state = { ...createDefaultCareState("p1", 0), bond: 12 };
  const decayed = decayCareState(state, 48 * HOUR);
  assert.deepEqual(pick(decayed, ["satiety", "mood", "energy", "hygiene", "bond"]), [24, 34, 100, 51, 12]);
  assert.equal(decayed.lastDecayAt, 48 * HOUR);
  // original object untouched
  assert.deepEqual(pick(state, ["satiety", "mood", "energy", "hygiene", "bond"]), [72, 70, 80, 75, 12]);
});

test("decay applies the exact hourly rates and clamps to 0-100", () => {
  const state = createDefaultCareState("p1", 0);
  const oneHour = decayCareState(state, 1 * HOUR);
  assert.deepEqual(pick(oneHour, ["satiety", "mood", "energy", "hygiene"]), [70, 68.5, 83, 74]);
  const low = { ...state, satiety: 1, mood: 1, hygiene: 0.5 };
  const floored = decayCareState(low, 24 * HOUR);
  assert.deepEqual(pick(floored, ["satiety", "mood", "hygiene"]), [0, 0, 0]);
});

test("decay with an earlier timestamp changes nothing", () => {
  const state = createDefaultCareState("p1", 5000);
  const result = decayCareState(state, 1000);
  assert.deepEqual(pick(result, ["satiety", "mood", "energy", "hygiene", "bond"]), [72, 70, 80, 75, 0]);
});

test("snack applies +10 satiety and +2 mood, then enters a 10 minute cooldown", () => {
  const state = createDefaultCareState("p1", 0);
  const result = applyCareAction(state, "snack", 60_000);
  assert.equal(result.ok, true);
  assert.deepEqual(pick(result.state, ["satiety", "mood"]), [82, 72]);
  assert.equal(result.state.cooldowns.snack, 60_000 + 10 * 60 * 1000);
  assert.equal(result.state.updatedAt, 60_000);
  // original object untouched
  assert.deepEqual(pick(state, ["satiety", "mood"]), [72, 70]);
  assert.equal(state.cooldowns.snack, 0);
});

test("snack clamps satiety at 100", () => {
  const state = { ...createDefaultCareState("p1", 0), satiety: 98 };
  const result = applyCareAction(state, "snack", 0);
  assert.equal(result.ok, true);
  assert.equal(result.state.satiety, 100);
});

test("an action during its cooldown is rejected without modifying the original state", () => {
  const state = createDefaultCareState("p1", 0);
  const first = applyCareAction(state, "snack", 0);
  assert.equal(first.ok, true);
  const second = applyCareAction(first.state, "snack", 5 * 60 * 1000);
  assert.equal(second.ok, false);
  assert.equal(second.reason, "cooldown");
  assert.equal(second.state, first.state);
  assert.deepEqual(pick(first.state, ["satiety", "mood"]), [82, 72]);
});

test("play requires at least 20 energy", () => {
  const state = { ...createDefaultCareState("p1", 0), energy: 19 };
  const result = applyCareAction(state, "play", 0);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "low-energy");
  assert.equal(result.state, state);
  const okState = { ...state, energy: 20 };
  const played = applyCareAction(okState, "play", 0);
  assert.equal(played.ok, true);
  assert.deepEqual(pick(played.state, ["mood", "bond", "energy"]), [82, 2, 10]);
  assert.equal(played.state.cooldowns.play, 8 * 60 * 1000);
});

test("clean restores hygiene to 100 and grants +1 bond only when hygiene was below 50", () => {
  const dirty = { ...createDefaultCareState("p1", 0), hygiene: 40, bond: 3 };
  const dirtyResult = applyCareAction(dirty, "clean", 0);
  assert.equal(dirtyResult.ok, true);
  assert.deepEqual(pick(dirtyResult.state, ["hygiene", "bond"]), [100, 4]);
  assert.equal(dirtyResult.state.cooldowns.clean, 10 * 60 * 1000);

  const tidy = { ...createDefaultCareState("p1", 0), hygiene: 50, bond: 3 };
  const tidyResult = applyCareAction(tidy, "clean", 0);
  assert.equal(tidyResult.ok, true);
  assert.deepEqual(pick(tidyResult.state, ["hygiene", "bond"]), [100, 3]);
});

test("rest restores +25 energy, costs 2 satiety and uses a 15 minute cooldown", () => {
  const state = { ...createDefaultCareState("p1", 0), energy: 30 };
  const result = applyCareAction(state, "rest", 0);
  assert.equal(result.ok, true);
  assert.deepEqual(pick(result.state, ["energy", "satiety"]), [55, 70]);
  assert.equal(result.state.cooldowns.rest, 15 * 60 * 1000);
});

test("petEgg only works while context.stage is 0", () => {
  const state = createDefaultCareState("p1", 0);
  const egg = applyCareAction(state, "petEgg", 0, { stage: 0 });
  assert.equal(egg.ok, true);
  assert.equal(egg.state.bond, 2);
  assert.equal(egg.state.cooldowns.petEgg, 5 * 60 * 1000);

  const hatched = applyCareAction(state, "petEgg", 0, { stage: 1 });
  assert.equal(hatched.ok, false);
  assert.equal(hatched.reason, "wrong-stage");
  assert.equal(hatched.state, state);

  const missing = applyCareAction(state, "petEgg", 0);
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, "wrong-stage");
});

test("an unknown action is rejected without touching the state", () => {
  const state = createDefaultCareState("p1", 0);
  const result = applyCareAction(state, "dance", 0);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unknown-action");
  assert.equal(result.state, state);
});

test("careSummary reports a mood label and attention flag", () => {
  const fresh = careSummary(createDefaultCareState("p1", 0));
  assert.equal(typeof fresh.moodLabel, "string");
  assert.equal(fresh.needsAttention, false);

  const neglected = careSummary({ ...createDefaultCareState("p1", 0), satiety: 10, mood: 5 });
  assert.equal(neglected.needsAttention, true);
});

if (failures > 0) {
  console.error(`${failures} test(s) failed`);
  process.exit(1);
}
console.log("all pet-care-rules tests passed");
