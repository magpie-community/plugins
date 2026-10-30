// tests/pet-care-store.test.mjs
// Contract for the SQLite care store (Task 4).

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import { createCareStore, DECORATIONS, DAILY_GOAL_REWARDS } from "../lib/pet.care-store.mjs";

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

const MINUTE = 60 * 1000;
const tempPaths = [];
function freshDbPath() {
  const filePath = join(tmpdir(), `pet-care-store-test-${randomUUID()}.db`);
  tempPaths.push(filePath);
  return filePath;
}
function cleanup() {
  for (const filePath of tempPaths) {
    for (const suffix of ["", "-shm", "-wal"]) {
      try {
        rmSync(filePath + suffix, { force: true });
      } catch {
        // best effort cleanup
      }
    }
  }
}
process.on("exit", cleanup);

test("decoration catalog exposes eight fixed ids with explicit prices", () => {
  assert.deepEqual(Object.keys(DECORATIONS).sort(), [
    "meadow",
    "night",
    "ocean",
    "sakura",
    "snow",
    "sunset",
    "terminal",
    "void",
  ]);
  for (const def of Object.values(DECORATIONS)) {
    assert.equal(Number.isInteger(def.price) && def.price > 0, true);
  }
});

test("reopening the database runs migrations once and keeps data", () => {
  const databasePath = freshDbPath();
  const first = createCareStore({ databasePath });
  first.performAction("p1", "snack", 1000, {});
  first.close();

  const second = createCareStore({ databasePath });
  const snapshot = second.getCareSnapshot("p1", 1000);
  assert.equal(snapshot.state.satiety, 82);
  second.close();

  const raw = new Database(databasePath, { readonly: true });
  const version = raw.query("PRAGMA user_version").get().user_version;
  const tables = raw
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'magpie_pet_%'")
    .all()
    .map((row) => row.name)
    .sort();
  raw.close();
  assert.equal(version, 2);
  assert.deepEqual(tables, [
    "magpie_pet_achievements",
    "magpie_pet_care_events",
    "magpie_pet_care_state",
    "magpie_pet_daily",
    "magpie_pet_expeditions",
    "magpie_pet_inventory",
    "magpie_pet_names",
  ]);
});

test("getCareSnapshot creates the default state for an unknown partner", () => {
  const store = createCareStore({ databasePath: freshDbPath() });
  const snapshot = store.getCareSnapshot("p-new", 5000);
  assert.equal(snapshot.partnerId, "p-new");
  assert.equal(snapshot.state.satiety, 72);
  assert.equal(snapshot.state.mood, 70);
  assert.equal(snapshot.state.energy, 80);
  assert.equal(snapshot.state.hygiene, 75);
  assert.equal(snapshot.state.bond, 0);
  assert.equal(snapshot.activeExpedition, null);
  assert.equal(snapshot.daily.goals.length, 3);
  for (const goal of snapshot.daily.goals) {
    assert.equal(goal.progress, 0);
    assert.equal(goal.done, false);
    assert.equal(goal.rewardClaimed, false);
  }
  store.close();
});

test("rename persists per partner and validates the input", () => {
  const store = createCareStore({ databasePath: freshDbPath() });
  const named = store.renamePet("p1", "  小  豆子  ", 1000);
  assert.deepEqual(named, { ok: true, name: "小 豆子" });
  assert.equal(store.getPetName("p1"), "小 豆子");
  assert.equal(store.getPetName("p2"), null);
  assert.deepEqual(store.renamePet("p1", "", 1001), { ok: false, reason: "invalid-name" });
  assert.equal(store.getPetName("p1"), "小 豆子");
  store.close();
});

