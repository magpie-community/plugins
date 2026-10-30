// tests/pet-server-care.test.mjs
// Contract for the page server care API (Task 5): /api/state gains
// care/expedition/collection/daily/frame/frames, /api/command gains the
// pet-* whitelist with strict 400s, static files stay inside page/, and
// close() is idempotent and actually refuses new connections.
//
// All requests go through node:http directly to 127.0.0.1: the shell has
// HTTP_PROXY set with an empty NO_PROXY, so Bun's fetch would be answered
// by the proxy (502) and can neither prove the server is up nor down.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";

import { createPetAdapter } from "../lib/pet.adapter.mjs";
import { createPetServer } from "../lib/pet.server.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REAL_DB = join(dirname(HERE), "data", "pet.db");

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}`);
    console.error(error);
  }
}

const tempPaths = [];
function freshDbPath() {
  const filePath = join(tmpdir(), `pet-server-care-test-${randomUUID()}.db`);
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

// node:http request that never touches HTTP_PROXY.
function httpJson(port, path, { method = "GET", body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        timeout: 5000,
        headers: body === undefined ? { ...headers } : { "content-type": "application/json", ...headers },
      },
      (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            // leave json null for non-JSON bodies
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("request timeout")));
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

function withRawDb(databasePath, fn) {
  const db = new Database(databasePath);
  db.run("PRAGMA busy_timeout = 5000");
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------- group A --
// server over a fresh db with one spawned partner
const dbA = freshDbPath();
const adapterA = createPetAdapter({ databasePath: dbA, notifyGate: () => false });
await adapterA.runCommand("digital-pet-spawn");
const serverA = createPetServer({ databasePath: dbA, port: 3641, notifyGate: () => false });
assert.equal(await serverA.start(), true);

await test("CORS lets Magpie's sandboxed plugin page read and command", async () => {
  // Magpie's plugin iframe is sandboxed with allow-scripts only, so its origin
  // is null. Without these headers the browser turns the response into
  // "Failed to fetch" and the page stays blank.
  const state = await httpJson(3641, "/api/state");
  assert.equal(state.headers["access-control-allow-origin"], "*");

  const preflight = await httpJson(3641, "/api/command", {
    method: "OPTIONS",
    headers: {
      origin: "null",
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type",
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers["access-control-allow-origin"], "*");
  assert.match(preflight.headers["access-control-allow-methods"], /POST/);
  assert.match(preflight.headers["access-control-allow-headers"], /content-type/i);
});

await test("state exposes default care snapshot, collection and frames after spawn", async () => {
  const res = await httpJson(3641, "/api/state");
  assert.equal(res.status, 200);
  assert.match(res.headers["content-type"], /application\/json/);
  const state = res.json;
  assert.equal(state.ok, true);
  assert.equal(typeof state.partner.id, "string");

  const care = state.care;
  assert.equal(care.state.partnerId, state.partner.id);
  // a few milliseconds of natural decay may pass between spawn and this read
  const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.1, `${actual} !~ ${expected}`);
  near(care.state.satiety, 72);
  near(care.state.mood, 70);
  near(care.state.energy, 80);
  near(care.state.hygiene, 75);
  near(care.state.bond, 0);
  assert.equal(typeof care.summary.moodLabel, "string");

  assert.equal(state.expedition, null);
  assert.equal(typeof state.daily.date, "string");
  assert.equal(state.daily.goals.length, 3);

  assert.equal(state.collection.fragments, 0);
  assert.deepEqual(state.collection.unlocked, []);
  assert.equal(state.collection.equippedTheme, null);

  // the spawned partner is an egg: sprite "egg" ships walk_1/walk_2 only
  assert.equal(state.frame.name, "walk_1");
  assert.equal(typeof state.frame.content, "string");
  assert.ok(state.frame.content.length > 0);
  assert.ok(state.frame.available.includes("walk_1"));
  assert.equal(typeof state.frames.walk_1, "string");
  assert.equal(typeof state.frames.walk_2, "string");
  assert.equal(state.petName, null);
  assert.equal(Array.isArray(state.dex), true);
  assert.equal(state.dex.length, 650);
  assert.equal(state.dex.filter((d) => d.unlocked).length, 1);
  assert.equal(state.dex.find((d) => d.id === "0-001").current, true);
});

await test("rename stores a per-partner display name", async () => {
  const renamed = await httpJson(3641, "/api/command", {
    method: "POST",
    body: { name: "pet-rename", args: "小豆子" },
  });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.json.state.petName, "小豆子");
  assert.equal(renamed.json.state.care.petName, "小豆子");

  const invalid = await httpJson(3641, "/api/command", {
    method: "POST",
    body: { name: "pet-rename", args: " ".repeat(30) },
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.reason, "invalid-name");
});

await test("care commands mutate state, return {text,toasts,state} and respect cooldowns", async () => {
  const fed = await httpJson(3641, "/api/command", {
    method: "POST",
    body: { name: "pet-feed-snack" },
  });
  assert.equal(fed.status, 200);
  assert.match(fed.headers["content-type"], /application\/json/);
  assert.ok(fed.json.text.length > 0);
  assert.ok(Array.isArray(fed.json.toasts));
  // 72 + 10, minus a few milliseconds of decay before the snapshot
  assert.ok(fed.json.state.care.state.satiety > 81.9 && fed.json.state.care.state.satiety <= 82);

  const again = await httpJson(3641, "/api/command", {
    method: "POST",
    body: { name: "pet-feed-snack" },
  });
  assert.equal(again.status, 400);
  assert.equal(again.json.reason, "cooldown");
  assert.equal(typeof again.json.error, "string");

  const pet = await httpJson(3641, "/api/command", {
    method: "POST",
    body: { name: "pet-pet-egg" },
  });
  assert.equal(pet.status, 200);
  assert.equal(pet.json.state.care.state.bond, 2);

  const unknown = await httpJson(3641, "/api/command", {
    method: "POST",
    body: { name: "rm -rf" },
  });
  assert.equal(unknown.status, 400);
  assert.equal(typeof unknown.json.error, "string");
  assert.equal(typeof unknown.json.reason, "string");
});

await test("pet-pet-egg is rejected with HTTP 400 once the partner leaves the egg stage", async () => {
  withRawDb(dbA, (db) => {
    db.run("UPDATE partners SET current_node_id = '1-001' WHERE retired_at IS NULL");
    // clear the cooldown from the earlier pet so the stage rule is what fires
    db.run("UPDATE magpie_pet_care_state SET cooldown_pet_egg = 0");
  });
  const res = await httpJson(3641, "/api/command", {
    method: "POST",
    body: { name: "pet-pet-egg" },
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.reason, "wrong-stage");
  withRawDb(dbA, (db) => {
    db.run("UPDATE partners SET current_node_id = '0-001' WHERE retired_at IS NULL");
  });
});

await test("expedition commands validate kind, single active expedition and double claims", async () => {
  const badKind = await httpJson(3641, "/api/command", {
    method: "POST",
    body: { name: "pet-expedition-start", args: "moon" },
  });
  assert.equal(badKind.status, 400);
  assert.equal(badKind.json.reason, "unknown-expedition");

  const start = await httpJson(3641, "/api/command", {
    method: "POST",
    body: { name: "pet-expedition-start", args: "patrol" },
  });
  assert.equal(start.status, 200);
  const expedition = start.json.state.expedition;
  assert.equal(expedition.kind, "patrol");
  assert.equal(expedition.status, "running");

  const second = await httpJson(3641, "/api/command", {
    method: "POST",
    body: { name: "pet-expedition-start", args: "field" },
  });
  assert.equal(second.status, 400);
  assert.equal(second.json.reason, "expedition-active");

  const wrongId = await httpJson(3641, "/api/command", {
    method: "POST",
    body: { name: "pet-expedition-claim", args: "exp-does-not-exist" },
  });
  assert.equal(wrongId.status, 400);
  assert.equal(wrongId.json.reason, "no-expedition");

  const early = await httpJson(3641, "/api/command", {
    method: "POST",
    body: { name: "pet-expedition-claim", args: expedition.expeditionId },
  });
  assert.equal(early.status, 400);
  assert.equal(early.json.reason, "not-finished");

  withRawDb(dbA, (db) => {
    db.query("UPDATE magpie_pet_expeditions SET ends_at = 0 WHERE expedition_id = ?").run(expedition.expeditionId);
  });
  const claim = await httpJson(3641, "/api/command", {
    method: "POST",
    body: { name: "pet-expedition-claim", args: expedition.expeditionId },
  });
  assert.equal(claim.status, 200);
  assert.equal(claim.json.state.expedition, null);
  assert.ok(claim.json.state.collection.fragments >= 3);

  const duplicate = await httpJson(3641, "/api/command", {
    method: "POST",
    body: { name: "pet-expedition-claim", args: expedition.expeditionId },
  });
  assert.equal(duplicate.status, 400);
  assert.equal(duplicate.json.reason, "already-claimed");
});

await test("decoration equip validates the id and the fragment balance", async () => {
  const badId = await httpJson(3641, "/api/command", {
    method: "POST",
    body: { name: "pet-decoration-equip", args: "rainbow" },
  });
  assert.equal(badId.status, 400);
  assert.equal(badId.json.reason, "unknown-decoration");

  // patrol claim paid 3 (+5 daily-goal rewards) — not enough for meadow (10)
  const poor = await httpJson(3641, "/api/command", {
    method: "POST",
    body: { name: "pet-decoration-equip", args: "meadow" },
  });
  assert.equal(poor.status, 400);
  assert.equal(poor.json.reason, "insufficient-fragments");

  withRawDb(dbA, (db) => {
    db.run(
      "INSERT INTO magpie_pet_inventory (item_id, kind, quantity, equipped) VALUES ('fragments', 'currency', 100, 0) ON CONFLICT(item_id) DO UPDATE SET quantity = quantity + 100",
    );
  });
  const equip = await httpJson(3641, "/api/command", {
    method: "POST",
    body: { name: "pet-decoration-equip", args: "meadow" },
  });
  assert.equal(equip.status, 200);
  assert.equal(equip.json.state.collection.equippedTheme, "meadow");
  assert.ok(equip.json.state.collection.unlocked.includes("meadow"));
});

await test("unknown pet-expedition-* commands are rejected as unknown-command without side effects", async () => {
  // regression: the care whitelist used startsWith("pet-expedition-"), so any
  // pet-expedition-* name fell through to the decoration-equip branch and
  // spent fragments. Unknown names must be rejected before any mutation.
  const before = await httpJson(3641, "/api/state");
  assert.equal(before.status, 200);
  const fragmentsBefore = before.json.collection.fragments;
  const themeBefore = before.json.collection.equippedTheme;

  for (const name of ["pet-expedition-nonsense", "pet-expedition-claimm"]) {
    const res = await httpJson(3641, "/api/command", {
      method: "POST",
      body: { name, args: "meadow" },
    });
    assert.equal(res.status, 400, `${name} must be rejected`);
    assert.equal(res.json.reason, "unknown-command", `${name} reason`);
  }

  const after = await httpJson(3641, "/api/state");
  assert.equal(after.status, 200);
  assert.equal(after.json.collection.fragments, fragmentsBefore);
  assert.equal(after.json.collection.equippedTheme, themeBefore);
});

await test("original engine commands stay compatible; set displays the pinned node and unpin restores it", async () => {
  const set = await httpJson(3641, "/api/command", {
    method: "POST",
    body: { name: "digital-pet-set", args: "1-001" },
  });
  assert.equal(set.status, 200);
  assert.ok(set.json.state.partner);
  assert.equal(set.json.state.pinned, "1-001");
  assert.equal(set.json.state.partner.node.id, "1-001");
  assert.equal(set.json.state.partner.engineNode.id, "0-001");
  assert.ok(set.json.state.care);

  const badSet = await httpJson(3641, "/api/command", {
    method: "POST",
    body: { name: "digital-pet-set", args: "DROP TABLE" },
  });
  assert.equal(badSet.status, 400);
  assert.equal(typeof badSet.json.reason, "string");

  const unpin = await httpJson(3641, "/api/command", {
    method: "POST",
    body: { name: "pet-unpin" },
  });
  assert.equal(unpin.status, 200);
  assert.equal(unpin.json.state.pinned, null);
  assert.equal(unpin.json.state.partner.node.id, "0-001");
});

await test("spawn requires baby II and is rate limited, then uses the non-repeating starter pool", async () => {
  const tooEarly = await httpJson(3641, "/api/command", {
    method: "POST",
    body: { name: "digital-pet-spawn" },
  });
  assert.equal(tooEarly.status, 400);
  assert.equal(tooEarly.json.reason, "stage-required");

  withRawDb(dbA, (db) => {
    db.run(
      "UPDATE partners SET current_node_id = '2-001', created_at = ? WHERE retired_at IS NULL",
      new Date(Date.now() - 120_000).toISOString(),
    );
  });
  const spawn = await httpJson(3641, "/api/command", {
    method: "POST",
    body: { name: "digital-pet-spawn" },
  });
  assert.equal(spawn.status, 200);
  const state = spawn.json.state;
  assert.equal(state.partner.generation, 2);
  assert.equal(state.partner.node.id, "1-001");
  assert.equal(state.care.state.partnerId, state.partner.id);
  assert.ok(Math.abs(state.care.state.satiety - 72) < 0.1);
  assert.ok(Math.abs(state.care.state.bond - 0) < 0.1);
});

await test("static files are confined to the page directory", async () => {
  // WHATWG URL normalizes %2e%2e away before we see it; either way the
  // package.json outside page/ must not be served
  const escape = await httpJson(3641, "/%2e%2e/package.json");
  assert.notEqual(escape.status, 200);
  assert.ok(!escape.text.includes('"name"'));

  // %2f survives URL normalization; after decoding it must hit the 403 guard
  const escapeSlash = await httpJson(3641, "/%2e%2e%2fpackage.json");
  assert.equal(escapeSlash.status, 403);
  assert.ok(!escapeSlash.text.includes('"name"'));

  const escapeDeep = await httpJson(3641, "/%2e%2e%2f%2e%2e%2fpackage.json");
  assert.equal(escapeDeep.status, 403);

  const page = await httpJson(3641, "/");
  assert.equal(page.status, 200);
  assert.match(page.headers["content-type"], /text\/html/);
});

await serverA.close();

// ---------------------------------------------------------------- group B --
// server over a fresh db with NO partner at all
const dbB = freshDbPath();
const serverB = createPetServer({ databasePath: dbB, port: 3642, notifyGate: () => false });
assert.equal(await serverB.start(), true);

await test("state without an active partner reports nulls but keeps the collection readable", async () => {
  const res = await httpJson(3642, "/api/state");
  assert.equal(res.status, 200);
  const state = res.json;
  assert.equal(state.care, null);
  assert.equal(state.expedition, null);
  assert.equal(state.daily, null);
  assert.equal(state.collection.fragments, 0);
  assert.equal(state.frame, null);
  assert.deepEqual(state.frames, {});

  const play = await httpJson(3642, "/api/command", {
    method: "POST",
    body: { name: "pet-play" },
  });
  assert.equal(play.status, 400);
  assert.equal(play.json.reason, "no-active-partner");
});

await test("close() is idempotent and refuses new connections afterwards", async () => {
  const before = await httpJson(3642, "/api/ping");
  assert.equal(before.status, 200);
  await serverB.close();
  await serverB.close(); // idempotent
  let refused = false;
  try {
    await httpJson(3642, "/api/ping");
  } catch {
    refused = true;
  }
  assert.equal(refused, true);
});

// ---------------------------------------------------------------- group C --
// server over a COPY of the real database: history must survive, care
// tables must migrate in place. The live db keeps being fed, so the
// baseline is read from the copy itself, not hard-coded.
const dbC = freshDbPath();
{
  // The live plugin host keeps the save in WAL; copying only pet.db can miss
  // the newest partner/team rows. VACUUM INTO produces a consistent snapshot.
  const src = new Database(REAL_DB, { readonly: true });
  src.exec(`VACUUM INTO ${JSON.stringify(dbC)}`);
  src.close();
}
const baseline = withRawDb(dbC, (db) => ({
  receipts: db.query("SELECT COUNT(*) c, SUM(token_delta) t FROM usage_receipts").get(),
  partner: db
    .query(
      "SELECT partner_id, generation, current_node_id FROM partners WHERE partner_id = (SELECT principal_id FROM partner_team WHERE team_id = 1) AND retired_at IS NULL",
    )
    .get(),
}));
const serverC = createPetServer({ databasePath: dbC, port: 3643, notifyGate: () => false });
assert.equal(await serverC.start(), true);

await test("state on a copy of the real database keeps history and migrates care tables", async () => {
  assert.ok(Number.isInteger(baseline.receipts.c) && baseline.receipts.c >= 0, "real db history count should be readable");

  const res = await httpJson(3643, "/api/state");
  assert.equal(res.status, 200);
  const state = res.json;
  assert.equal(state.ok, true);
  assert.equal(state.partner.generation, baseline.partner.generation);
  assert.equal(state.partner.node.id, baseline.partner.current_node_id);
  assert.equal(state.fedRequests, baseline.receipts.c);
  assert.equal(state.fedTokens, baseline.receipts.t);
  assert.equal(state.care.state.partnerId, baseline.partner.partner_id);
  // the live db may already carry a care row (the plugin migrates it on
  // load); the values just need to be valid care numbers
  assert.ok(state.care.state.satiety >= 0 && state.care.state.satiety <= 100);
  assert.equal(typeof state.care.summary.moodLabel, "string");

  const tables = withRawDb(dbC, (db) =>
    db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND substr(name, 1, 11) = 'magpie_pet_'")
      .all()
      .map((row) => row.name)
      .sort(),
  );
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

await serverC.close();

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log("\nall tests passed");
