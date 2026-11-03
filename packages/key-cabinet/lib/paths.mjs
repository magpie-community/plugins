import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function magpieConfigDir() {
  if (process.env.MAGPIE_CONFIG_DIR) return process.env.MAGPIE_CONFIG_DIR;
  if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, "magpie");
  return join(homedir(), ".config", "magpie");
}

export function pluginDataDir() {
  const dir = join(magpieConfigDir(), "page-project-keys");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}
