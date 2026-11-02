// Canonical Claude model identity resolution.
//
// This module is deliberately independent of transport, authentication and
// capability policy (the single "metadata-first identity resolver" the spec
// calls for). Discovery uses it to derive a stable, conventional agent-facing
// model ID and a human display label from authoritative model metadata — the
// catalog display name and provider — with a documented SAP-identity-format
// fallback. The raw SAP identity stays opaque to transport, which never parses
// it.
//
// A SAP prefix/delimiter/order or opaque-key change must not rename a model
// when metadata still establishes the same underlying model; genuinely
// ambiguous or conflicting evidence is reported (resolve returns null) rather
// than guessed.

const VARIANTS = new Set(["opus", "sonnet", "haiku"])
// Hyphenated numeric release segments normalize to dots. An eight-digit trailing
// date remains a suffix rather than becoming another release segment.
const VERSION = "\\d+(?:\\.\\d+|-(?!\\d{8}(?:[\\s_-]|$))\\d+)*"
const VARIANT = "opus|sonnet|haiku"
// "Claude 4.8 Opus [suffix]" and "Claude Opus 4.8 [suffix]". The separator is
// whitespace, hyphen or underscore so both display names and SAP identities
// (after their provider prefix is stripped) run through the same recognizer.
const VERSION_FIRST = new RegExp(`^claude[\\s_-]+(${VERSION})[\\s_-]+(${VARIANT})((?:[\\s_-]+[a-z0-9]+)*)$`, "i")
const VARIANT_FIRST = new RegExp(`^claude[\\s_-]+(${VARIANT})[\\s_-]+(${VERSION})((?:[\\s_-]+[a-z0-9]+)*)$`, "i")
// Observed current SAP identity format: an opaque provider prefix joined by a
// delimiter, e.g. "anthropic--claude-4.8-opus". The prefix is opaque and
// optional; only the Claude remainder is parsed.
const PROVIDER_PREFIX = /^[a-z0-9]+(?:--|__|::|\/)/i

const capitalize = word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()

/**
 * Normalize extra trailing tokens (date/preview/variant suffixes) captured
 * after the variant+version. Returns lowercase tokens for the ID and the
 * original-cased tokens for the label.
 * @param {string} rest
 */
function suffixTokens(rest) {
  return rest.split(/[\s_-]+/).filter(Boolean)
}

/**
 * Build the canonical ID and display label from a parsed (variant, version,
 * suffix tokens) tuple. Version dots become hyphens; family, full release and
 * any meaningful suffix are preserved.
 * @param {string} variant
 * @param {string} version
 * @param {string[]} suffix
 */
function compose(variant, version, suffix) {
  const v = variant.toLowerCase()
  if (!VARIANTS.has(v)) return null
  const release = version.replace(/\./g, "-")
  const dotted = version.replace(/-/g, ".")
  const idSuffix = suffix.map(t => t.toLowerCase())
  const canonicalID = ["claude", v, release, ...idSuffix].join("-")
  const labelSuffix = suffix.length ? " " + suffix.join(" ") : ""
  const displayLabel = `Claude ${capitalize(v)} ${dotted}${labelSuffix}`
  return { canonicalID, displayLabel }
}

/**
 * Parse a Claude label/identity remainder in either version-first or
 * variant-first order.
 * @param {string} text
 */
function parse(text) {
  const m = VERSION_FIRST.exec(text) ?? null
  if (m) return compose(m[2], m[1], suffixTokens(m[3]))
  const n = VARIANT_FIRST.exec(text)
  if (n) return compose(n[1], n[2], suffixTokens(n[3]))
  return null
}

/**
 * Does this deployment's metadata identify it as an Anthropic Claude model?
 * Provider or an unambiguous Claude identity/label qualifies; executable alone
 * does not (Titan/Nova are also aws-bedrock and out of scope).
 * @param {{ provider?: unknown, sapIdentity?: unknown, displayName?: unknown }} evidence
 */
export function claudeFamily({ provider, sapIdentity, displayName } = {}) {
  if (provider !== undefined) {
    if (typeof provider !== "string" || provider.trim().toLowerCase() !== "anthropic") return false
  }
  if (displayName !== undefined && typeof displayName !== "string") return false
  if (sapIdentity !== undefined && typeof sapIdentity !== "string") return false
  if (provider !== undefined) return true
  if (typeof sapIdentity === "string" && /(?:^|[^a-z])claude(?:[^a-z]|$)/i.test(sapIdentity)) return true
  if (typeof displayName === "string" && /(?:^|[^a-z])claude(?:[^a-z]|$)/i.test(displayName)) return true
  return false
}

// Two resolutions describe the same model when their canonical ID matches; a
// formatting-only label difference (token order, spacing) is not a conflict.
const resultsAgree = (a, b) => a.canonicalID === b.canonicalID


/**
 * Resolve the canonical agent-facing ID and display label for a Claude model.
 * The catalog display name is authoritative metadata; the SAP identity format
 * is a documented fallback used only when no display name is present. A present
 * but non-empty display name that cannot be parsed, non-string evidence, or a
 * display/identity canonical-ID disagreement is ambiguous and resolves to null
 * rather than a guess.
 * @param {{ sapIdentity?: unknown, displayName?: unknown }} evidence
 * @returns {{ canonicalID: string, displayLabel: string } | null}
 */
export function resolveCanonicalClaude({ sapIdentity, displayName } = {}) {
  if (displayName !== undefined && typeof displayName !== "string") return null
  if (sapIdentity !== undefined && typeof sapIdentity !== "string") return null

  const displayText = typeof displayName === "string" ? displayName.trim() : ""
  const fromDisplay = displayText ? parse(displayText) : null
  if (displayText && fromDisplay === null) return null

  let fromIdentity = null
  if (typeof sapIdentity === "string" && sapIdentity.trim()) {
    fromIdentity = parse(sapIdentity.trim().replace(PROVIDER_PREFIX, ""))
  }

  if (fromDisplay) {
    if (fromIdentity && !resultsAgree(fromDisplay, fromIdentity)) return null
    return fromDisplay
  }
  if (fromIdentity) return fromIdentity
  return null
}
