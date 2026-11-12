// Local provider branding follows the same portable config directory as usage.
// Only display fields leave this module; provider files also contain credentials.
import { open, realpath } from "node:fs/promises"
import { constants } from "node:fs"
import { dirname, extname, join, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { magpieDir } from "./paths.mjs"

const ICONS = join(dirname(fileURLToPath(import.meta.url)), "..", "app", "icons")
const ICON_LIMIT = 1024 * 1024
const CONFIG_LIMIT = 4 * ICON_LIMIT
const MIME = { ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon" }

async function boundedRead(root, file, limit, exactPath = false) {
  let handle
  try {
    const [base, target] = await Promise.all([realpath(root), realpath(file)])
    // Custom images must be direct files in the real icons directory, never
    // links to config/credentials (even when the target stays in configRoot).
    if (exactPath && (base !== root || target !== file || dirname(target) !== base)) return null
    const rel = relative(base, target)
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) return null
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > limit) return null
    // Bound allocation and the read even if the file grows after stat.
    const data = Buffer.alloc(limit + 1)
    let size = 0
    while (size < data.length) {
      const { bytesRead } = await handle.read(data, size, data.length - size, null)
      if (!bytesRead) break
      size += bytesRead
    }
    return size <= limit ? data.subarray(0, size) : null
  } catch {
    // Absent, malformed and inaccessible local branding falls back to bundled UI.
    return null
  } finally {
    await handle?.close()
  }
}

async function metadata(root, filename) {
  const data = await boundedRead(root, join(root, filename), CONFIG_LIMIT)
  try { return data ? JSON.parse(data.toString("utf8")) : null } catch { return null }
}

async function iconData(root, key) {
  if (typeof key !== "string") return null
  if (/^file:[0-9a-f]{16}\.(png|jpg|gif|webp|ico|svg)$/.test(key)) {
    const filename = key.slice(5)
    const icons = join(root, "icons")
    const data = await boundedRead(icons, join(icons, filename), ICON_LIMIT, true)
    return data?.length ? `data:${MIME[extname(filename)]};base64,${data.toString("base64")}` : null
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(key)) return null
  for (const ext of [".svg", ".png", ".webp"]) {
    const data = await boundedRead(ICONS, join(ICONS, key + ext), ICON_LIMIT)
    if (data?.length) return `data:${MIME[ext]};base64,${data.toString("base64")}`
  }
  return null
}

export function createProviderBrands(options = {}) {
  const root = magpieDir(options)
  return async function providerBrands(providerOptions) {
    const [manual, plugins] = await Promise.all([
      metadata(root, "providers.json"), metadata(root, "plugin-providers.json"),
    ])
    const allowed = new Set(providerOptions)
    const selected = new Map()
    // Explicit, nonempty local fields override plugin defaults independently.
    for (const rows of [plugins, manual?.providers]) {
      if (!Array.isArray(rows)) continue
      for (const row of rows) {
        if (!row || typeof row.id !== "string" || !allowed.has(row.id)) continue
        const display = selected.get(row.id) || {}
        for (const field of ["name", "icon"]) {
          if (typeof row[field] === "string" && row[field].trim()) display[field] = row[field].trim()
        }
        selected.set(row.id, display)
      }
    }
    const result = Object.create(null)
    for (const [id, display] of selected) {
      const brand = {}
      if (display.name) brand.name = display.name
      const icon = await iconData(root, display.icon)
      if (icon) brand.icon = icon
      if (Object.keys(brand).length) result[id] = brand
    }
    return result
  }
}
