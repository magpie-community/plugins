// 配置解析。优先级：
//   env DOUBAO_IMAGE_CONFIG（指定配置文件路径）
//   > 插件目录 config.json
//   > env DOUBAO_ACCOUNTS（"主号:sessionid=xxx,ttwid=yyy;小号:sessionid=zzz"）
//   > 内置默认
// Magpie 插件 options（插件函数第二参）可覆盖任意字段。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PLUGIN_DIR = fileURLToPath(new URL("..", import.meta.url));

export const DEFAULTS = {
  accounts: [],
  model: "Seedream 5.0 Flash",
  ratio: "1:1",
  channel: "auto", // auto | web | pc
  outDir: "", // 空 = 跟随调用方工作目录的 generated-images/
  timeoutSeconds: 180,
  ratioHint: true, // web 通道把比例拼进自然语言（web 端 ratio 字段实测不生效）
  removeWatermark: false, // 扩图裁剪法去右下角"豆包AI生成"水印（多花一次生成额度）
  watermarkExtend: "1/4", // 扩图比例，裁剪保留 1/(1+该值)
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

export function loadConfig(overrides = {}) {
  const file = loadConfigFile();
  const envAccounts = process.env.DOUBAO_ACCOUNTS
    ? parseEnvAccounts(process.env.DOUBAO_ACCOUNTS)
    : null;
  const merged = { ...DEFAULTS, ...file, ...overrides };
  // 优先级：env DOUBAO_ACCOUNTS > overrides（Magpie options）> config.json
  const accounts =
    envAccounts ||
    (Array.isArray(overrides.accounts) && overrides.accounts.length ? overrides.accounts : null) ||
    (Array.isArray(file.accounts) ? file.accounts : []) ||
    [];
  merged.accounts = (Array.isArray(accounts) ? accounts : []).filter(
    (a) => a && typeof a.sessionid === "string" && a.sessionid.length > 8,
  );
  return merged;
}

/** 给测试脚本/排障用：配置是从哪里来的。 */
export function configSource() {
  if (process.env.DOUBAO_IMAGE_CONFIG) return `env:DOUBAO_IMAGE_CONFIG`;
  try {
    readFileSync(fileURLToPath(new URL("../config.json", import.meta.url)), "utf8");
    return "config.json";
  } catch {
    /* ignore */
  }
  if (process.env.DOUBAO_ACCOUNTS) return "env:DOUBAO_ACCOUNTS";
  return "none";
}

export { PLUGIN_DIR };
