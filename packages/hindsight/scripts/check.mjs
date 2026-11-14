import { readdir, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

async function walk(path) {
  const result = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if ([".git", "node_modules", "_scratch"].includes(entry.name)) continue;
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
const options = manifest.magpie?.options ?? {};
if (manifest.magpie?.hooks !== "./hooks.mjs") process.exit(1);
if (manifest.license !== "MIT AND Apache-2.0") process.exit(1);
for (const keyword of ["magpie", "magpie-gateway"]) if (!manifest.keywords.includes(keyword)) process.exit(1);
// Both license texts ship, because the inherited portions are Apache-2.0.
for (const file of ["LICENSE", "LICENSE-APACHE", "NOTICE"]) await access(file);
// A published default must never carry a credential or an unbounded window.
if (options.capture !== false) process.exit(1);
if (options.bank !== "hermes" || options.recall_max_tokens !== 1024 || options.gatewayTimeoutMs !== 5000) process.exit(1);
if (options.api_key !== "" || options.authorizationEnv !== "" || options.max_replay_blocks !== 8) process.exit(1);
// The list icon is carried inline: it must not point at a path that ships only
// inside the package, and it must not be a remote URL that can rot.
if (!/^data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+$/.test(manifest.magpie?.icon ?? "")) process.exit(1);
const declared = new Set(Object.keys(options));
for (const key of ["api_key", "api_key_header", "api_key_prefix", "authorizationEnv", "max_replay_blocks"]) {
  if (!declared.has(key)) process.exit(1);
}
console.log("Syntax and Magpie package metadata checked.");
