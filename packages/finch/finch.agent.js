// Runs in Magpie's moejs sandbox: one file, no imports or filesystem access.
// Magpie owns writes/restoration; Finch owns importing this supported document.
export const agent = {
  id: "finch",
  name: "Finch",
  // Finch's own site icon, shipped in this package as icon.svg and embedded
  // here as a data URI so the Agents row and the plugin listing render offline.
  icon: "data:image/svg+xml;base64,PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiPz4KPHN2ZyB3aWR0aD0iMjQzIiBoZWlnaHQ9IjI0MyIgdmlld0JveD0iMCAwIDI0MyAyNDMiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CiAgPHN0eWxlPgogICAgLmZpbmNoLW1hcmsgeyBmaWxsOiAjMDAwOyBzdHJva2U6ICMwMDA7IH0KICAgIEBtZWRpYSAocHJlZmVycy1jb2xvci1zY2hlbWU6IGRhcmspIHsKICAgICAgLmZpbmNoLW1hcmsgeyBmaWxsOiAjRjVGMkVBOyBzdHJva2U6ICNGNUYyRUE7IH0KICAgIH0KICA8L3N0eWxlPgogIDxnIGNsYXNzPSJmaW5jaC1tYXJrIiBzdHJva2U9Im5vbmUiIGZpbGw9Im5vbmUiPgogICAgPGcgc3Ryb2tlLXdpZHRoPSIxIiBmaWxsLXJ1bGU9ImV2ZW5vZGQiIHRyYW5zZm9ybT0idHJhbnNsYXRlKDEzIDI5KSI+CiAgICAgIDxwYXRoIGQ9Ik0xODguMDAwMDY2LDMxLjA3NjM5MTEgTDE4NS4xMzI4NTEsMzAuNzU5NzgxIEMxNjguMTE3ODI2LDIzLjA1OTczNTMgMTUzLjM2NTI2NiwyMy44NTk3NDU1IDE0MC44NzUxNzMsMzMuMTU5ODExNyBDMTI5Ljk3OTA4OSw0MS4yNzI5ODYgMTI0LjYxMjY3NSw1MC40NTU3NjAxIDEyMS41NDM1MzQsNjIuOTU0NDM2MSBDMTE2LjUyMzY2MSw4My4zOTcyMDY0IDEyNC4xMTIxNDksMTA0LjEzMzk0MSAxMjQuNzgwMjg4LDExOC41MDYzMDMgQzEyNi4wMTQyNDksMTQ1LjA1MDA4NCAxMjAuODY3NzYyLDE1OC40Mjg4NTEgMTA1LjkxNDY0OSwxNjguOTM2Mzk0IEM5NS45NDU5MDc0LDE3NS45NDE0MjMgODEuMjgwNTIzNywxNzkuMzM5NjM2IDYxLjkxODQ5NzksMTc5LjEzMTAzNCBMNjEuNTg2MzE4MSwxNzkuOTk5OTUyIEM0MC4zMzIxNTExLDE3My44MTE1MzEgMTkuODAzMzc4NCwxNjIuMzkyMDY0IDAsMTQ1Ljc0MTU1MSBDMjcuMjYwMDYxOCwxNDEuMjIzODg2IDQ3LjI3Nzc0OSwxMjkuNzQwMjUgNjAuMDUzMDYxNywxMTEuMjkwNjQzIEM2OC4zNTI5ODQ3LDk5LjMwNDIxODUgNzYuNjcxMDQ1OSw3OS40MTE3NjYgODEuMzc1OTE4Miw1OC42OTc1NzA0IEM4OC40ODMzNjA3LDI3LjQwNTU1MTcgMTAxLjQxMDI1Miw2LjExNzExMzUzIDEyOS4wMDAyNzcsMS4xODg2NDcyMiBDMTYyLjEzNjUxMSwtNC43MzA1NTA1OSAxNzkuMjc0ODY3LDEyLjQzMjQxMjggMTg4LjAwMDA2NiwzMS4wNzYzOTExIFoiLz4KICAgICAgPGNpcmNsZSBjeD0iMTY1LjUiIGN5PSI1Mi41IiByPSIxMC41Ii8+CiAgICAgIDxwYXRoIGQ9Ik0wLDE0NS4zNTU5OTUgQzI3LjI5MDM5ODYsMTQwLjg1MDI4MSA0Ny4zMzAzNjI4LDEyOS4zOTcwMjUgNjAuMTE5ODkyNywxMTAuOTk2MjI2IEM2OC40MjkwNTI0LDk5LjA0MTUxMTYgNzYuNzU2MzcwNSw3OS4yMDE2ODQxIDgxLjQ2NjQ3ODcsNTguNTQyMjg3NSBDODguNTgxODMwOCwyNy4zMzMwNTEgMTAxLjUyMzEwOCw2LjEwMDkzMDg2IDEyOS4xNDM4MzcsMS4xODU1MDI2OSBDMTc5Ljg1NTgzMywtNy44MzkyODM3MiAxOTMuMTQwMDE2LDM2LjkzNTAzNjUgMTk2LjEyMzA0LDU4LjU0MjI4NzUgQzE5OC4xMzQyNDIsNzMuMTEwMjM0OCAyMDEuOTUzMTEzLDExMS4zMzE2NDIgMTg1LjYzNDY5NiwxNDAuNzQ4MTIzIEMxNzUuMzg3MjM5LDE1OS4yMjA3NTUgMTU1LjQ1NDQ1NCwxNzYuOTE2MjAzIDEyOS4xNDM4MzcsMTgyLjEwNDIwMSBDODMuMTI3ODc0MSwxOTEuMTc3NzUxIDQwLjA3OTkyODUsMTc4LjkyODM0OSAwLDE0NS4zNTU5OTUgWiIgZmlsbD0ibm9uZSIgc3Ryb2tlLXdpZHRoPSIxMCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCIvPgogICAgICA8cGF0aCBkPSJNMTg3LjA4NjkzNywyOC43NjIxNTU4IEwyMTcuMDI0MDc0LDI4Ljc2MjE1NTggTDE5NS45NzQ0MDEsNTYgQzE5NC42Mjg5NTIsNDYuMzY5MzE0OCAxOTMuMDg1MTExLDM2LjkxMDIzNDQgMTg3LjA4NjkzNywyOC43NjIxNTU4IFoiIGZpbGw9Im5vbmUiIHN0cm9rZS13aWR0aD0iOCIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIi8+CiAgICA8L2c+CiAgICA8bGluZSB4MT0iNjguNjExNyIgeTE9IjM2LjMwODM2NTEiIHgyPSI1Mi4xNTg5NTUzIiB5Mj0iMjIuOTg5NzY2OCIgZmlsbD0ibm9uZSIgc3Ryb2tlLXdpZHRoPSIxMCIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIi8+CiAgICA8bGluZSB4MT0iODYuMTY0MTQyMiIgeTE9IjIyLjY4MjAyNSIgeDI9IjgzLjgzNTg1NzgiIHkyPSIxNS40MzA4ODA4IiBmaWxsPSJub25lIiBzdHJva2Utd2lkdGg9IjEwIiBzdHJva2UtbGluZWNhcD0icm91bmQiLz4KICAgIDxsaW5lIHgxPSI2MC42OTE1NjA5IiB5MT0iNTYuOTkwNDY0OCIgeDI9IjUzLjMwODQzOTEiIHkyPSI1NS4xMjI0NDEiIGZpbGw9Im5vbmUiIHN0cm9rZS13aWR0aD0iMTAiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPgogICAgPHBhdGggZD0iTTIwNy4yNTMyMjYsODEuNSBMMjMxLjQzNTExNyw4Ny4zMDAxMTQgTDIwOS41NzUxOTUsMTAyLjMyNDI0NiBDMjEwLjM4NDI4Myw5Ni4wMzA4MzcxIDIwOS45MDI2NzksODcuMzgzMjUzNyAyMDcuMjUzMjI2LDgxLjUgWiIgZmlsbD0ibm9uZSIgc3Ryb2tlLXdpZHRoPSI4IiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiLz4KICA8L2c+Cjwvc3ZnPgo=",
  dir: "~/.finch",
  config: "~/.finch/config/integrations/magpie.json",
  format: "json",
  model: "defaultModel",
  ua: ["finch"],
  notice: "Finch syncs when the file changes; no restart needed. 文件变化自动同步，无需重启。",
}

