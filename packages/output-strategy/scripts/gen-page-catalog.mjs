import { writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { resolve } from "node:path"
import { STYLES } from "../catalog.js"

const output = fileURLToPath(new URL("../page/catalog.js", import.meta.url))

export function renderPageCatalog() {
  if (!Array.isArray(STYLES) || STYLES.length !== 7) {
    throw new Error("catalog.js must export exactly seven STYLES")
  }
  const ids = new Set()
  const styles = STYLES.map(style => {
    if (!style || typeof style.id !== "string" || !style.id || ids.has(style.id)) {
      throw new Error("Each page style must have a unique id")
    }
    ids.add(style.id)
    return {
      id: style.id,
      label: style.label,
      description: style.description,
    }
  })
  return `globalThis.OUTPUT_STRATEGY_CATALOG = ${JSON.stringify(styles, null, 2)}\n`
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeFileSync(output, renderPageCatalog(), "utf8")
  console.log(`wrote ${output}`)
}
