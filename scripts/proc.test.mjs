import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { processAlive, processExists, processProbe, processStatus, processZombie } from "./proc.mjs";
import { procTargets } from "./sync-proc.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const canonical = readFileSync(new URL("./proc.mjs", import.meta.url), "utf8");
const err = (code) => {
  throw Object.assign(new Error(code), { code });
};
const deps = (content, killImpl = () => {}) => ({
  procRoot: "/fake-proc",
  platform: "linux",
  readFile: (file) => {
    if (content === undefined) err("EACCES");
    // proc.mjs joins with the system's separator, "\" on Windows
    if (file === join("/fake-proc", "123", "stat")) return content;
    err("ENOENT");
  },
  kill: killImpl,
});
const stat = (comm, state) => `123 (${comm}) ${state} 1 2 3 4 5 6 7 8 9`;

test("zombie detection accepts every proc comm spelling", () => {
  assert.equal(processZombie(123, deps(stat("comm)", "Z"))), true);
  assert.equal(processZombie(123, deps(stat("a ) b ) c", "X"))), true);
  assert.equal(processZombie(123, deps(stat("(weird)", "R"))), false);
  assert.equal(processZombie(123, deps("123 (comm R")), false);
});

test("invalid pids and unreadable proc states never report zombie", () => {
  for (const pid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(processZombie(pid, deps(stat("comm", "Z"))), false);
    assert.equal(processAlive(pid, deps(stat("comm", "Z"))), false);
    assert.equal(processExists(pid, deps(stat("comm", "Z"))), false);
  }
  assert.equal(processZombie(123, deps(undefined, err)), false);
});

test("processProbe keeps unknown outcomes separate from invalid and dead", () => {
  assert.equal(processProbe(0, deps(stat("comm", "R"))), "invalid");
  assert.equal(processProbe(123, deps(stat("comm)", "Z"))), "dead");
  assert.equal(processProbe(123, deps(stat("comm", "X"))), "dead");
  assert.equal(processProbe(123, deps(stat("comm", "R"))), "alive");
  assert.equal(processProbe(123, deps(stat("comm", "R"), () => err("EPERM"))), "permission");
  assert.equal(processProbe(123, deps(stat("comm)", "Z"), () => err("EPERM"))), "dead");
  assert.equal(processProbe(123, deps(undefined, () => err("EPERM"))), "permission");
  assert.equal(processProbe(123, deps("123 (comm R", () => err("EPERM"))), "permission");
  assert.equal(processProbe(123, deps(undefined, () => err("ESRCH"))), "dead");
  assert.equal(processProbe(123, deps(undefined, () => err("EIO"))), "unknown");
});

test("processStatus preserves the original unexpected kill error", () => {
  const failure = Object.assign(new Error("EIO"), { code: "EIO" });
  const status = processStatus(123, deps(stat("comm", "R"), () => { throw failure; }));
  assert.equal(status.state, "unknown");
  assert.equal(status.error, failure);
});

test("processAlive keeps boolean semantics and rejects zombies", () => {
  assert.equal(processAlive(123, deps(stat("comm)", "Z"))), false);
  assert.equal(processAlive(123, deps(stat("comm", "X"))), false);
  assert.equal(processAlive(123, deps(stat("comm", "R"))), true);
  assert.equal(processAlive(123, deps(stat("comm", "R"), () => err("EPERM"))), true);
  assert.equal(processAlive(123, deps(undefined, () => err("EPERM"))), true);
  assert.equal(processAlive(123, deps(undefined, () => err("ESRCH"))), false);
  assert.equal(processAlive(123, deps(undefined, () => err("EIO"))), false);
});

test("processExists is conservative except for ESRCH", () => {
  assert.equal(processExists(123, deps(stat("comm)", "Z"))), false);
  assert.equal(processExists(123, deps(stat("comm", "X"))), false);
  assert.equal(processExists(123, deps(stat("comm", "R"))), true);
  assert.equal(processExists(123, deps(undefined, () => err("EPERM"))), true);
  assert.equal(processExists(123, deps(undefined, () => err("ESRCH"))), false);
  assert.equal(processExists(123, deps(undefined, () => err("EIO"))), true);
});

test("non-Linux platforms do not require procfs", () => {
  const darwin = { ...deps(stat("comm", "Z")), platform: "darwin" };
  assert.equal(processAlive(123, darwin), true);
  assert.equal(processExists(123, darwin), true);
  assert.equal(processProbe(123, { ...deps(undefined, () => err("EPERM")), platform: "darwin" }), "permission");
});

test("runtime proc copies match the canonical implementation", () => {
  assert.equal(procTargets.length, 18);
  for (const relative of procTargets) {
    const target = `${root}${relative}`;
    assert.deepEqual(readFileSync(target, "utf8"), canonical, relative);
    const name = relative.split("/")[1];
    const importers = {
      "agent-console": ["index.mjs", "daemon/src/util/proc.ts"],
      "agent-office": ["lib/scan.mjs", "lib/jump.mjs"],
      "agy-cli": ["index.mjs"],
      astudio: ["browser.mjs"],
      deepzora: ["bridge.mjs"],
      "gcp-ai": ["lib/lock.mjs"],
      gumloop: ["gumloop.mjs"],
      "github-stats": ["src/config.ts"],
      goanyapi: ["src/auth.ts"],
      "kimi-desktop": ["adapter.mjs"],
      mclaw: ["browser.mjs"],
      nanobot: ["runtime.mjs", "bridge.mjs"],
      "nowledge-mem-agent": ["lib/files.mjs"],
      "page-harnessweight": ["harnessweight.hooks.mjs"],
      "reasonix-desktop": ["bridge.mjs"],
      "respire-memory": ["lock.mjs"],
      search1api: ["src/auth.ts"],
      "window-warmup": ["src/store.ts"],
    };
    for (const importer of importers[name]) {
      assert.match(
        readFileSync(`${root}packages/${name}/${importer}`, "utf8"),
        /["'](?:\.\/proc\.mjs|\.\/lib\/proc\.mjs|\.\.\/\.\.\/\.\.\/lib\/proc\.mjs)["']/,
        `packages/${name}/${importer}`,
      );
    }
  }
});

// #1164: a kill(pid, 0) of its own takes a zombie for a live process. A
// package that asks whether a pid lives goes through its proc.mjs copy.
test("no package asks kill(pid, 0) beside its proc.mjs", () => {
  const { readdirSync } = require("node:fs");
  const { relative, sep } = require("node:path");
  const skip = /(^|\/)(node_modules|dist|test|tests|scripts|\.git)(\/|$)|\.test\.|(^|\/)proc\.mjs$|\.min\.js$|vendor/;
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      // the skip list is written with "/", as relative() gives off Windows
      const rel = relative(root, path).split(sep).join("/");
      if (skip.test(rel)) continue;
      if (entry.isDirectory()) walk(path);
      else if (/\.(mjs|js|cjs|ts|mts)$/.test(entry.name) && /process\.kill\(\s*[\w.$]+\s*,\s*0\s*\)/.test(readFileSync(path, "utf8"))) found.push(rel);
    }
  };
  walk(join(root, "packages"));
  assert.deepEqual(found, []);
});