/**
 * @typedef {object} GatewayModel
 * @property {string} id Original gateway request ID, including the provider prefix.
 * @property {string} [name]
 * @property {string} [owned_by]
 * @property {number} [context]
 * @property {boolean} [images]
 * @property {string[]} [efforts]
 */

/** @param {string} id */
function readableModelName(id) {
  // Remove only the routing prefix. Keep any nested model path readable too.
  const slug = id.slice(id.indexOf("/") + 1)
  const brands = new Map([
    ["gpt", "GPT"], ["glm", "GLM"], ["oss", "OSS"], ["ai", "AI"],
    ["openai", "OpenAI"], ["deepseek", "DeepSeek"],
  ])
  return slug
    .replace(/\b(\d{1,2})-(\d{1,2})(?=-|$)/g, "$1.$2")
    .split(/[-_/\s]+/)
    .filter(Boolean)
    .map(word => brands.get(word.toLowerCase()) || word[0].toUpperCase() + word.slice(1))
    .join(" ")
}

/** @param {GatewayModel} model */
function nameParts(model) {
  const original = model.name?.trim() || readableModelName(model.id)
  // Match the LAST suffix only. Include common middle-dot variants and bullets;
  // never treat a decimal point or hyphen in the model itself as a separator.
  const suffix = /\s*[·•‧∙⋅・･]\s*([^·•‧∙⋅・･]+)$/.exec(original)
  const base = suffix ? original.slice(0, suffix.index).trim() : original
  return {
    base: base || readableModelName(model.id),
    provider: suffix?.[1].trim() || model.owned_by?.trim() || model.id.split("/")[0],
  }
}

