// lib/pet.care-store.mjs
// SQLite persistence for the care layer (Task 4). Owns only the new
// magpie_pet_* tables; upstream tables (partners, usage_receipts, ...) are
// read defensively and never written. All gameplay math stays in
// pet.care-rules.mjs — this module only adds transactions and storage.

import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

import {
  applyCareAction,
  careSummary,
  claimExpedition as ruleClaimExpedition,
  createDefaultCareState,
  decayCareState,
  evaluateAchievements,
  evaluateDailyGoals,
  startExpedition as ruleStartExpedition,
} from "./pet.care-rules.mjs";

export const MIGRATION_VERSION = 2;

// Purely decorative unlockables, paid for with data fragments only.
export const DECORATIONS = {
  meadow: { price: 10 },
  night: { price: 25 },
  terminal: { price: 40 },
};

// Small fragment reward per completed daily goal, claimable once per day.
export const DAILY_GOAL_REWARDS = { care: 2, expedition: 3, feed: 2 };

const DAY_MS = 24 * 60 * 60 * 1000;

const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS magpie_pet_care_state (
  partner_id TEXT PRIMARY KEY,
  satiety REAL NOT NULL,
  mood REAL NOT NULL,
  energy REAL NOT NULL,
  hygiene REAL NOT NULL,
  bond REAL NOT NULL,
  cooldown_snack INTEGER NOT NULL DEFAULT 0,
  cooldown_play INTEGER NOT NULL DEFAULT 0,
  cooldown_clean INTEGER NOT NULL DEFAULT 0,
  cooldown_rest INTEGER NOT NULL DEFAULT 0,
  cooldown_pet_egg INTEGER NOT NULL DEFAULT 0,
  last_decay_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS magpie_pet_care_events (
  event_id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  action TEXT,
  message TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS magpie_pet_care_events_partner_created_at
  ON magpie_pet_care_events (partner_id, created_at);
CREATE TABLE IF NOT EXISTS magpie_pet_expeditions (
  expedition_id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  claimed_at INTEGER,
  fragments INTEGER,
  bond INTEGER,
  note TEXT
);
CREATE INDEX IF NOT EXISTS magpie_pet_expeditions_partner_status
  ON magpie_pet_expeditions (partner_id, status);
CREATE TABLE IF NOT EXISTS magpie_pet_inventory (
  item_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 0,
  equipped INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS magpie_pet_achievements (
  achievement_id TEXT PRIMARY KEY,
  unlocked_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS magpie_pet_daily (
  date TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0,
  reward_claimed INTEGER NOT NULL DEFAULT 0,
  claimed_at INTEGER,
  PRIMARY KEY (date, goal_id)
);
`;

const MIGRATION_V2_SQL = `
CREATE TABLE IF NOT EXISTS magpie_pet_names (
  partner_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

function localDateString(nowMs) {
  const date = new Date(nowMs);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function localDayRangeMs(nowMs) {
  const date = new Date(nowMs);
  const startMs = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  return { startMs, endMs: startMs + DAY_MS };
}

function rowToCareState(row) {
  return {
    partnerId: row.partner_id,
    satiety: row.satiety,
    mood: row.mood,
    energy: row.energy,
    hygiene: row.hygiene,
    bond: row.bond,
    cooldowns: {
      snack: row.cooldown_snack,
      play: row.cooldown_play,
      clean: row.cooldown_clean,
      rest: row.cooldown_rest,
      petEgg: row.cooldown_pet_egg,
    },
    lastDecayAt: row.last_decay_at,
    updatedAt: row.updated_at,
  };
}

function rowToExpedition(row) {
  return {
    expeditionId: row.expedition_id,
    partnerId: row.partner_id,
    kind: row.kind,
    status: row.status,
    startedAt: row.started_at,
    endsAt: row.ends_at,
    claimedAt: row.claimed_at,
    fragments: row.fragments,
    bond: row.bond,
    note: row.note,
  };
}

export function createCareStore({ databasePath } = {}) {
  if (typeof databasePath !== "string" || databasePath.trim() === "") {
    throw new Error("createCareStore requires a databasePath");
  }
  const db = new Database(databasePath.trim());
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  let closed = false;

  function migrate() {
    const version = db.query("PRAGMA user_version").get().user_version;
    if (version >= MIGRATION_VERSION) return;
    const apply = db.transaction(() => {
      if (version < 1) {
        db.exec(MIGRATION_SQL);
        db.exec("PRAGMA user_version = 1");
      }
      if (version < 2) {
        db.exec(MIGRATION_V2_SQL);
        db.exec(`PRAGMA user_version = ${MIGRATION_VERSION}`);
      }
    });
    apply();
  }
  migrate();

  function tableExists(name) {
    const row = db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name);
    return row !== null && row !== undefined;
  }

  function readCareState(partnerId) {
    const row = db.query("SELECT * FROM magpie_pet_care_state WHERE partner_id = ?").get(partnerId);
    return row ? rowToCareState(row) : null;
  }

  function writeCareState(state) {
    db.query(
      `INSERT INTO magpie_pet_care_state (
         partner_id, satiety, mood, energy, hygiene, bond,
         cooldown_snack, cooldown_play, cooldown_clean, cooldown_rest, cooldown_pet_egg,
         last_decay_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(partner_id) DO UPDATE SET
         satiety = excluded.satiety, mood = excluded.mood, energy = excluded.energy,
         hygiene = excluded.hygiene, bond = excluded.bond,
         cooldown_snack = excluded.cooldown_snack, cooldown_play = excluded.cooldown_play,
         cooldown_clean = excluded.cooldown_clean, cooldown_rest = excluded.cooldown_rest,
         cooldown_pet_egg = excluded.cooldown_pet_egg,
         last_decay_at = excluded.last_decay_at, updated_at = excluded.updated_at`,
    ).run(
      state.partnerId,
      state.satiety,
      state.mood,
      state.energy,
      state.hygiene,
      state.bond,
      state.cooldowns.snack,
      state.cooldowns.play,
      state.cooldowns.clean,
      state.cooldowns.rest,
      state.cooldowns.petEgg,
      state.lastDecayAt,
      state.updatedAt,
    );
  }

  function insertEvent(partnerId, kind, action, message, nowMs) {
    db.query(
      "INSERT INTO magpie_pet_care_events (event_id, partner_id, kind, action, message, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(randomUUID(), partnerId, kind, action, message ?? null, nowMs);
  }

  function currentState(partnerId, nowMs) {
    const stored = readCareState(partnerId) ?? createDefaultCareState(partnerId, nowMs);
    return decayCareState(stored, nowMs);
  }

  function runningExpedition(partnerId) {
    const row = db
      .query("SELECT * FROM magpie_pet_expeditions WHERE partner_id = ? AND status = 'running'")
      .get(partnerId);
    return row ? rowToExpedition(row) : null;
  }

  function getFragments() {
    const row = db
      .query("SELECT quantity FROM magpie_pet_inventory WHERE item_id = 'fragments'")
      .get();
    return row ? row.quantity : 0;
  }

  function addFragments(delta) {
    db.query(
      "INSERT INTO magpie_pet_inventory (item_id, kind, quantity, equipped) VALUES ('fragments', 'currency', 0, 0) ON CONFLICT(item_id) DO NOTHING",
    ).run();
    db.query("UPDATE magpie_pet_inventory SET quantity = quantity + ? WHERE item_id = 'fragments'").run(delta);
  }

  function countEvolutions() {
    if (!tableExists("partners")) return 0;
    const row = db
      .query("SELECT COUNT(*) AS c FROM partners WHERE current_node_id NOT LIKE '0-%'")
      .get();
    return row.c;
  }

  function unlockAchievements(nowMs) {
    const counts = db
      .query(
        `SELECT
           COALESCE(SUM(CASE WHEN kind = 'care' THEN 1 ELSE 0 END), 0) AS total,
           COALESCE(SUM(CASE WHEN kind = 'care' AND action = 'clean' THEN 1 ELSE 0 END), 0) AS clean,
           COALESCE(SUM(CASE WHEN kind = 'expedition' THEN 1 ELSE 0 END), 0) AS expedition
         FROM magpie_pet_care_events`,
      )
      .get();
    const unlocked = evaluateAchievements({
      careEventCount: { total: counts.total, clean: counts.clean, expedition: counts.expedition },
      fragments: getFragments(),
      evolutionCount: countEvolutions(),
    });
    const newly = [];
    for (const id of unlocked) {
      const result = db
        .query("INSERT OR IGNORE INTO magpie_pet_achievements (achievement_id, unlocked_at) VALUES (?, ?)")
        .run(id, nowMs);
      if (result.changes > 0) {
        newly.push(id);
        insertEvent("global", "achievement", id, null, nowMs);
      }
    }
    return newly;
  }

  function listAchievements() {
    return db
      .query("SELECT achievement_id FROM magpie_pet_achievements ORDER BY unlocked_at, achievement_id")
      .all()
      .map((row) => row.achievement_id);
  }

  function readPetName(partnerId) {
    const row = db
      .query("SELECT name FROM magpie_pet_names WHERE partner_id = ?")
      .get(partnerId);
    return row ? row.name : null;
  }

  function writePetName(partnerId, name, nowMs) {
    db.query(
      `INSERT INTO magpie_pet_names (partner_id, name, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(partner_id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`,
    ).run(partnerId, name, nowMs);
  }

  function countFedRequestsToday(partnerId, startMs, endMs) {
    if (!tableExists("usage_receipts")) return 0;
    // usage_receipts.created_at is a UTC ISO string; bracket the local day by
    // instant so the count matches the local calendar date.
    const row = db
      .query(
        "SELECT COUNT(*) AS c FROM usage_receipts WHERE partner_id = ? AND created_at >= ? AND created_at < ?",
      )
      .get(partnerId, new Date(startMs).toISOString(), new Date(endMs).toISOString());
    return row.c;
  }

  // Recomputes today's goals and grants each done goal's reward at most once.
  function sweepDailyGoals(partnerId, nowMs) {
    const date = localDateString(nowMs);
    const { startMs, endMs } = localDayRangeMs(nowMs);
    const careEventsToday = db
      .query(
        "SELECT COUNT(*) AS c FROM magpie_pet_care_events WHERE partner_id = ? AND kind = 'care' AND created_at >= ? AND created_at < ?",
      )
      .get(partnerId, startMs, endMs).c;
    const expeditionClaimsToday = db
      .query(
        "SELECT COUNT(*) AS c FROM magpie_pet_care_events WHERE partner_id = ? AND kind = 'expedition' AND created_at >= ? AND created_at < ?",
      )
      .get(partnerId, startMs, endMs).c;
    const fedRequestsToday = countFedRequestsToday(partnerId, startMs, endMs);

    const goals = evaluateDailyGoals({ careEventsToday, fedRequestsToday, expeditionClaimsToday });
    return goals.map((goal) => {
      db.query(
        `INSERT INTO magpie_pet_daily (date, goal_id, progress, done, reward_claimed, claimed_at)
         VALUES (?, ?, ?, ?, 0, NULL)
         ON CONFLICT(date, goal_id) DO UPDATE SET progress = excluded.progress, done = excluded.done`,
      ).run(date, goal.id, goal.progress, goal.done ? 1 : 0);
      let rewardClaimed = false;
      if (goal.done) {
        const stored = db
          .query("SELECT reward_claimed FROM magpie_pet_daily WHERE date = ? AND goal_id = ?")
          .get(date, goal.id);
        if (stored.reward_claimed === 1) {
          rewardClaimed = true;
        } else {
          const reward = DAILY_GOAL_REWARDS[goal.id] ?? 0;
          if (reward > 0) addFragments(reward);
          db.query(
            "UPDATE magpie_pet_daily SET reward_claimed = 1, claimed_at = ? WHERE date = ? AND goal_id = ?",
          ).run(nowMs, date, goal.id);
          insertEvent(partnerId, "daily", goal.id, null, nowMs);
          rewardClaimed = true;
        }
      }
      return { ...goal, rewardClaimed };
    });
  }

  function assertReadable() {
    if (closed) throw new Error("care store is closed");
  }

  const txPerformAction = db.transaction((partnerId, action, nowMs, context) => {
    const state = currentState(partnerId, nowMs);
    const result = applyCareAction(state, action, nowMs, context ?? {});
    if (!result.ok) return { ok: false, reason: result.reason, message: result.message };
    writeCareState(result.state);
    insertEvent(partnerId, "care", action, result.message, nowMs);
    sweepDailyGoals(partnerId, nowMs);
    const achievements = unlockAchievements(nowMs);
    return { ok: true, message: result.message, state: result.state, achievements };
  });

  const txStartExpedition = db.transaction((partnerId, kind, nowMs) => {
    const state = currentState(partnerId, nowMs);
    const result = ruleStartExpedition({
      careState: state,
      activeExpedition: runningExpedition(partnerId),
      kind,
      nowMs,
    });
    if (!result.ok) return { ok: false, reason: result.reason };
    writeCareState(result.careState);
    const expedition = result.expedition;
    db.query(
      `INSERT INTO magpie_pet_expeditions (expedition_id, partner_id, kind, status, started_at, ends_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      expedition.expeditionId,
      expedition.partnerId,
      expedition.kind,
      expedition.status,
      expedition.startedAt,
      expedition.endsAt,
    );
    insertEvent(partnerId, "expedition-start", kind, null, nowMs);
    return { ok: true, expedition, state: result.careState };
  });

  const txClaimExpedition = db.transaction((expeditionId, nowMs) => {
    const row = db
      .query("SELECT * FROM magpie_pet_expeditions WHERE expedition_id = ?")
      .get(expeditionId);
    const expedition = row ? rowToExpedition(row) : null;
    const result = ruleClaimExpedition({ expedition, nowMs, random: Math.random });
    if (!result.ok) return { ok: false, reason: result.reason };
    const reward = result.reward;
    db.query(
      "UPDATE magpie_pet_expeditions SET status = 'claimed', claimed_at = ?, fragments = ?, bond = ?, note = ? WHERE expedition_id = ?",
    ).run(nowMs, reward.fragments, reward.bond, reward.note, expeditionId);

    const state = currentState(expedition.partnerId, nowMs);
    const nextState = { ...state, bond: Math.min(100, state.bond + reward.bond), updatedAt: nowMs };
    writeCareState(nextState);
    addFragments(reward.fragments);
    insertEvent(expedition.partnerId, "expedition", expedition.kind, reward.note, nowMs);
    sweepDailyGoals(expedition.partnerId, nowMs);
    const achievements = unlockAchievements(nowMs);
    return { ok: true, expeditionId, reward, achievements };
  });

  const txEquipDecoration = db.transaction((decorationId, nowMs) => {
    const def = DECORATIONS[decorationId];
    if (!def) return { ok: false, reason: "unknown-decoration" };
    const owned = db
      .query("SELECT item_id FROM magpie_pet_inventory WHERE item_id = ? AND kind = 'decoration'")
      .get(decorationId);
    if (!owned) {
      const fragments = getFragments();
      if (fragments < def.price) return { ok: false, reason: "insufficient-fragments" };
      addFragments(-def.price);
      db.query(
        "INSERT INTO magpie_pet_inventory (item_id, kind, quantity, equipped) VALUES (?, 'decoration', 1, 0)",
      ).run(decorationId);
      insertEvent("global", "decoration", decorationId, null, nowMs);
    }
    db.query("UPDATE magpie_pet_inventory SET equipped = 0 WHERE kind = 'decoration'").run();
    db.query("UPDATE magpie_pet_inventory SET equipped = 1 WHERE item_id = ?").run(decorationId);
    const achievements = unlockAchievements(nowMs);
    return { ok: true, equippedTheme: decorationId, fragments: getFragments(), achievements };
  });

  return {
    getCareSnapshot(partnerId, nowMs) {
      assertReadable();
      const run = db.transaction(() => {
        const state = currentState(partnerId, nowMs);
        writeCareState(state);
        const goals = sweepDailyGoals(partnerId, nowMs);
        unlockAchievements(nowMs);
        return {
          partnerId,
          petName: readPetName(partnerId),
          state,
          summary: careSummary(state),
          activeExpedition: runningExpedition(partnerId),
          daily: { date: localDateString(nowMs), goals },
          achievements: listAchievements(),
        };
      });
      return run();
    },

    performAction(partnerId, action, nowMs, context) {
      if (closed) return { ok: false, reason: "closed" };
      return txPerformAction(partnerId, action, nowMs, context);
    },

    startExpedition(partnerId, kind, nowMs) {
      if (closed) return { ok: false, reason: "closed" };
      return txStartExpedition(partnerId, kind, nowMs);
    },

    claimExpedition(expeditionId, nowMs) {
      if (closed) return { ok: false, reason: "closed" };
      return txClaimExpedition(expeditionId, nowMs);
    },

    equipDecoration(decorationId) {
      if (closed) return { ok: false, reason: "closed" };
      return txEquipDecoration(decorationId, Date.now());
    },

    getPetName(partnerId) {
      assertReadable();
      return readPetName(partnerId);
    },

    renamePet(partnerId, name, nowMs) {
      if (closed) return { ok: false, reason: "closed" };
      const clean = String(name ?? "").trim().replace(/\s+/g, " ");
      if (clean.length < 1 || clean.length > 20) return { ok: false, reason: "invalid-name" };
      const run = db.transaction(() => {
        writePetName(partnerId, clean, nowMs);
        insertEvent(partnerId, "care", "rename", `给它取名为「${clean}」`, nowMs);
      });
      run();
      return { ok: true, name: clean };
    },

    getCollection() {
      assertReadable();
      const decorations = db
        .query("SELECT item_id, equipped FROM magpie_pet_inventory WHERE kind = 'decoration' ORDER BY item_id")
        .all();
      const equipped = decorations.find((row) => row.equipped === 1);
      return {
        fragments: getFragments(),
        unlocked: decorations.map((row) => row.item_id),
        equippedTheme: equipped ? equipped.item_id : null,
        achievements: listAchievements(),
      };
    },

    close() {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}
