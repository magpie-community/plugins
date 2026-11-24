// 本文由AI自动生成
// 路径与网关地址：全部只读推导，不写 magpie 的配置文件。

import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

export function configDir() {
  if (process.env.MAGPIE_CONFIG_DIR) return process.env.MAGPIE_CONFIG_DIR;
  if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, "magpie");
  return join(homedir(), ".config", "magpie");
}

export function memoryDir() {
  return join(configDir(), "memory");
}

export function dataDir() {
  return process.env.MAGPIE_MEMORY_GRAPH_DATA_DIR || join(configDir(), "memory-graph");
}

function normalizeAddr(value) {
  const text = String(value || "").trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  return text || "127.0.0.1:3425";
}

export async function gatewayBase() {
  if (process.env.MAGPIE_ADDR) return normalizeAddr(process.env.MAGPIE_ADDR);
  try {
    const raw = await readFile(join(configDir(), "gateway.json"), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.addr === "string" && parsed.addr) return normalizeAddr(parsed.addr);
  } catch {
    /* 没有 gateway.json 就按 magpie 的默认端口来 */
  }
  return "127.0.0.1:3425";
}

export function mcpUrl(base) {
  return `http://${normalizeAddr(base)}/mcp/magpie/memory`;
}
