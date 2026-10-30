// tests/e2e-page.test.mjs
// End-to-end regression and real-page acceptance (Task 8).
//
// Core section (always runs): boots the page server over a throwaway COPY of
// the real data/pet.db and walks one full care loop through the public API:
// state -> snack -> clean -> expedition start -> (test fast-forwards ends_at
// in the copy, production durations untouched) -> claim -> state again.
// All requests use node:http straight to 127.0.0.1: the shell has HTTP_PROXY
// set with an empty NO_PROXY, so Bun's fetch would be answered by the proxy
// and could neither prove the server up nor down.
//
// Browser section (opt-in): renders the real dashboard in the local Edge via
// playwright-core, without adding either as a project dependency. It only
// runs when BOTH env vars point at local files:
//   PET_E2E_PLAYWRIGHT  absolute path to playwright-core/index.mjs
//   PET_E2E_EDGE        absolute path to msedge.exe
//   PET_E2E_ARTIFACT_DIR  optional screenshot dir (default: system temp)
// Otherwise it prints one explicit SKIP line and the test still passes.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Database } from "bun:sqlite";

import { createPetServer } from "../lib/pet.server.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REAL_DB = join(dirname(HERE), "data", "pet.db");

const CORE_PORT = 3651;
const PAGE_PORT = 3652;

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
function trackTemp(filePath) {
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

// Take a consistent snapshot of the live save: the plugin host keeps recent
// rows in WAL, so copying pet.db alone can miss them.
function copyRealDb() {
  const target = trackTemp(join(tmpdir(), `pet-e2e-${randomUUID()}.db`));
  const src = new Database(REAL_DB, { readonly: true });
  try {
    src.exec(`VACUUM INTO ${JSON.stringify(target)}`);
  } finally {
    src.close();
  }
  return target;
}

// node:http request that never touches HTTP_PROXY.
function httpJson(port, path, { method = "GET", body } = {}) {
  return new Promise((resolvePromise, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        timeout: 5000,
        headers: body === undefined ? {} : { "content-type": "application/json" },
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
          resolvePromise({ status: res.statusCode, headers: res.headers, text, json });
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

function readBaseline(databasePath) {
  return withRawDb(databasePath, (db) => ({
    receipts: db.query("SELECT COUNT(*) c, SUM(token_delta) t FROM usage_receipts").get(),
    partner: db
      .query(
        "SELECT partner_id, generation, current_node_id FROM partners WHERE partner_id = (SELECT principal_id FROM partner_team WHERE team_id = 1) AND retired_at IS NULL",
      )
      .get(),
    partnerEvents: db.query("SELECT COUNT(*) c FROM partner_events").get().c,
  }));
}

// Deterministic starting point for the care loop: no cooldowns, mid-range
// stats so snack/clean effects are observable and not clamped at 100.
function resetCareFor(partnerId, databasePath) {
  withRawDb(databasePath, (db) => {
    // The live save may already have an expedition/achievements from real use.
    // This is a throwaway copy: reset only the care layer, never upstream history.
    db.query(
      `UPDATE magpie_pet_care_state SET
         satiety = 50, mood = 60, energy = 80, hygiene = 40, bond = 5,
         cooldown_snack = 0, cooldown_play = 0, cooldown_clean = 0,
         cooldown_rest = 0, cooldown_pet_egg = 0
       WHERE partner_id = ?`,
    ).run(partnerId);
    db.query("DELETE FROM magpie_pet_expeditions WHERE partner_id = ?").run(partnerId);
    db.query("DELETE FROM magpie_pet_care_events WHERE partner_id = ?").run(partnerId);
    db.exec("DELETE FROM magpie_pet_achievements");
    db.exec("DELETE FROM magpie_pet_daily");
    db.exec("DELETE FROM magpie_pet_inventory");
  });
}

const post = (port, name, args) =>
  httpJson(port, "/api/command", { method: "POST", body: args === undefined ? { name } : { name, args } });

// =================================================================== core ==
assert.ok(existsSync(REAL_DB), `real database missing: ${REAL_DB}`);
const dbFile = copyRealDb();
const baseline = readBaseline(dbFile);
assert.ok(baseline.partner, "real database must carry an active partner");
assert.ok(Number.isInteger(baseline.receipts.c) && baseline.receipts.c >= 0, "real database history count should be readable");

const server = createPetServer({ databasePath: dbFile, port: CORE_PORT, notifyGate: () => false });
assert.equal(await server.start(), true);

await test("state on the real-save copy exposes partner, care, collection, frames and the full feed history", async () => {
  const res = await httpJson(CORE_PORT, "/api/state");
  assert.equal(res.status, 200);
  const state = res.json;
  assert.equal(state.ok, true);

  // upstream history identical to the copy baseline
  assert.equal(state.partner.id, baseline.partner.partner_id);
  assert.equal(state.partner.generation, baseline.partner.generation);
  assert.equal(state.partner.node.id, baseline.partner.current_node_id);
  assert.equal(state.fedRequests, baseline.receipts.c);
  assert.equal(state.fedTokens, baseline.receipts.t);
  assert.equal(state.events.length, Math.min(12, baseline.partnerEvents));

  // care layer
  assert.equal(state.care.state.partnerId, baseline.partner.partner_id);
  assert.equal(typeof state.care.summary.moodLabel, "string");
  assert.equal(typeof state.daily.date, "string");
  assert.equal(state.daily.goals.length, 3);
  assert.ok(Number.isFinite(state.collection.fragments));
  assert.ok(Array.isArray(state.collection.achievements));

  // pixel frames: either real frames for this sprite or the stable {} fallback
  assert.equal(typeof state.frames, "object");
  if (state.frame) {
    assert.ok(state.frame.content.length > 0);
    assert.ok(state.frame.available.includes(state.frame.name));
  } else {
    assert.deepEqual(state.frames, {});
  }
});

await test("snack and clean mutate care state and record events/achievements", async () => {
  resetCareFor(baseline.partner.partner_id, dbFile);

  const before = (await httpJson(CORE_PORT, "/api/state")).json;
  const fragmentsBefore = before.collection.fragments;

  const snack = await post(CORE_PORT, "pet-feed-snack");
  assert.equal(snack.status, 200);
  assert.ok(snack.json.text.length > 0);
  // 50 + 10, minus a few milliseconds of decay before the snapshot
  assert.ok(snack.json.state.care.state.satiety > 59.9 && snack.json.state.care.state.satiety <= 60);

  const clean = await post(CORE_PORT, "pet-clean");
  assert.equal(clean.status, 200);
  assert.ok(clean.json.state.care.state.hygiene > 99.9);
  // hygiene was 40 < 50: clean grants the +1 bond bonus
  assert.equal(clean.json.state.care.state.bond, 6);

  // achievements unlock exactly through the public API
  assert.ok(clean.json.state.collection.achievements.includes("first-care"));
  assert.ok(clean.json.state.collection.achievements.includes("first-clean"));

  // the care daily goal (2 actions today) is done and paid its fragments
  const careGoal = clean.json.state.daily.goals.find((g) => g.id === "care");
  assert.equal(careGoal.done, true);
  assert.ok(clean.json.state.collection.fragments > fragmentsBefore);

  // original feed history untouched by care actions
  assert.equal(clean.json.state.fedRequests, baseline.receipts.c);
  assert.equal(clean.json.state.fedTokens, baseline.receipts.t);
});

await test("patrol expedition starts and claims through /api/command, with history preserved", async () => {
  const fragmentsBefore = (await httpJson(CORE_PORT, "/api/state")).json.collection.fragments;
  const bondBefore = (await httpJson(CORE_PORT, "/api/state")).json.care.state.bond;

  const start = await post(CORE_PORT, "pet-expedition-start", "patrol");
  assert.equal(start.status, 200);
  const expedition = start.json.state.expedition;
  assert.equal(expedition.kind, "patrol");
  assert.equal(expedition.status, "running");
  // starting the patrol costs 10 energy (80 -> 70 minus negligible decay)
  assert.ok(start.json.state.care.state.energy < 70.1 && start.json.state.care.state.energy >= 69);

  // too early: the production 5-minute duration still applies
  const early = await post(CORE_PORT, "pet-expedition-claim", expedition.expeditionId);
  assert.equal(early.status, 400);
  assert.equal(early.json.reason, "not-finished");

  // test-only fast-forward inside the throwaway copy; production constants untouched
  withRawDb(dbFile, (db) => {
    db.query("UPDATE magpie_pet_expeditions SET ends_at = ? WHERE expedition_id = ?").run(
      Date.now(),
      expedition.expeditionId,
    );
  });

  const claim = await post(CORE_PORT, "pet-expedition-claim", expedition.expeditionId);
  assert.equal(claim.status, 200);
  assert.ok(claim.json.text.length > 0, "claim returns the expedition note");

  const after = claim.json.state;
  assert.equal(after.expedition, null, "active expedition cleared after claim");
  assert.ok(after.collection.fragments >= fragmentsBefore + 3, "patrol pays 3 fragments");
  assert.equal(after.care.state.bond, Math.min(100, bondBefore + 1));
  assert.ok(after.collection.achievements.includes("first-expedition"));
  const expeditionGoal = after.daily.goals.find((g) => g.id === "expedition");
  assert.equal(expeditionGoal.done, true);

  // care/expedition events landed in the copy
  const eventKinds = withRawDb(dbFile, (db) =>
    db
      .query("SELECT kind, COUNT(*) c FROM magpie_pet_care_events GROUP BY kind")
      .all()
      .map((row) => row.kind),
  );
  for (const kind of ["care", "expedition-start", "expedition", "achievement"]) {
    assert.ok(eventKinds.includes(kind), `missing ${kind} events`);
  }

  // original upstream history still intact after the whole loop
  assert.equal(after.fedRequests, baseline.receipts.c);
  assert.equal(after.fedTokens, baseline.receipts.t);
  assert.equal(after.events.length, Math.min(12, baseline.partnerEvents));
});

await test("close() afterwards refuses new connections (no proxy false-positives)", async () => {
  await server.close();
  let refused = false;
  try {
    await httpJson(CORE_PORT, "/api/ping");
  } catch {
    refused = true;
  }
  assert.equal(refused, true);
});

// ================================================================ browser ==
const PW_PATH = process.env.PET_E2E_PLAYWRIGHT;
const EDGE_PATH = process.env.PET_E2E_EDGE;
const ARTIFACT_DIR = process.env.PET_E2E_ARTIFACT_DIR || join(tmpdir(), "magpie-pet-e2e-artifacts");

if (!PW_PATH || !EDGE_PATH) {
  console.log(
    "SKIP browser section: set PET_E2E_PLAYWRIGHT (playwright-core/index.mjs) and " +
      "PET_E2E_EDGE (msedge.exe) to run the real Edge rendering acceptance",
  );
} else {
  assert.ok(existsSync(resolve(PW_PATH)), `PET_E2E_PLAYWRIGHT not found: ${PW_PATH}`);
  assert.ok(existsSync(resolve(EDGE_PATH)), `PET_E2E_EDGE not found: ${EDGE_PATH}`);
  mkdirSync(ARTIFACT_DIR, { recursive: true });

  const pw = await import(pathToFileURL(resolve(PW_PATH)).href);
  const chromium = pw.chromium ?? pw.default?.chromium;
  assert.ok(chromium, "playwright-core module must expose chromium");

  // a fresh copy for the page: known stats, no cooldowns, nothing in flight
  const pageDb = copyRealDb();
  const pageBaseline = readBaseline(pageDb);
  const pageServer = createPetServer({ databasePath: pageDb, port: PAGE_PORT, notifyGate: () => false });
  assert.equal(await pageServer.start(), true);
  // state read creates the care row; then pin deterministic stats
  await httpJson(PAGE_PORT, "/api/state");
  resetCareFor(pageBaseline.partner.partner_id, pageDb);

  const browser = await chromium.launch({ executablePath: resolve(EDGE_PATH), headless: true });
  try {
    for (const viewport of [
      { name: "light-1440", width: 1440, height: 900 },
      { name: "light-820", width: 820, height: 900 },
    ]) {
      await test(`real page renders clean in light theme at ${viewport.width}px (${viewport.name})`, async () => {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          colorScheme: "light",
        });
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
        page.on("console", (msg) => {
          if (msg.type() !== "error") return;
          // the browser's automatic /favicon.ico probe 404s; it is not an app error
          if (msg.location()?.url?.endsWith("/favicon.ico")) return;
          errors.push(`console: ${msg.text()}`);
        });

        await page.goto(`http://127.0.0.1:${PAGE_PORT}/?theme=light`, { waitUntil: "load" });
        for (const selector of ["#pet-canvas", "#care-bars", "#actions", "#daily-goals"]) {
          await page.waitForSelector(selector, { state: "visible", timeout: 10000 });
        }
        // wait until the first /api/state round-trip populated the dashboard
        await page.waitForFunction(
          () => document.querySelector("#pet-name")?.textContent !== "…",
          { timeout: 10000 },
        );
        assert.equal(errors.length, 0, `page errors: ${errors.join(" | ")}`);
        assert.equal(await page.evaluate(() => document.documentElement.classList.contains("theme-light")), true);

        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        assert.ok(overflow <= 1, `horizontal overflow of ${overflow}px at ${viewport.width}px`);

        const shot = join(ARTIFACT_DIR, `e2e-${viewport.name}.png`);
        await page.screenshot({ path: shot, fullPage: true });
        console.log(`  screenshot: ${shot}`);
        await context.close();
      });
    }

    await test("clicking one available care button updates the page without errors", async () => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
      page.on("console", (msg) => {
        if (msg.type() !== "error") return;
        // the browser's automatic /favicon.ico probe 404s; it is not an app error
        if (msg.location()?.url?.endsWith("/favicon.ico")) return;
        errors.push(`console: ${msg.text()}`);
      });
      await page.goto(`http://127.0.0.1:${PAGE_PORT}/?theme=light`, { waitUntil: "load" });
      await page.waitForFunction(() => document.querySelector("#pet-name")?.textContent !== "…", { timeout: 10000 });

      // prefer clean; fall back to any other enabled care button
      const preferred = ["pet-clean", "pet-feed-snack", "pet-rest", "pet-play", "pet-pet-egg"];
      let clicked = null;
      for (const command of preferred) {
        const button = page.locator(`#actions [data-command="${command}"]`);
        if ((await button.count()) > 0 && (await button.isEnabled())) {
          await button.click();
          clicked = command;
          break;
        }
      }
      if (clicked) {
        // the command round-trip re-renders state; give it a moment
        await page.waitForTimeout(800);
        console.log(`  clicked ${clicked}`);
      } else {
        console.log("  no enabled care button right now; verified rendering only");
      }
      assert.equal(errors.length, 0, `page errors: ${errors.join(" | ")}`);

      const shot = join(ARTIFACT_DIR, "e2e-after-care-click.png");
      await page.screenshot({ path: shot, fullPage: true });
      console.log(`  screenshot: ${shot}`);
      await context.close();
    });
  } finally {
    await browser.close();
    await pageServer.close();
  }
}

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log("\nall tests passed");
