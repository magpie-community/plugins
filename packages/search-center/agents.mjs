import fs from "node:fs";
import { execFile } from "node:child_process";
import { fault } from "./catalog.mjs";
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {MAGPIE_HOME, MAGPIE_BIN} from './runtime.mjs';
const LIBRARY = path.join(MAGPIE_HOME,'library.json');
export const MCP_NAME = "magpie-search-center";
const installedPath=path.resolve(fileURLToPath(new URL('.',import.meta.url))).replaceAll('\\','/').toLowerCase();
function ownsEntry(entry) {
  if (entry.plugin && path.isAbsolute(entry.plugin)) return path.resolve(entry.plugin).replaceAll('\\','/').toLowerCase()===installedPath;
  return entry.name===MCP_NAME || entry.plugin===MCP_NAME;
}
const names = { agy: "Antigravity", claude: "Claude Code", "claude-desktop": "Claude Desktop",
  codex: "Codex", cursor: "Cursor", opencode: "OpenCode", dsh: "DSH", pi: "Pi",
  gemini: "Gemini CLI", droid: "Droid", kimi: "Kimi" };
export function agentView() {
  if (!fs.existsSync(LIBRARY)) return [];
  const j = JSON.parse(fs.readFileSync(LIBRARY, "utf8"));
  const entry = j.mcp.find(ownsEntry);
  const ids = new Set([...Object.keys(j.applied || {}), ...Object.keys(names)]);
  return [...ids].filter(id => /^[a-z0-9@:_-]{1,80}$/.test(id)).map(id => ({
    id, name: names[id] || id, selected: entry?.agents?.includes(id) || false,
    detected: Object.hasOwn(j.applied || {}, id),
  }));
}
export async function setAgents(ids) {
  const known = new Set(agentView().map(x => x.id));
  if (!Array.isArray(ids) || ids.length > 40 || ids.some(id => !known.has(id))) throw fault("Agent 列表无效");
  await new Promise((resolve, reject) => {
    const j=JSON.parse(fs.readFileSync(LIBRARY,'utf8'));
    const entry=j.mcp.find(ownsEntry);
    if (!entry) return reject(fault('请先在 Magpie 中安装此插件，再分配 Agent'));
    execFile(MAGPIE_BIN,
      ["library", "mcp", "agents", entry.name, ids.length ? [...new Set(ids)].join(",") : "none"],
      { windowsHide: true, timeout: 30000 }, error => error ? reject(fault("喜鹊未完成应用，请稍后再试", "APPLY_FAILED", 502)) : resolve());
  });
  return agentView();
}
