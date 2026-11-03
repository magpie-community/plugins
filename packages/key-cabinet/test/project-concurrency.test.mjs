import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveEnv } from "./env.mjs";

// Only fixture CLI and disposable data are used; no real Magpie keys are touched.
test("concurrent writes and failed model restrictions", async () => {
  const restoreEnv = saveEnv(["MAGPIE_BIN", "MAGPIE_CONFIG_DIR", "FIXTURE_LOG", "MAGPIE_PROJECT_KEYS_GATEWAY"]);
  const dir = await mkdtemp(join(tmpdir(), "key-cabinet-races-"));
  const bin = join(dir, "magpie");
  const log = join(dir, "commands.log");
  await writeFile(bin, `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FIXTURE_LOG, args.join(' ') + '\\n');
if (args[1] === 'add') console.log('id: 123456789012345678901234\\nsk-magpie-key-abcdef123456');
else if (args[1] === 'models' && args.includes('bad-model')) { console.error('model restriction failed'); process.exit(1); }
else if (args[1] !== 'remove' && args[1] !== 'models') process.exit(1);
`, { mode: 0o700 });
  process.env.MAGPIE_BIN = bin;
  process.env.MAGPIE_CONFIG_DIR = dir;
  process.env.FIXTURE_LOG = log;
  process.env.MAGPIE_PROJECT_KEYS_GATEWAY = "http://127.0.0.1:3425";
  const { createProject, listProjects } = await import("../lib/projects.mjs");
  try {
    await Promise.all(Array.from({ length: 5 }, (_, i) => createProject({ name: `Key ${i}`, slug: `key-${i}` })));
    assert.equal((await listProjects()).length, 5);
    await assert.rejects(createProject({ name: "Bad", slug: "bad", model: "bad-model" }), /model restriction failed/);
    assert.equal((await listProjects()).length, 5);
    assert.match(await readFile(log, "utf8"), /gateway-key remove 123456789012345678901234/);
    const duplicate = await Promise.allSettled([createProject({ name: "Same", slug: "same" }), createProject({ name: "Same", slug: "same" })]);
    assert.equal(duplicate.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal((await listProjects()).length, 6);
  } finally {
    await rm(dir, { recursive: true, force: true });
    restoreEnv();
  }
});
