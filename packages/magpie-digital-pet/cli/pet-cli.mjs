#!/usr/bin/env bun
// magpie-digital-pet · CLI
// Run with bun (the engine uses bun:sqlite):
//   bun cli/pet-cli.mjs status
//   bun cli/pet-cli.mjs spawn          # hatch a new egg (generation N)
//   bun cli/pet-cli.mjs freeze         # stop growth (usage no longer counts)
//   bun cli/pet-cli.mjs unfreeze
//   bun cli/pet-cli.mjs set 4-001      # pin a specific Digimon (cheat)
//   bun cli/pet-cli.mjs events [n]     # last n engine events (default 10)
//   bun cli/pet-cli.mjs partners       # every generation you raised

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";

const HERE = import.meta.dir;
const ADAPTER = join(HERE, "..", "lib", "pet.adapter.mjs");
const { createPetAdapter, nodeById, defaultDatabasePath, migrateLegacyDatabase } = await import(ADAPTER);
const { createCareStore } = await import(join(HERE, "..", "lib", "pet.care-store.mjs"));

const STAGE_NAMES = ["egg", "baby I", "baby II", "child", "adult", "perfect", "ultimate", "super ultimate"];
const STAGE_THRESHOLDS = [1e7, 2e7, 4e7, 8e7, 15e7, 25e7, 4e8, 6e8];

const argv = process.argv.slice(2);
const dbFlagIndex = argv.indexOf("--db");
const dbPath = dbFlagIndex !== -1 ? argv[dbFlagIndex + 1] : defaultDatabasePath();
if (dbFlagIndex !== -1) argv.splice(dbFlagIndex, 2);
else migrateLegacyDatabase(dbPath);

