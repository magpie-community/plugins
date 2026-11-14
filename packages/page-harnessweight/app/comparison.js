// Direction applies within the displayed sample, not to task quality.
export const DIRECTIONS = {
  calls: "neutral", prompt: "low", avgPrompt: "low", cacheRate: "high",
  fullPrice: "low", out: "neutral", errorRate: "low", p50ttft: "low",
  p50ms: "low", taskDuration: "low", toolTokens: "low", session: "neutral",
}
export function metricValue(row, key) {
  if (key === "taskDuration") {
    const t = row.taskDuration
    return t?.available && t.samples > 0 && Number.isFinite(t.averageMs) && t.averageMs >= 0 ? t.averageMs : null
  }
  if (key === "toolTokens") return row.tools?.avgTokens ?? null
  if (key === "session") return row.session?.measured ? row.session.median : null
  if (key === "cacheRate" && !row.prompt) return null
  if (["p50ttft", "p50ms"].includes(key) && !(row[key] > 0)) return null
  if (key !== "toolTokens" && !(row.calls > 0)) return null
  return Number.isFinite(row[key]) ? row[key] : null
}
export function extrema(rows, keys = Object.keys(DIRECTIONS), valueOf = metricValue) {
  return Object.fromEntries(keys.map(key => {
    const values = rows.map(row => valueOf(row, key)).filter(Number.isFinite)
    return [key, values.length > 1 ? { min: Math.min(...values), max: Math.max(...values) } : null]
  }))
}
export function extremum(value, range, direction = "neutral") {
  if (!Number.isFinite(value) || !range || range.min === range.max) return null
  const edge = value === range.max ? "max" : value === range.min ? "min" : null
  if (!edge) return null
  const quality = direction === "neutral" ? edge
    : (direction === "high" ? edge === "max" : edge === "min") ? "best" : "worst"
  return { edge, quality }
}
