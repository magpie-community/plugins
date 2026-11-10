import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// 配置目录：magpie 通过 input.directory 传的是 settings.Dir()
// （internal/plugin/host.go:1160；portable 时=数据目录，否则 ~/.config/magpie），直接信任它。
// 其余仅作离线/测试兜底，绝不回落到宿主工作目录。
export function configDir(input, homedir = os.homedir()) {
  if (process.env.MAGPIE_CONFIG_DIR) return process.env.MAGPIE_CONFIG_DIR;
  if (input && input.directory) return input.directory;
  if (process.env.XDG_CONFIG_HOME) return path.join(process.env.XDG_CONFIG_HOME, "magpie");
  return path.join(homedir, ".config", "magpie");
}

// 读本机状态：文件缺失 = 空（fresh）；存在但解析失败 = null（未知，不做签到判断）。
export function readLocal(dir) {
  const read = (f) => {
    try { return { ok: true, val: JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) }; }
    catch (e) { return { ok: false, missing: e && e.code === "ENOENT" }; }
  };
  const pv = read("plugin-providers.json");
  const ck = read("plugin-checkin.json");
  const providers = pv.ok ? (Array.isArray(pv.val) ? pv.val : []) : (pv.missing ? [] : null);
  const checkin = ck.ok ? (ck.val && typeof ck.val === "object" && !Array.isArray(ck.val) ? ck.val : {}) : (ck.missing ? {} : null);
  return { providers, checkin, dir };
}
