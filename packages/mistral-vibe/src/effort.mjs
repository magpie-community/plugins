// A model that refuses a reasoning effort names the levels it takes. This
// reads that refusal and moves the request to the nearest one; a model with no
// such switch gets the field removed.

import { REASONING_EFFORT_LEVELS } from "./constants.mjs"

const MIDDLE = REASONING_EFFORT_LEVELS.indexOf("medium")
const isLevel = (name) => REASONING_EFFORT_LEVELS.includes(name)

// levelsNamed reads the quoted level names in a refusal's list.
function levelsNamed(tail) {
  const names = []
  for (const match of tail.matchAll(/['"]([a-z]+)['"]/g)) if (isLevel(match[1]) && !names.includes(match[1])) names.push(match[1])
  return names
}

// adjustEffort answers a refusal about the reasoning effort: the body to send
// again, or null when the refusal is about something else (or already fits).
export function adjustEffort(text, refusal) {
  const message = String(refusal ?? "")
  if (!/reasoning_effort/i.test(message)) return null

  let body
  try {
    body = JSON.parse(text)
  } catch {
    return null
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return null

  // /v1/responses nests the level as reasoning.effort.
  const nested = body.reasoning && typeof body.reasoning === "object" && !Array.isArray(body.reasoning)
  const target = nested ? body.reasoning : body
  const field = nested ? "effort" : "reasoning_effort"
  const asked = target[field]

  if (/not enabled/i.test(message)) {
    if (asked == null) return null
    delete target[field]
    return JSON.stringify(body)
  }

  const listed = message.search(/not supported/i)
  if (listed < 0) return null
  const allowed = levelsNamed(message.slice(listed))
  if (!isLevel(asked) || allowed.length === 0 || allowed.includes(asked)) return null

  const rank = (name) => REASONING_EFFORT_LEVELS.indexOf(name)
  const aimLow = rank(asked) < MIDDLE
  const nearest = [...allowed].sort((a, b) => {
    const byDistance = Math.abs(rank(a) - rank(asked)) - Math.abs(rank(b) - rank(asked))
    if (byDistance !== 0) return byDistance
    // A tie leans towards less reasoning below medium, more at and above it.
    return aimLow ? rank(a) - rank(b) : rank(b) - rank(a)
  })[0]
  target[field] = nearest
  return JSON.stringify(body)
}
