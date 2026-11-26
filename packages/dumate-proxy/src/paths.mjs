import { readFileSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"

export function desktopUserDataDir(platform = process.platform, env = process.env, home = homedir()) {
  const override = String(env.DUMATE_USER_DATA_DIR ?? "").trim()
  if (override) return override
  if (platform === "darwin") return join(home, "Library", "Application Support", "qianfan-desktop-app")
  if (platform === "win32") return join(env.APPDATA || join(home, "AppData", "Roaming"), "qianfan-desktop-app")
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "qianfan-desktop-app")
}

const safeAccountId = (id) => typeof id === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(id)

export function discoverConfig({ userDataDir = desktopUserDataDir(), env = process.env } = {}) {
  const override = String(env.DUMATE_OPENCODE_CONFIG ?? "").trim()
  if (override) return isAbsolute(override) ? override : undefined

  const root = join(userDataDir, "qianfan_desk_xdg")
  let account
  try {
    const auth = JSON.parse(readFileSync(join(userDataDir, "auth.json"), "utf8"))
    const profile = Array.isArray(auth?.accountProfiles)
      ? auth.accountProfiles.find((p) => p?.profileId === auth.activeProfileId)
      : undefined
    account = profile?.bceAccountId
  } catch {
    // Fall through to the unambiguous single-account case.
  }

  if (safeAccountId(account)) return join(root, account, "config", "opencode", "opencode.json")
  if (account !== undefined) return undefined

  try {
    const dirs = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== "global" && safeAccountId(entry.name))
    if (dirs.length === 1) return join(root, dirs[0].name, "config", "opencode", "opencode.json")
  } catch {
    // No local DuMate config.
  }
  return undefined
}
