const ratioIDs = { 0: "adaptive", 2: "16:9", 3: "9:16", 4: "4:3", 5: "3:4", 6: "1:1",
  7: "2:1", 8: "2.35:1", 9: "1.85:1", 10: "1.125:2.436", 11: "3:2", 12: "2:3", 13: "21:9" }
const keys = { ratio: "aspect_ratio", duration: "duration", effort: "quality", resolution: "resolution" }

export function mediaConstraints(model, capability) {
  const configuration = model.sourceCapabilities?.parameter_config
  if (configuration === undefined) return undefined
  if (!configuration || typeof configuration !== "object" || Array.isArray(configuration) ||
      (configuration.dimensions !== undefined && !Array.isArray(configuration.dimensions))) {
    throw new Error("Invalid source parameter_config.")
  }
  function normalize(key, value) {
    if (key === "ratio" && Object.hasOwn(ratioIDs, value)) return ratioIDs[value]
    if (typeof value !== "string" && typeof value !== "number") throw new Error("Invalid source parameter constraint value.")
    return String(value).toLowerCase()
  }
  function selection(values) {
    if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error("Invalid source parameter combination.")
    return Object.fromEntries(Object.entries(values).map(([key, value]) => [keys[key] ?? key, normalize(key, value)]))
  }
  const defaults = {}
  const conditions = []
  for (const dimension of configuration.dimensions ?? []) {
    if (!dimension || typeof dimension.key !== "string") throw new Error("Invalid source parameter dimension.")
    const key = keys[dimension.key] ?? dimension.key
    if (dimension.default_value !== undefined) defaults[key] = normalize(dimension.key, dimension.default_value)
    const control = capability.params.find((parameter) => parameter.key === key)
    if (!control || dimension.active_when_any === undefined) continue
    if (!Array.isArray(dimension.active_when_any)) throw new Error("Invalid source active_when_any.")
    if (dimension.active_when_any.length) conditions.push({ key, title: control.title,
      any: dimension.active_when_any.map((condition) => {
        if (!condition || typeof condition !== "object" || Array.isArray(condition)) throw new Error("Invalid source parameter condition.")
        return Object.fromEntries(Object.entries(condition).map(([name, allowed]) => [
          keys[name] ?? name, (Array.isArray(allowed) ? allowed : [allowed]).map((value) => normalize(name, value)),
        ]))
      }) })
  }
  if (configuration.default_combination !== undefined) Object.assign(defaults, selection(configuration.default_combination))
  const constraints = { defaults, conditions }
  if (configuration.need_available_combinations) {
    if (!Array.isArray(configuration.available_combinations) || !Array.isArray(configuration.combination_dimension_keys)) {
      throw new Error("Invalid source available_combinations.")
    }
    constraints.keys = configuration.combination_dimension_keys.map((key) => keys[key] ?? key)
    constraints.combinations = configuration.available_combinations.filter((combination) => !combination.disabled)
      .map((combination) => selection(combination.option_values))
  }
  return constraints
}
