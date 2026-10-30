// tests/docs-contract.test.mjs
// Static contract for user-facing docs and the CLI summary (Task 7):
// README and the settings panel agree on the real database path
// (<插件目录>\data\pet.db), README documents the new care gameplay, the
// package version is bumped to 0.4.0, and the CLI status command prints a
// read-only care summary without gaining any new write command branches.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);

const readme = readFileSync(join(ROOT, "README.md"), "utf8");
const panel = readFileSync(join(ROOT, "ui", "panel.html"), "utf8");
const cli = readFileSync(join(ROOT, "cli", "pet-cli.mjs"), "utf8");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const { defaultDatabasePath, legacyDatabasePath, GROWTH_THRESHOLDS } = await import("../lib/pet.adapter.mjs");

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}`);
    console.error(error.message);
  }
}

test("package.json version is 0.5.0 and keeps the porting lineage", () => {
  assert.equal(pkg.version, "0.5.0");
  assert.match(pkg.description, /@jcendal\/opencode-digital-pet 0\.18\.0/, "must keep upstream attribution");
  assert.match(pkg.description, /never touches agents' contexts/i, "must keep the no-agent-context promise");
});

test("README states the save lives in the user data directory, separate from plugin code", () => {
  assert.ok(readme.includes("%APPDATA%\\magpie-digital-pet\\pet.db"), "README must name the Windows save path");
  assert.ok(readme.includes("与插件代码目录分离"), "README must document code/save separation");
  assert.ok(readme.includes("自动从旧版"), "README must document legacy migration");
});

test("default save path is outside the plugin code directory", () => {
  assert.notEqual(defaultDatabasePath(), legacyDatabasePath());
  assert.ok(defaultDatabasePath().includes("magpie-digital-pet"));
  assert.ok(legacyDatabasePath().includes(join("data", "pet.db")));
});

test("growth thresholds are locked to twice the original pace", () => {
  assert.equal(GROWTH_THRESHOLDS.egg, 10_000_000);
  assert.equal(GROWTH_THRESHOLDS.babyI, 20_000_000);
  assert.equal(GROWTH_THRESHOLDS.superUltimate, 600_000_000);
});

test("README documents the new care gameplay on the sidebar pet page", () => {
  for (const keyword of ["日常照顾", "探险", "每日目标", "装饰", "宠物", "侧边栏"]) {
    assert.ok(readme.includes(keyword), `README must mention ${keyword}`);
  }
});

test("README test section lists every module test plus selftest", () => {
  for (const file of [
    "pet-frames.test.mjs",
    "pet-care-rules.test.mjs",
    "pet-progression-rules.test.mjs",
    "pet-care-store.test.mjs",
    "pet-server-care.test.mjs",
    "page-contract.test.mjs",
    "docs-contract.test.mjs",
    "e2e-page.test.mjs",
    "selftest.mjs",
  ]) {
    assert.ok(readme.includes(file), `README test list missing ${file}`);
  }
  assert.ok(readme.includes("PET_E2E_PLAYWRIGHT"), "README must document the optional browser env");
  assert.ok(readme.includes("PET_E2E_EDGE"), "README must document the optional browser executable env");
});

test("README keeps the original CLI command documentation", () => {
  for (const cmd of ["status", "spawn", "freeze", "unfreeze", "events", "partners", "set 4-001"]) {
    assert.ok(readme.includes(cmd), `README must keep documenting \`${cmd}\``);
  }
});

test("settings panel points at the user-data database, separate from plugin code", () => {
  assert.ok(panel.includes("%APPDATA%\\magpie-digital-pet\\pet.db"), "panel must name the user-data save path");
  assert.ok(panel.includes("个人存档与插件代码分离"), "panel must document code/save separation");
  assert.ok(panel.includes("dbPath"), "panel must mention the dbPath override");
});

test("settings panel explains care and expeditions happen on the sidebar pet page", () => {
  assert.match(panel, /宠物页/, "panel must point to the sidebar pet page");
  assert.match(panel, /照顾/, "panel must mention care actions");
  assert.match(panel, /探险/, "panel must mention expeditions");
});

test("CLI status prints the four read-only summary lines", () => {
  for (const label of ["care", "bond", "fragments", "expedition"]) {
    const re = new RegExp(`console\\.log\\(\\\`${label}\\s`);
    assert.ok(re.test(cli), `pet-cli.mjs must print a \`${label}\` summary line`);
  }
});

test("CLI summary is read-only: no new write command branches", () => {
  const cases = [...cli.matchAll(/case "([^"]+)":/g)].map((m) => m[1]);
  assert.deepEqual(
    [...cases].sort(),
    ["events", "freeze", "partners", "set", "spawn", "status", "unfreeze"],
    "the command switch must keep exactly the original seven commands",
  );
  for (const writeCall of ["performAction(", "startExpedition(", "claimExpedition(", "equipDecoration("]) {
    assert.ok(!cli.includes(writeCall), `CLI must not call ${writeCall}`);
  }
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log("\nall tests passed");
