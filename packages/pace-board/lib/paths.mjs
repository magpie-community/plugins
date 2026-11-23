// 本文由AI自动生成
// 路径与网关地址定位。
//
// 只读白名单（本插件只碰这些）：
//   gateway.json / providers.json / credits-daily.json / quota-history.json
//   routing/YYYY-MM-DD.jsonl(.gz)
//   GET {gateway}/v1/magpie/quotas
// 明确不读 plugin-auth.json、caller-keys.json、settings.json —— 那里是凭证。

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export function configDir() {
  if (process.env.MAGPIE_CONFIG_DIR) return process.env.MAGPIE_CONFIG_DIR;
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return join(xdg, "magpie");
  return join(homedir(), ".config", "magpie");
}

export const routingDir = () => join(configDir(), "routing");

const ADDR_RE = /^[\w.\-]+:\d{1,5}$/;

// 网关地址的优先级：
//   1) 宿主注入的 MAGPIE_ADDR（最权威，本次进程真实监听地址）
//   2) gateway.json 的 addr（上次启动写的）
//   3) 3425 兜底（并标记 assumed，界面上会说明）
export async function gatewayBase() {
  const envAddr = process.env.MAGPIE_ADDR;
  if (envAddr && ADDR_RE.test(envAddr)) {
    return { base: `http://${envAddr}`, source: "env", assumed: false };
  }
  try {
    const j = JSON.parse(await readFile(join(configDir(), "gateway.json"), "utf8"));
    if (j && typeof j.addr === "string" && ADDR_RE.test(j.addr)) {
      return { base: `http://${j.addr}`, source: "gateway.json", assumed: false };
    }
  } catch {
    /* 没有这个文件，或者不是合法 JSON：走兜底 */
  }
  return { base: "http://127.0.0.1:3425", source: "fallback", assumed: true };
}

export async function readJsonFile(name, fallback = null) {
  try {
    return JSON.parse(await readFile(join(configDir(), name), "utf8"));
  } catch {
    return fallback;
  }
}