test("performAction applies decay and rejects a second snack during cooldown", () => {
  const store = createCareStore({ databasePath: freshDbPath() });
  const t0 = 1_000_000;
  const first = store.performAction("p1", "snack", t0, {});
  assert.equal(first.ok, true);
  assert.equal(first.state.satiety, 82);
  assert.equal(typeof first.message, "string");

  const refused = store.performAction("p1", "snack", t0 + MINUTE, {});
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "cooldown");

  // One hour later the stored state decays by 2 satiety per hour.
  const decayed = store.getCareSnapshot("p1", t0 + 60 * MINUTE);
  assert.equal(decayed.state.satiety, 80);
  store.close();
});

test("care state is stored independently per partner", () => {
  const store = createCareStore({ databasePath: freshDbPath() });
  const t0 = 1_000_000;
  store.performAction("p1", "snack", t0, {});
  store.performAction("p1", "snack", t0 + 11 * MINUTE, {});

  const p1 = store.getCareSnapshot("p1", t0 + 11 * MINUTE);
  const p2 = store.getCareSnapshot("p2", t0 + 11 * MINUTE);
  assert.equal(p1.state.satiety > 72, true);
  assert.equal(p2.state.satiety, 72);
  assert.equal(p2.state.bond, 0);

  // Switching back to p1 keeps the earlier progress.
  const p1Again = store.getCareSnapshot("p1", t0 + 11 * MINUTE);
  assert.equal(p1Again.state.satiety, p1.state.satiety);
  store.close();
});

test("claimExpedition is idempotent and a second running expedition is refused", () => {
  const store = createCareStore({ databasePath: freshDbPath() });
  const t0 = 1_000_000;
  const started = store.startExpedition("p1", "patrol", t0);
  assert.equal(started.ok, true);
  assert.equal(started.expedition.status, "running");
  assert.equal(started.state.energy, 70);

  const busy = store.startExpedition("p1", "field", t0 + 1);
  assert.equal(busy.ok, false);
  assert.equal(busy.reason, "expedition-active");

  const early = store.claimExpedition(started.expedition.expeditionId, t0 + 299_999);
  assert.equal(early.ok, false);
  assert.equal(early.reason, "not-finished");

  const claimed = store.claimExpedition(started.expedition.expeditionId, t0 + 300_000);
  assert.equal(claimed.ok, true);
  assert.equal(claimed.reward.fragments, 3);
  assert.equal(claimed.reward.bond, 1);
  assert.equal(typeof claimed.reward.note, "string");

  const fragmentsAfterClaim = store.getCollection().fragments;
  const again = store.claimExpedition(started.expedition.expeditionId, t0 + 600_000);
  assert.equal(again.ok, false);
  assert.equal(again.reason, "already-claimed");
  assert.equal(store.getCollection().fragments, fragmentsAfterClaim);

  const missing = store.claimExpedition("exp-does-not-exist", t0 + 600_000);
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, "no-expedition");

  const snapshot = store.getCareSnapshot("p1", t0 + 600_000);
  assert.equal(snapshot.activeExpedition, null);
  assert.equal(snapshot.state.bond, 1);
  store.close();
});

test("care-10 achievement unlocks exactly once", () => {
  const store = createCareStore({ databasePath: freshDbPath() });
  const t0 = 1_000_000;
  let lastNewly = [];
  for (let i = 0; i < 10; i += 1) {
    const result = store.performAction("p1", "snack", t0 + i * 11 * MINUTE, {});
    assert.equal(result.ok, true);
    lastNewly = result.achievements;
  }
  assert.deepEqual(lastNewly, ["care-10"]);

  const eleventh = store.performAction("p1", "snack", t0 + 10 * 11 * MINUTE, {});
  assert.equal(eleventh.ok, true);
  assert.deepEqual(eleventh.achievements, []);

  const achievements = store.getCollection().achievements;
  assert.equal(achievements.filter((id) => id === "care-10").length, 1);
  assert.equal(achievements.filter((id) => id === "first-care").length, 1);
  store.close();
});

