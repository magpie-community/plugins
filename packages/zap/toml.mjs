// Line-based TOML surgery for ~/.zap/settings.toml.
//
// Zap stores BYOP providers as [[agents.warp_agent.providers]] tables, each
// followed by its [[agents.warp_agent.providers.models]] tables, and the
// selected model as [agents.byop] last_used_model_id. We rewrite only the
// provider block we own (matched by our stable id, or by the gateway's
// base_url so a hand-made magpie provider is adopted) and leave every other
// byte of the file alone.

export const PROVIDER_ID = "6d616770-6965-4000-8000-7a6170000001"

const PROVIDERS_HEADER = "[[agents.warp_agent.providers]]"
const MODELS_HEADER = "[[agents.warp_agent.providers.models]]"
const BYOP_HEADER = "[agents.byop]"

function isTableHeader(line) {
  return /^\s*\[\[?[^\]]+\]\]\s*$/.test(line)
}

function escapeTomlString(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

// Every [[agents.warp_agent.providers]] block's [start, end) line range:
// from its header until the next table header that is not its own
// [[agents.warp_agent.providers.models]].
function providerBlocks(lines) {
  const blocks = []
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== PROVIDERS_HEADER) continue
    let end = i + 1
    while (end < lines.length && (!isTableHeader(lines[end]) || lines[end].trim() === MODELS_HEADER)) end++
    blocks.push({ start: i, end })
  }
  return blocks
}

function blockMatches(blockText, { baseUrl }) {
  return (
    blockText.includes(`id = "${PROVIDER_ID}"`) ||
    (baseUrl ? blockText.includes(`base_url = "${baseUrl}"`) : false)
  )
}

export function removeProviderBlocks(text, { baseUrl } = {}) {
  const lines = text.split("\n")
  const drop = new Set()
  for (const { start, end } of providerBlocks(lines)) {
    const blockText = lines.slice(start, end).join("\n")
    if (blockMatches(blockText, { baseUrl })) {
      for (let i = start; i < end; i++) drop.add(i)
    }
  }
  if (drop.size === 0) return text
  return lines
    .filter((_, i) => !drop.has(i))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
}

export function getLastUsedModel(text) {
  const lines = text.split("\n")
  const start = lines.findIndex((l) => l.trim() === BYOP_HEADER)
  if (start < 0) return undefined
  for (let i = start + 1; i < lines.length && !isTableHeader(lines[i]); i++) {
    const m = lines[i].match(/^\s*last_used_model_id\s*=\s*"((?:[^"\\]|\\.)*)"/)
    if (m) return m[1].replace(/\\(["\\])/g, "$1")
  }
  return undefined
}

// Zap's canonical last_used reference is "byop:<provider-id>:<model-id>"
// (model ids may contain "/" but never ":"; bare "<model-id>" is the legacy
// form it rewrites on save).
export function parseLastUsedRef(value) {
  if (value == null) return {}
  const m = value.match(/^byop:([^:]+):(.+)$/)
  return m ? { providerId: m[1], modelId: m[2] } : { modelId: value }
}

export function setLastUsedModel(text, modelId) {
  const lines = text.split("\n")
  const start = lines.findIndex((l) => l.trim() === BYOP_HEADER)
  let end = start < 0 ? -1 : start + 1
  while (end >= 0 && end < lines.length && !isTableHeader(lines[end])) end++
  if (end >= 0) {
    // keep only the table's other keys
    const kept = lines
      .slice(start + 1, end)
      .filter((l) => !/^\s*last_used_model_id\s*=/.test(l) && l.trim() !== "")
    const table = modelId ? [BYOP_HEADER, `last_used_model_id = "${escapeTomlString(modelId)}"`, ...kept] : kept.length ? [BYOP_HEADER, ...kept] : []
    return [...lines.slice(0, start), ...table, ...lines.slice(end)].join("\n")
  }
  if (!modelId) return text
  const sep = text.trim() === "" || text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n"
  return `${text}${sep}${BYOP_HEADER}\nlast_used_model_id = "${escapeTomlString(modelId)}"\n`
}

export function providerBlockText({ baseUrl, models }) {
  const out = [
    PROVIDERS_HEADER,
    `id = "${PROVIDER_ID}"`,
    `name = "Magpie"`,
    `kind = "open_ai_compatible"`,
    `api_type = "open_ai"`,
    `base_url = "${escapeTomlString(baseUrl)}"`,
  ]
  for (const [id, m] of Object.entries(models)) {
    out.push("", MODELS_HEADER, `name = "${escapeTomlString(m.name ?? id)}"`, `id = "${escapeTomlString(id)}"`)
    if (m.context > 0) out.push(`context_window = ${m.context}`)
    if (m.image) out.push("image = true")
  }
  return out.join("\n") + "\n"
}

function appendBlock(text, block) {
  const sep = text.trim() === "" ? "" : text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n"
  return text + sep + block
}

// Mirror the outbox (what magpie manages) into settings.toml text.
// outbox: { base_url, selected, models } while connected, null when off.
// state:  { lastAppliedSelected, preLastUsed, baseUrl } persisted by the host.
// Returns { text, state, changed }.
export function reconcileToml(toml, outbox, state) {
  const next = { ...state }
  let text = toml

  if (outbox?.base_url) next.baseUrl = outbox.base_url
  text = removeProviderBlocks(text, { baseUrl: next.baseUrl })

  if (outbox && Object.keys(outbox.models || {}).length > 0) {
    text = appendBlock(text, providerBlockText({ baseUrl: outbox.base_url, models: outbox.models }))
    if (outbox.selected && next.lastAppliedSelected !== outbox.selected) {
      if (next.lastAppliedSelected === undefined) next.preLastUsed = getLastUsedModel(text)
      text = setLastUsedModel(text, `byop:${PROVIDER_ID}:${outbox.selected}`)
      next.lastAppliedSelected = outbox.selected
    }
  } else if (next.lastAppliedSelected !== undefined) {
    const current = parseLastUsedRef(getLastUsedModel(text))
    // only give the pick back when it is still ours (whatever form Zap left
    // it in); a model of another provider, or one the user chose, stays
    if (current.modelId === next.lastAppliedSelected && (current.providerId === undefined || current.providerId === PROVIDER_ID)) {
      text = setLastUsedModel(text, next.preLastUsed)
    }
    for (const k of Object.keys(next)) delete next[k]
  }

  return { text, state: next, changed: text !== toml }
}
