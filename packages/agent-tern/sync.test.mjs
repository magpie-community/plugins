// Unit tests for the file fix-ups sync.mjs does beside magpie's own writes.
// Run with: bun test
//
// Every case writes into a temp directory; TERN_SYNC_DISABLE keeps the
// module's own timer and initial sync away from the real ~/.omp.

process.env.TERN_SYNC_DISABLE = "1";

import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _internal } from "./sync.mjs";

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `tern-sync-${label}-`));
}

function write(dir, name, text) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  return file;
}

function read(file) {
  return fs.readFileSync(file, "utf8");
}

test("an empty flow list is left byte for byte", () => {
  const dir = tempDir("empty");
  const file = write(dir, "config.yml", "enabledModels: []\n");
  const before = read(file);
  const result = _internal.mergeEnabledModels(file);
  expect(result.changed).toBe(false);
  expect(read(file)).toBe(before);
});

test("a flow list that already names magpie is not duplicated", () => {
  const dir = tempDir("flow-magpie");
  const file = write(dir, "config.yml", "enabledModels: [magpie/**, openai/*]\n");
  const before = read(file);
  const result = _internal.mergeEnabledModels(file);
  expect(result.changed).toBe(false);
  expect(read(file)).toBe(before);
});

test("a flow list gains magpie/** once, and a second pass is a no-op", () => {
  const dir = tempDir("flow-add");
  const file = write(dir, "config.yml", "# user comment\nenabledModels: [openai/*] # keep\n");
  const first = _internal.mergeEnabledModels(file);
  expect(first.changed).toBe(true);
  expect(read(file)).toBe("# user comment\nenabledModels: [openai/*, magpie/**] # keep\n");
  const second = _internal.mergeEnabledModels(file);
  expect(second.changed).toBe(false);
  expect(read(file)).toBe("# user comment\nenabledModels: [openai/*, magpie/**] # keep\n");
});

test("a block list keeps its entries and comments and gains one item", () => {
  const dir = tempDir("block");
  const file = write(
    dir,
    "config.yml",
    "modelRoles:\n  default: old/model\nenabledModels:\n  # mine\n  - openai/*\n  - claude-*\ntheme: dark\n",
  );
  const result = _internal.mergeEnabledModels(file);
  expect(result.changed).toBe(true);
  expect(read(file)).toBe(
    "modelRoles:\n  default: old/model\nenabledModels:\n  # mine\n  - openai/*\n  - claude-*\n  - magpie/**\ntheme: dark\n",
  );
  expect(_internal.mergeEnabledModels(file).changed).toBe(false);
});

test("an absent enabledModels is not invented", () => {
  const dir = tempDir("absent");
  const file = write(dir, "config.yml", "modelRoles:\n  default: old/model\n");
  const before = read(file);
  const result = _internal.mergeEnabledModels(file);
  expect(result.changed).toBe(false);
  expect(read(file)).toBe(before);
});

test("config.yaml becomes config.yml with the original kept as a backup", () => {
  const dir = tempDir("migrate");
  const body = "# old file\nmodelRoles:\n  default: old/model\ntheme: dark\n";
  write(dir, "config.yaml", body);
  const result = _internal.migrateConfigYaml(dir);
  expect(result.migrated).toBe(true);
  expect(read(path.join(dir, "config.yml"))).toBe(body);
  expect(read(path.join(dir, "config.yaml.magpie-backup"))).toBe(body);
  expect(fs.existsSync(path.join(dir, "config.yaml"))).toBe(false);
});
