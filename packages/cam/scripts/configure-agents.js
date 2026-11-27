import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const macBinary = "/Applications/magpie.app/Contents/MacOS/magpie";
const binary = process.env.MAGPIE_BIN || Bun.which("magpie") || (existsSync(macBinary) ? macBinary : null);
const args = process.argv.slice(2);
const server = args[0] && !args[0].startsWith("--") ? args.shift() : "cam";
const agentIds = /^[a-z][a-z0-9-]*(?:,[a-z][a-z0-9-]*)*$/;
if (args.length && (args.length !== 2 || args[0] !== "--agents" || !agentIds.test(args[1]))) {
  console.error("Usage: bun run configure:agents [server] [--agents opencode,cline,cursor]");
  process.exit(1);
}
const extraAgents = args.length ? args[1].split(",") : [];

if (!binary) {
  console.error("Magpie was not found. Set MAGPIE_BIN to its executable.");
  process.exit(1);
}

const shown = Bun.spawnSync([binary, "library", "mcp", "show", server], { stderr: "inherit" });
if (shown.exitCode !== 0) process.exit(shown.exitCode || 1);
const entry = JSON.parse(shown.stdout.toString());
const plugin = entry.plugin;
const manifest = typeof plugin === "string" && isAbsolute(plugin) ? Bun.file(join(plugin, "package.json")) : null;
const packageName = manifest && await manifest.exists() ? (await manifest.json()).name : plugin;
if (!["@magpie-community/cam", "@magpie-community/gateway-cam"].includes(packageName)) {
  console.error("The selected MCP entry is not a CAM plugin server.");
  process.exit(1);
}

const agents = [...new Set([...(entry.agents ?? []), "codex", "claude", ...extraAgents])];
const configured = Bun.spawnSync([binary, "library", "mcp", "agents", server, agents.join(",")], {
  stdout: "inherit",
  stderr: "inherit",
});
process.exitCode = configured.exitCode;