/**
 * Resolve names across the entire emitted catalog, not one model at a time.
 * Every member of a duplicate group gets a provider label. Reserve candidates
 * before the final pass so an existing literal name cannot steal a generated one.
 * @param {GatewayModel[]} models
 */
function modelNames(models) {
  const parts = models.map(nameParts)
  /** @type {Map<string, number>} */
  const counts = new Map()
  for (const { base } of parts) counts.set(base, (counts.get(base) || 0) + 1)
  const candidates = parts.map(({ base, provider }) =>
    (counts.get(base) || 0) > 1 ? `${base} (${provider})` : base)
  counts.clear()
  for (const name of candidates) counts.set(name, (counts.get(name) || 0) + 1)
  const reserved = new Set(candidates)
  /** @type {Set<string>} */
  const used = new Set()
  return candidates.map((candidate, index) => {
    let name = candidate
    if ((counts.get(candidate) || 0) > 1) {
      const qualified = `${candidate} [${models[index].id}]`
      name = qualified
      let counter = 2
      while (reserved.has(name) || used.has(name)) name = `${qualified} (${counter++})`
    }
    used.add(name)
    return name
  })
}

/**
 * @param {{ gateway: { v1: string, key: string }, models: GatewayModel[], model?: GatewayModel }} input
 * @returns {{ schemaVersion: 1, id: "magpie", name: "Magpie", protocol: "openai-completions", baseUrl: string, apiKey: string, defaultModel?: string, models: { requestModel: string, name: string, enabled: boolean, supportsVision: boolean, supportsThinking: boolean, contextLength: number }[] }}
 */
export function connect({ gateway, models, model }) {
  // Unlike PiG, Finch requires a known positive integer context window.
  // Do not invent limits: skip unknown windows, fail before writing if none remain.
  const eligible = models.filter(m => typeof m.context === "number" && Number.isSafeInteger(m.context) && m.context > 0)
  if (!eligible.length) throw new Error("Finch requires at least one model with a known positive context window")
  /** @type {Set<string>} */
  const ids = new Set()
  for (const entry of eligible) {
    if (!entry.id || entry.id.trim() !== entry.id || ids.has(entry.id)) {
      throw new Error("Finch requires nonempty, unique gateway model IDs without surrounding whitespace")
    }
    ids.add(entry.id)
  }
  if (model && !ids.has(model.id)) {
    throw new Error("The selected Finch model has no eligible catalog entry; choose a model with a known context window")
  }
  const names = modelNames(eligible)
  return {
    schemaVersion: 1,
    id: "magpie",
    name: "Magpie",
    protocol: "openai-completions",
    baseUrl: gateway.v1,
    apiKey: gateway.key,
    // Magpie also writes the selection through agent.model. Keep the same raw ID.
    ...(model ? { defaultModel: model.id } : {}),
    models: eligible.map((m, index) => ({
      requestModel: m.id,
      name: names[index],
      enabled: true,
      supportsVision: m.images === true,
      supportsThinking: (m.efforts || []).length > 0,
      contextLength: /** @type {number} */ (m.context),
    })),
  }
}
