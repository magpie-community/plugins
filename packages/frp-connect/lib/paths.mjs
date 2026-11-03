// Where frp-connect keeps what it writes: frpc.toml, frpc's log and the
// record of the frpc it started. Never the plugin's own folder, which is
// the package's (read-only to a plugin, and replaced on an update), and
// never the agent's project folder, which the host hands a plugin as
// `directory`. magpie runs the host in its own settings folder, with
// `plugin-work` below it for the files a program a plugin starts writes:
// the state goes beside that one, and an older install found in the
// project folder is moved over the first time it is opened.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const NAME = "frp-connect";
const FILES = ["frpc.toml", "frpc.log", "frpc.json"];

// stateDir is where the plugin writes: %LOCALAPPDATA%\magpie\frp-connect
// on Windows, ~/Library/Application Support/magpie/frp-connect, or
// ~/.config/magpie/frp-connect; MAGPIE_FRP_DIR names another.
export function stateDir(env = process.env, platform = process.platform) {
  const named = typeof env.MAGPIE_FRP_DIR === "string" ? env.MAGPIE_FRP_DIR.trim() : "";
  if (named) return path.resolve(named);
  const home = env.HOME || env.USERPROFILE || os.homedir();
  if (platform === "win32") {
    const base = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    return path.join(base, "magpie", NAME);
  }
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "magpie", NAME);
  }
  const base = env.XDG_CONFIG_HOME || path.join(home, ".config");
  return path.join(base, "magpie", NAME);
}

export function files(dir) {
  return {
    dir,
    toml: path.join(dir, "frpc.toml"),
    log: path.join(dir, "frpc.log"),
    record: path.join(dir, "frpc.json"),
  };
}

// adopt moves what an older version of this plugin wrote into the agent's
// project folder, so a network already set up keeps working and its token
// leaves the project.
export function adopt(dir, hostDir) {
  if (!hostDir || path.resolve(hostDir) === path.resolve(dir)) return;
  const old = path.join(hostDir, NAME);
  for (const name of FILES) {
    const from = path.join(old, name);
    const to = path.join(dir, name);
    try {
      if (!fs.existsSync(from) || fs.existsSync(to)) continue;
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(from, to);
      fs.rmSync(from, { force: true });
    } catch {
      // a folder that can't be moved is left as it was
    }
  }
}
