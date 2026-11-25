#!/usr/bin/env node
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const source = "scripts/proc.mjs";
export const procTargets = [
  "packages/agent-console/lib/proc.mjs",
  "packages/agent-office/lib/proc.mjs",
  "packages/agy-cli/proc.mjs",
  "packages/astudio/proc.mjs",
  "packages/deepzora/proc.mjs",
  "packages/gcp-ai/lib/proc.mjs",
  "packages/gumloop/proc.mjs",
  "packages/goanyapi/src/proc.mjs",
  "packages/kimi-desktop/proc.mjs",
  "packages/mclaw/proc.mjs",
  "packages/nanobot/proc.mjs",
  "packages/nowledge-mem-agent/lib/proc.mjs",
  "packages/page-harnessweight/lib/proc.mjs",
  "packages/reasonix-desktop/proc.mjs",
  "packages/respire-memory/proc.mjs",
  "packages/search1api/src/proc.mjs",
  "packages/window-warmup/src/proc.mjs",
  "packages/worktree-compare/lib/proc.mjs",
];

const check = process.argv.includes("--check");
const bytes = readFileSync(resolve(root, source));
for (const relative of procTargets) {
  const target = resolve(root, relative);
  if (check) {
    try {
      if (!readFileSync(target).equals(bytes)) {
        console.error(`Out of sync: ${relative}`);
        process.exitCode = 1;
      }
    } catch (error) {
      console.error(`Missing sync target: ${relative} (${error?.code ?? error})`);
      process.exitCode = 1;
    }
    continue;
  }
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(resolve(root, source), target);
}
