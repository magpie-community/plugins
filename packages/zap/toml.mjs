// Line-based TOML surgery for ~/.zap/settings.toml.
//
// Zap stores BYOP providers as [[agents.warp_agent.providers]] tables, each
// followed by its [[agents.warp_agent.providers.models]] tables, and the
// selected model as [agents.byop] last_used_model_id. We touch only the
// provider block whose `id` is PROVIDER_ID and the last_used_model_id line;
// every other byte — other providers, blank runs, multi-line strings — is
// left alone, so a user's own provider on the same gateway URL stays put,
// and its keychain entry stays attached to it.

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
// [[agents.warp_agent.providers.models]]. Lines are not normalized.
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

// The managed block and its text, or null when our provider isn't there.
function findManagedBlock(text) {
  const lines = text.split("\n")
  for (const { start, end } of providerBlocks(lines)) {
    const blockText = lines.slice(start, end).join("\n")
    if (blockText.includes(`id = "${PROVIDER_ID}"`)) return { start, end, text: blockText }
  }
  return null
}

// Only the block with our id is ever removed. The blank run at the seam it
// leaves is collapsed to one blank line — so the file isn't left double-
// blank where the block stood — but every other byte is untouched, in
// particular blank runs elsewhere and multi-line strings.
export function removeProviderBlocks(text) {
  const found = findManagedBlock(text)
  if (!found) return { text, removedText: null }
  const lines = text.split("\n")
  const before = lines.slice(0, found.start)
  const after = lines.slice(found.end)
  let seam = 0
  while (before.length && before[before.length - 1].trim() === "") {
    before.pop()
    seam++
  }
  while (after.length && after[0].trim() === "") {
    after.shift()
    seam++
  }
  const rest = [...before, ...(seam > 0 && before.length > 0 ? [""] : []), ...after].join("\n")
  return { text: rest, removedText: found.text }
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
    // everything else in the table's span stays byte-identical, blank lines
    // included; only the last_used_model_id line is replaced or removed
    const kept = lines.slice(start + 1, end).filter((l) => !/^\s*last_used_model_id\s*=/.test(l))
    const table = modelId
      ? [BYOP_HEADER, `last_used_model_id = "${escapeTomlString(modelId)}"`, ...kept]
      : kept.some((l) => l.trim() !== "")
        ? [BYOP_HEADER, ...kept]
        : kept
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
// state:  what the host persists between ticks —
//   connected:    { baseUrl, lastAppliedSelected, preLastUsed }
//   host stopped: { managedBlock, preLastUsed }   (tombstone)
// The tombstone is written while connected; it lets the next tick (or a
// later one, after the plugin is turned off and core emptied the outbox)
// remove the managed provider even when the host is down. Returns
// { text, state, changed }.
export function reconcileToml(toml, outbox, state) {
  const next = { ...state }
  let text = toml
  const connected = outbox && Object.keys(outbox.models || {}).length > 0

  if (connected) {
    if (outbox.base_url) next.baseUrl = outbox.base_url
    const { text: removed, removedText } = removeProviderBlocks(text)
    text = removed
    const block = providerBlockText({ baseUrl: outbox.base_url, models: outbox.models })
    // remember the managed block (as plain text) so a stale outbox from a
    // stopped host still knows what to clean up
    next.managedBlock = removedText ?? block
    if (removedText !== block.slice(0, -1)) {
      text = appendBlock(text, block)
    }
    if (outbox.selected && next.lastAppliedSelected !== outbox.selected) {
      if (next.lastAppliedSelected === undefined) next.preLastUsed = getLastUsedModel(text)
      text = setLastUsedModel(text, `byop:${PROVIDER_ID}:${outbox.selected}`)
      next.lastAppliedSelected = outbox.selected
    }
  } else if (next.lastAppliedSelected !== undefined) {
    // an ordinary disconnect: core emptied the outbox, we take it all back
    const { text: removed } = removeProviderBlocks(text)
    text = removed
    const current = parseLastUsedRef(getLastUsedModel(text))
    // only give the pick back when it is still ours (whatever form Zap left
    // it in); a model of another provider, or one the user chose, stays
    if (current.modelId === next.lastAppliedSelected && (current.providerId === undefined || current.providerId === PROVIDER_ID)) {
      text = setLastUsedModel(text, next.preLastUsed)
    }
    for (const k of Object.keys(next)) delete next[k]
  } else if (next.managedBlock != null) {
    // the outbox is empty but a managed block is still in the file: the
    // plugin was turned off (or removed) and the host died before core
    // could write the disconnect. Clean up from the tombstone.
    const { text: removed } = removeProviderBlocks(text)
    text = removed
    const current = parseLastUsedRef(getLastUsedModel(text))
    if (current.providerId === PROVIDER_ID) {
      text = setLastUsedModel(text, next.preLastUsed ?? null)
    }
    for (const k of Object.keys(next)) delete next[k]
  }

  return { text, state: next, changed: text !== toml }
}