test("writes are rejected after close and close is idempotent", () => {
  const store = createCareStore({ databasePath: freshDbPath() });
  store.close();
  store.close();
  assert.deepEqual(store.performAction("p1", "snack", 1000, {}), { ok: false, reason: "closed" });
  assert.deepEqual(store.startExpedition("p1", "patrol", 1000), { ok: false, reason: "closed" });
  assert.deepEqual(store.claimExpedition("exp-x", 1000), { ok: false, reason: "closed" });
  assert.deepEqual(store.equipDecoration("meadow"), { ok: false, reason: "closed" });
});

test("store works on a database without the upstream tables", () => {
  const store = createCareStore({ databasePath: freshDbPath() });
  const t0 = 1_000_000;
  const result = store.performAction("p1", "snack", t0, {});
  assert.equal(result.ok, true);
  const snapshot = store.getCareSnapshot("p1", t0);
  const feed = snapshot.daily.goals.find((goal) => goal.id === "feed");
  assert.deepEqual(feed, { id: "feed", target: 10, progress: 0, done: false, rewardClaimed: false });
  assert.deepEqual(snapshot.achievements, ["first-care"]);
  store.close();
});

test("equipDecoration refuses unknown ids and never spends fragments when insufficient", () => {
  const store = createCareStore({ databasePath: freshDbPath() });
  const t0 = 1_000_000;

  const unknown = store.equipDecoration("galaxy");
  assert.equal(unknown.ok, false);
  assert.equal(unknown.reason, "unknown-decoration");

  // One patrol claim: 3 fragments reward + daily expedition goal reward.
  const started = store.startExpedition("p1", "patrol", t0);
  store.claimExpedition(started.expedition.expeditionId, t0 + 300_000);
  const balance = 3 + DAILY_GOAL_REWARDS.expedition;
  assert.equal(store.getCollection().fragments, balance);
  assert.equal(balance < DECORATIONS.meadow.price, true);

  const poor = store.equipDecoration("meadow");
  assert.equal(poor.ok, false);
  assert.equal(poor.reason, "insufficient-fragments");
  assert.equal(store.getCollection().fragments, balance);

  // A field expedition adds 8 fragments; meadow now fits.
  const second = store.startExpedition("p1", "field", t0 + 300_001);
  store.claimExpedition(second.expedition.expeditionId, t0 + 300_001 + 900_000);
  assert.equal(store.getCollection().fragments, balance + 8);

  const equipped = store.equipDecoration("meadow");
  assert.equal(equipped.ok, true);
  assert.equal(equipped.equippedTheme, "meadow");
  const collection = store.getCollection();
  assert.equal(collection.fragments, balance + 8 - DECORATIONS.meadow.price);
  assert.deepEqual(collection.unlocked, ["meadow"]);
  assert.equal(collection.equippedTheme, "meadow");

  // Re-equipping an unlocked decoration is free.
  const again = store.equipDecoration("meadow");
  assert.equal(again.ok, true);
  assert.equal(store.getCollection().fragments, collection.fragments);
  store.close();
});

test("daily goal rewards are granted once per day", () => {
  const store = createCareStore({ databasePath: freshDbPath() });
  const t0 = 1_000_000;
  store.performAction("p1", "snack", t0, {});
  store.performAction("p1", "snack", t0 + 11 * MINUTE, {});

  const expected = DAILY_GOAL_REWARDS.care;
  assert.equal(store.getCollection().fragments, expected);

  const first = store.getCareSnapshot("p1", t0 + 11 * MINUTE);
  const care = first.daily.goals.find((goal) => goal.id === "care");
  assert.deepEqual(care, { id: "care", target: 2, progress: 2, done: true, rewardClaimed: true });

  // Repeated snapshots on the same day never grant the reward twice.
  store.getCareSnapshot("p1", t0 + 12 * MINUTE);
  store.getCareSnapshot("p1", t0 + 13 * MINUTE);
  assert.equal(store.getCollection().fragments, expected);
  store.close();
});

if (failures > 0) {
  console.error(`${failures} test(s) failed`);
  process.exit(1);
}
console.log("all pet-care-store tests passed");
