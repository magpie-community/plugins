// The runtime catalog `agy models` listed, so usage windows can name the ids
// the provider serves (usage.mjs stays import-free of index.mjs).
//
// rows(): [{ id, name, effort? }] — the shape `agy models` parses into
// (parseAgyModels), the saved catalog, and FALLBACK_MODELS.
//
// nameIndex(): display name ("Claude Opus 5.5", case- and space-insensitive)
// → the family id ("claude-opus-5-5") and every effort variant id agy listed
// in it, plus the bare family id itself even when agy lists no variant of
// that name (the catalog serves it as its default).

let rows = null
let index = new Map()

export function storeCatalogRows(list) {
  rows = Array.isArray(list) ? list.filter(model => model && typeof model.id === "string" && model.id) : null
  index = null
}

export function catalogRows() {
  return rows ? [...rows] : null
}

const normalizeName = (value) => String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ").replace(/[.,;]$/, "")

// `agy models` names its variants "Gemini 4 Hydrogen (High)" while usage
// groups say "Gemini 4 Hydrogen": match on the name without the effort
// suffix, too, so every variant of a family answers its display name.
const stripEffortSuffix = (name) => name.replace(/\s+\((?:high|medium|low|minimal|xhigh|max)\)$/i, "")

// In "Models within this group: A, B and C", the separator before "and" can
// be a comma (as agy prints today) or nothing at all.
function listedNames(description) {
  const listed = /Models within this group:\s*(.+)/i.exec(String(description ?? ""))
  if (!listed) return null
  return listed[1]
    .split(/,|\s+and\s+/i)
    .map(normalizeName)
    .filter(Boolean)
}

export function nameIndex() {
  if (index) return index
  index = new Map()
  if (rows) {
    const families = new Map()
    const claims = new Map() // display name -> the families that use it
    for (const model of rows) {
      const effort = /-(high|medium|low|minimal|xhigh|max)$/i.exec(model.id)?.[1]?.toLowerCase() || ""
      const family = effort ? model.id.slice(0, -(effort.length + 1)) : model.id
      if (!families.has(family)) families.set(family, new Set())
      families.get(family).add(model.id)
      const name = normalizeName(model.name)
      if (!name) continue
      for (const alias of [name, stripEffortSuffix(name)]) {
        if (!claims.has(alias)) claims.set(alias, new Set())
        claims.get(alias).add(family)
      }
    }
    for (const [family, ids] of families) {
      // the bare id the catalog serves even when agy lists no variant of it
      ids.add(family)
    }
    for (const [name, owners] of claims) {
      // one name, two families: no match, rather than whichever came first
      if (owners.size !== 1) continue
      const [family] = owners
      index.set(name, { family, ids: families.get(family) })
    }
  }
  return index
}

// modelsInGroup answers the ids to put on a usage window. Group names are
// matched against the catalog's display names; a name that matches nothing
// is left out, as is a group whose description names no model and whose own
// name isn't a catalog name either.
export function modelsInGroup(group) {
  const index = nameIndex()
  if (!index.size) return []
  const ids = new Set()
  const names = listedNames(group?.description) || []
  for (const name of names) {
    const entry = index.get(name)
    if (entry) for (const id of entry.ids) ids.add(id)
  }
  if (!ids.size) {
    const own = normalizeName((group?.displayName || group?.display_name || group?.name || "").replace(/\s+models$/i, ""))
    const entry = index.get(own)
    if (entry) for (const id of entry.ids) ids.add(id)
  }
  return [...ids].sort()
}
