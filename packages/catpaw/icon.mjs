// The cat-paw mark shipped with the plugin. magpie and OpenCode read a
// provider icon as a data URI, so icon.png is read once at load time and
// handed to both config.provider[id].icon and auth.icon in index.mjs.
//
// The file is kept as PNG (rather than a base64 string in the source) so the
// same bytes can also be used by the plugin market card and by anything else
// that wants the asset. A missing file is not fatal: the plugin still loads,
// just without an icon.
import { readFileSync } from "node:fs"

export const iconData = (() => {
  try {
    return `data:image/png;base64,${readFileSync(new URL("./icon.png", import.meta.url)).toString("base64")}`
  } catch {
    return ""
  }
})()
