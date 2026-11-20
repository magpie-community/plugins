import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

async function walk(path) {
  const result = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if ([".git", "node_modules"].includes(entry.name)) continue;
    const file = join(path, entry.name);
    if (entry.isDirectory()) result.push(...await walk(file));
    else if (/\.(?:mjs|js)$/.test(entry.name)) result.push(file);
  }
  return result;
}

for (const file of await walk(".")) {
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (result.status !== 0) process.exit(1);
}
const manifest = JSON.parse(await readFile("package.json", "utf8"));
if (manifest.magpie?.hooks !== "./hooks.mjs" || !manifest.keywords.includes("magpie-plugin") || manifest.license !== "Apache-2.0") process.exit(1);
if (manifest.magpie.options.capture !== false || manifest.magpie.options.bank !== "hermes" || manifest.magpie.options.recall_max_tokens !== 1024 || manifest.magpie.options.gatewayTimeoutMs !== 5000) process.exit(1);
console.log("Syntax and Magpie package metadata checked.");
