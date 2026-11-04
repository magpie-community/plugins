// Checks registry.json, the list magpie's Plugins page suggests, against
// what magpie's reader (internal/plugin/market.go, parseMarket) takes.
// That reader unmarshals the whole file into typed fields, so one value of
// the wrong type (a string for "providers", "true" for "community") loses
// every listing, not just its own; it keeps an entry only when "package" is
// a name its pkgName pattern matches; and the page sorts by "kind", so an
// unknown kind lists a middleware or an agent as a provider.

// magpie's pkgName (internal/plugin/store.go), and npm's length limit
const pkgName = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/
// a provider's entry has none; plugins.js's kindOf knows these others
export const kinds = ["middleware", "hooks", "agent", "tools", "page"]
const fields = ["package", "name", "icon", "providers", "community", "replaces", "kind", "summary"]
const languages = ["en", "zh"]
// magpie fetches the list at most this big (fetchJSONFaithful's limit)
const maxBytes = 1 << 20

const text = (v) => typeof v === "string" && v.trim() !== ""

// The problems with registry.json's text, none when magpie reads it whole.
export function registryProblems(source) {
  if (Buffer.byteLength(source) > maxBytes) return [`registry.json is over ${maxBytes} bytes, more than magpie fetches`]
  let r
  try {
    r = JSON.parse(source)
  } catch (e) {
    return [`registry.json is not JSON: ${e.message}`]
  }
  if (!r || typeof r !== "object" || Array.isArray(r)) return ["registry.json is not an object"]
  const problems = []
  if (r.version !== 1) problems.push(`version ${JSON.stringify(r.version)}, not 1`)
  if (!Array.isArray(r.plugins) || !r.plugins.length) return [...problems, "plugins is not a list of entries"]
  const seen = new Map()
  r.plugins.forEach((e, i) => {
    const at = `plugins[${i}]${text(e?.package) ? ` (${e.package})` : ""}`
    const bad = (why) => problems.push(`${at}: ${why}`)
    if (!e || typeof e !== "object" || Array.isArray(e)) return bad("not an object")
    for (const k of Object.keys(e)) if (!fields.includes(k)) bad(`unknown field ${JSON.stringify(k)}`)
    if (typeof e.package !== "string" || !pkgName.test(e.package) || e.package.length > 214) bad(`package ${JSON.stringify(e.package)} is not an npm package name`)
    else if (seen.has(e.package)) bad(`package listed again (first at plugins[${seen.get(e.package)}])`)
    else seen.set(e.package, i)
    if (!text(e.name)) bad("no name")
    if ("kind" in e && !kinds.includes(e.kind)) bad(`kind ${JSON.stringify(e.kind)} is not one of ${kinds.join(", ")} (a provider has none)`)
    if ("community" in e && typeof e.community !== "boolean") bad("community is not true or false")
    if ("replaces" in e && !text(e.replaces)) bad("replaces is not a subscription id")
    if ("providers" in e && (!Array.isArray(e.providers) || !e.providers.length || !e.providers.every(text))) bad("providers is not a list of provider ids")
    if ("icon" in e) {
      // a bundled icon's name, or a picture: an https URL or a data:image URI
      if (!text(e.icon)) bad("icon is empty")
      else if (/[:/]/.test(e.icon) && !/^(https:\/\/|data:image\/)/i.test(e.icon)) bad(`icon ${JSON.stringify(e.icon.slice(0, 60))} is not https or data:image`)
    }
    if (!e.summary || typeof e.summary !== "object" || Array.isArray(e.summary)) bad("no summary")
    else {
      for (const l of languages) if (!text(e.summary[l])) bad(`no summary.${l}`)
      for (const [l, s] of Object.entries(e.summary)) if (typeof s !== "string") bad(`summary.${l} is not text`)
    }
  })
  return problems
}

// The packages here whose package.json declares an agent (magpie.agent)
// and whose entry isn't "kind": "agent": magpie lists a package that adds
// an agent as an agent, a Bun module (main) beside it or not (#737), so its
// entry says so too. pkgs is each package.json, parsed.
export function agentKindProblems(source, pkgs) {
  let r
  try {
    r = JSON.parse(source)
  } catch {
    return []
  }
  const kindOf = new Map((Array.isArray(r?.plugins) ? r.plugins : []).map((e) => [e?.package, e?.kind]))
  return pkgs
    .filter((p) => typeof p?.magpie?.agent === "string" && p.magpie.agent.trim() && kindOf.has(p.name) && kindOf.get(p.name) !== "agent")
    .map((p) => `${p.name} declares magpie.agent, but its entry's kind is ${JSON.stringify(kindOf.get(p.name) ?? null)}, not "agent"`)
}