function fmtTokens(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

function nodeLabel(id) {
  const node = nodeById(id);
  if (!node) return `${id} (unknown)`;
  return `${node.name_en} · ${node.name_jp} [${id}]`;
}

function openReadOnly() {
  if (!existsSync(dbPath)) return null;
  const db = new Database(dbPath, { readonly: true });
  db.run("PRAGMA busy_timeout = 5000");
  return db;
}

const EXPEDITION_KIND_NAMES = { patrol: "短巡逻", field: "数据原野", night: "深夜远征" };

// Read-only care summary for `status`. Uses the care store's read APIs only
// (getCareSnapshot/getCollection) and always closes the store afterwards;
// care and expedition writes stay on the sidebar pet page.
function printCareSummary(partnerId) {
  const store = createCareStore({ databasePath: dbPath });
  try {
    const nowMs = Date.now();
    const { state, summary, activeExpedition } = store.getCareSnapshot(partnerId, nowMs);
    const collection = store.getCollection();
    const r = (v) => Math.round(v);
    console.log(`care      饱食 ${r(state.satiety)} · 心情 ${r(state.mood)} · 精力 ${r(state.energy)} · 清洁 ${r(state.hygiene)}（${summary.moodLabel}）`);
    console.log(`bond      亲密 ${r(state.bond)}`);
    console.log(`fragments 数据碎片 ${collection.fragments} · 装饰 ${collection.unlocked.length} 件 · 成就 ${collection.achievements.length} 项`);
    if (activeExpedition) {
      const kind = EXPEDITION_KIND_NAMES[activeExpedition.kind] ?? activeExpedition.kind;
      const remainMin = Math.ceil(Math.max(0, activeExpedition.endsAt - nowMs) / 60000);
      console.log(`expedition ${kind}进行中 · 剩余约 ${remainMin} 分钟`);
    } else {
      console.log(`expedition 无进行中探险（去侧边栏「宠物」页派出）`);
    }
  } finally {
    store.close();
  }
}

function status() {
  const db = openReadOnly();
  if (!db) {
    console.log(`no database yet at ${dbPath}`);
    console.log("run `bun cli/pet-cli.mjs spawn` to hatch your first partner.");
    return;
  }
  const trainer = db.query("SELECT total_tokens FROM trainer_state WHERE trainer_id = 1").get();
  const control = db.query("SELECT frozen, cheat_node_id FROM vpet_control_state WHERE control_id = 1").get();
  const partner = db
    .query(
      `SELECT partner_id, generation, current_node_id, gauge, is_terminal,
              pending_evolution_target_id, battle_opponent_node_id, created_at, retired_at
       FROM partners
       WHERE partner_id = (SELECT principal_id FROM partner_team WHERE team_id = 1)
         AND retired_at IS NULL LIMIT 1`,
    )
    .get();
  const receipts = db.query("SELECT COUNT(*) c, SUM(token_delta) t FROM usage_receipts").get();

  console.log(`db        ${dbPath}`);
  console.log(`fed       ${receipts.c} requests · ${fmtTokens(receipts.t ?? 0)} tokens (all-time)`);
  console.log(`trainer   ${fmtTokens(trainer?.total_tokens ?? 0)} tokens`);
  if (control?.cheat_node_id) {
    console.log(`mode      pinned to ${nodeLabel(control.cheat_node_id)} (set; no growth)`);
  } else if (control?.frozen === 1) {
    console.log(`mode      frozen (usage is recorded, pet does not grow)`);
  }
  if (!partner) {
    console.log(`partner   none — run \`spawn\``);
  } else {
    const node = nodeById(partner.current_node_id);
    const stage = node?.stage ?? 0;
    const threshold = STAGE_THRESHOLDS[stage] ?? 0;
    const pct = threshold > 0 ? ((partner.gauge / threshold) * 100).toFixed(2) : "?";
    console.log(`partner   gen ${partner.generation} · ${nodeLabel(partner.current_node_id)}`);
    console.log(`          stage ${STAGE_NAMES[stage] ?? stage} · gauge ${fmtTokens(partner.gauge)} / ${fmtTokens(threshold)} (${pct}%)`);
    if (partner.battle_opponent_node_id) {
      console.log(`          evolution battle pending vs ${nodeLabel(partner.battle_opponent_node_id)}`);
    }
    printCareSummary(partner.partner_id);
  }
  db.close();
}

async function command(name, args) {
  const adapter = createPetAdapter({ databasePath: dbPath });
  const result = await adapter.runCommand(name, args);
  if (result.text) console.log(result.text);
  for (const t of result.toasts) {
    console.log(`» ${[t?.title, t?.message].filter(Boolean).join(" — ")}`);
  }
  if (!result.text && !result.toasts.length) console.log("(no output)");
}

function events(n = 10) {
  const db = openReadOnly();
  if (!db) return console.log("no database yet.");
  const rows = db
    .query(
      `SELECT event_id, partner_id, kind, current_node_id, gauge, token_delta, created_at
       FROM partner_events ORDER BY created_at DESC, event_id DESC LIMIT ?`,
    )
    .all(n);
  for (const r of rows) {
    console.log(
      `${r.created_at}  ${r.kind.padEnd(16)} ${nodeById(r.current_node_id)?.name_en ?? r.current_node_id}  gauge=${fmtTokens(r.gauge ?? 0)}  +${fmtTokens(r.token_delta ?? 0)}`,
    );
  }
  db.close();
}

function partners() {
  const db = openReadOnly();
  if (!db) return console.log("no database yet.");
  const rows = db
    .query(
      `SELECT partner_id, generation, current_node_id, is_terminal, created_at, retired_at
       FROM partners ORDER BY generation ASC`,
    )
    .all();
  for (const r of rows) {
    const state = r.retired_at ? `retired ${r.retired_at.slice(0, 10)}` : "active";
    console.log(`gen ${String(r.generation).padEnd(3)} ${nodeLabel(r.current_node_id)}  ${state}`);
  }
  db.close();
}

const [cmd, ...rest] = argv;
switch (cmd) {
  case "status":
    status();
    break;
  case "spawn":
    await command("digital-pet-spawn");
    status();
    break;
  case "freeze":
    await command("digital-pet-freeze");
    break;
  case "unfreeze":
    await command("digital-pet-unfreeze");
    break;
  case "set":
    if (!rest[0]) {
      console.log("usage: set <digimon-id>   e.g. set 4-001");
      process.exit(1);
    }
    await command("digital-pet-set", rest[0]);
    break;
  case "events":
    events(Number(rest[0]) > 0 ? Math.min(Number(rest[0]), 100) : 10);
    break;
  case "partners":
    partners();
    break;
  default:
    console.log(`magpie-digital-pet CLI
db: ${dbPath}

  status              pet, gauge, progress and read-only care summary
  spawn               hatch a new egg
  freeze | unfreeze   stop / resume growth
  set <id>            pin a Digimon (cheat; no growth while pinned)
  events [n]          last n engine events
  partners            every generation raised
  --db <path>         use another database`);
    process.exit(cmd ? 1 : 0);
}
