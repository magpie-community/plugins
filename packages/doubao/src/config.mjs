// 账号与配置解析。账号来源优先级（前后统一，以此为准）：
//   1. magpie 登录态（扫码登录后 magpie 存在 input.directory/plugin-auth.json 的记录）
//   2. env DOUBAO_ACCOUNTS（"主号:sessionid=xxx,ttwid=yyy;小号:sessionid=zzz"）
//   3. Magpie 插件 options 里的 accounts
//   4. env DOUBAO_IMAGE_CONFIG 指定的配置文件 / 插件目录 config.json（手动填写）
// 其他配置项：options > 配置文件 > 内置默认。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PLUGIN_DIR = fileURLToPath(new URL("..", import.meta.url));

export const DEFAULTS = {
  accounts: [],
  model: "Seedream 5.0 Flash",
  ratio: "1:1",
  channel: "auto", // auto | web | pc
  outDir: "", // 空 = 跟随调用方工作目录的 generated-images/
  timeoutSeconds: 180,
  ratioHint: true, // web 通道把比例拼进自然语言（web 端 ratio 字段实测不生效）
};

function parseEnvAccounts(raw) {
  const accounts = [];
  for (const chunk of String(raw).split(";")) {
    const seg = chunk.trim();
    if (!seg) continue;
    const colon = seg.indexOf(":");
    let name = "";
    let rest = seg;
    if (colon > 0) {
      name = seg.slice(0, colon).trim();
      rest = seg.slice(colon + 1);
    }
    const account = { name: name || `账号${accounts.length + 1}` };
    for (const kv of rest.split(",")) {
      const eq = kv.indexOf("=");
      if (eq <= 0) continue;
      account[kv.slice(0, eq).trim()] = kv.slice(eq + 1).trim();
    }
    accounts.push(account);
  }
  return accounts;
}

function loadConfigFile() {
  const explicit = process.env.DOUBAO_IMAGE_CONFIG;
  const candidates = explicit
    ? [explicit]
    : [fileURLToPath(new URL("../config.json", import.meta.url))];
  for (const candidate of candidates) {
    try {
      return JSON.parse(readFileSync(candidate, "utf8"));
    } catch (err) {
      if (explicit && err.code !== "ENOENT") {
        console.warn(`[tools-doubao] 读取配置 ${candidate} 失败: ${err.message}`);
      }
    }
  }
  return {};
}

/**
 * 从 magpie 的 plugin-auth.json 读取扫码登录保存的账号（auth 回调把凭证交给
 * magpie 保管；工具执行时从这里取回）。
 */
export function accountsFromMagpieAuth(magpieDir, pluginId) {
  try {
    if (!magpieDir) return null;
    const data = JSON.parse(readFileSync(path.join(magpieDir, "plugin-auth.json"), "utf8"));
    const rec = data?.[pluginId];
    if (!rec || typeof rec.sessionid !== "string" || rec.sessionid.length <= 8) return null;
    return [
      {
        name: rec.accountId || "扫码登录",
        sessionid: rec.sessionid,
        ttwid: rec.ttwid || "",
        passport_csrf_token: rec.passport_csrf_token || "",
        deviceId: rec.deviceId || "",
        webId: rec.webId || "",
      },
    ];
  } catch {
    return null; // 尚未登录或文件不可读，走其他来源
  }
}

/** magpieDir = 插件函数收到的 input.directory（magpie 配置目录）。 */
export function loadConfig(overrides = {}, magpieDir = "", pluginId = "doubao") {
  const file = loadConfigFile();
  const magpieAccounts = accountsFromMagpieAuth(magpieDir, pluginId);
  const envAccounts = process.env.DOUBAO_ACCOUNTS
    ? parseEnvAccounts(process.env.DOUBAO_ACCOUNTS)
    : null;
  const optionAccounts =
    Array.isArray(overrides.accounts) && overrides.accounts.length ? overrides.accounts : null;
  const accounts =
    magpieAccounts || envAccounts || optionAccounts || (Array.isArray(file.accounts) ? file.accounts : []);
  const merged = { ...DEFAULTS, ...file, ...overrides };
  merged.accounts = (Array.isArray(accounts) ? accounts : []).filter(
    (a) => a && typeof a.sessionid === "string" && a.sessionid.length > 8,
  );
  return merged;
}

/** 给测试脚本/排障用：账号是从哪里来的。 */
export function configSource(magpieDir = "", pluginId = "doubao") {
  if (accountsFromMagpieAuth(magpieDir, pluginId)) return "magpie 扫码登录态";
  if (process.env.DOUBAO_ACCOUNTS) return "env:DOUBAO_ACCOUNTS";
  if (process.env.DOUBAO_IMAGE_CONFIG) return "env:DOUBAO_IMAGE_CONFIG";
  try {
    readFileSync(fileURLToPath(new URL("../config.json", import.meta.url)), "utf8");
    return "config.json";
  } catch {
    /* ignore */
  }
  return "none";
}

export { PLUGIN_DIR };
