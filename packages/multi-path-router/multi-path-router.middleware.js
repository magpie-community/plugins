// A model map with three optional gates in front of it, for magpie's
// gateway: image-bearing requests can go to a vision model, requests whose
// estimated context is at least a threshold can go to a long-context model,
// and requests inside a schedule's off-peak window can go to another model.
// The gates run in that order; the first one with a target wins. When no
// gate fires, the plain mapping applies. Replies name the model the client
// asked for again, so an agent that reads its model's name back (Claude
// Code does, for its context window) sees what it asked for.
//
//   {
//     "constraints": {
//       "vision": "vision-model",
//       "tokens_gte": { "threshold": 64000, "target": "long-context-model" }
//     },
//     "schedule": {
//       "offpeak": { "days": [0, 6], "start": "00:30", "end": "08:30", "tz": 8 },
//       "offpeak_mapping": { "smart-router": "cheap-model" }
//     },
//     "mapping": { "smart-router": "default-model" }
//   }
//
// The schedule is opt-in: offpeak_mapping only applies while the schedule
// says off-peak is on. Setting "cst_deepseek_offpeak": false turns the
// schedule off entirely. "cst_deepseek_offpeak": true enables a fixed
// preset window in China Standard Time (UTC+8): weekends all day, and
// weekdays outside 09:00-12:00 and 14:00-18:00 (so 12:00-14:00 and
// 18:00-09:00). It is only a preset chosen by the user; it makes no claim
// about a vendor's current pricing. "offpeak" sets your own windows and
// takes precedence over the preset.

const IMAGE_TYPES = new Set(["image", "image_url", "input_image"])
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k)

// Local time in a fixed UTC offset. Shifting the timestamp and reading it
// as UTC avoids the host's own timezone.
function localTime(date, offsetHours) {
  const shifted = new Date(date.getTime() + offsetHours * 3600e3)
  return {
    day: shifted.getUTCDay(), // 0 = Sunday
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  }
}

// The optional preset window: weekends all day, weekdays 12:00-14:00 and
// 18:00-09:00 in UTC+8.
export function isOffPeakPreset(d) {
  const date = d instanceof Date ? d : new Date(d)
  if (isNaN(date.getTime())) return false

  const { day, minutes } = localTime(date, 8)
  if (day === 0 || day === 6) return true

  const morningPeak = minutes >= 9 * 60 && minutes < 12 * 60
  const afternoonPeak = minutes >= 14 * 60 && minutes < 18 * 60
  return !(morningPeak || afternoonPeak)
}

// Kept for callers of the earlier version; the name above says what it is.
export const isDeepSeekOffPeak = isOffPeakPreset

function parseClock(v) {
  if (typeof v !== "string") return null
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

function offsetOf(w) {
  return typeof w.tz === "number" && Number.isFinite(w.tz) && Math.abs(w.tz) <= 14 ? w.tz : 8
}

function daysOf(w) {
  if (w.days === undefined) return null // every day
  if (!Array.isArray(w.days)) return new Set()
  return new Set(w.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))
}

// A window runs from start to end in its own offset; if the end is before
// the start the window crosses midnight, and that second half belongs to
// the previous day when days are given.
function inWindow(w, date) {
  if (!w || typeof w !== "object") return false
  const start = parseClock(w.start)
  const end = parseClock(w.end)
  if (start === null || end === null) return false

  const { day, minutes } = localTime(date, offsetOf(w))
  const days = daysOf(w)
  const onDay = (d) => days === null || days.has(d)

  if (start === end) return onDay(day)
  if (start < end) return onDay(day) && minutes >= start && minutes < end
  return (onDay(day) && minutes >= start) || (onDay((day + 6) % 7) && minutes < end)
}

function offPeakNow(schedule, d) {
  if (!schedule || typeof schedule !== "object") return false
  if (schedule.cst_deepseek_offpeak === false) return false

  const date = d instanceof Date ? d : new Date(d)
  if (isNaN(date.getTime())) return false

  if (schedule.offpeak !== undefined && schedule.offpeak !== null) {
    const windows = Array.isArray(schedule.offpeak) ? schedule.offpeak : [schedule.offpeak]
    return windows.some((w) => inWindow(w, date))
  }
  // The preset, used when asked for, and also when only offpeak_mapping
  // was set, as before the preset had a switch.
  return isOffPeakPreset(date)
}

// true when a part, or a tool result/function output nested in it, carries
// an image: Anthropic "image", chat "image_url", Responses "input_image",
// or Gemini inline/file data.
function hasImageIn(content) {
  if (Array.isArray(content)) return content.some(hasImageIn)
  if (!content || typeof content !== "object") return false

  if (IMAGE_TYPES.has(content.type)) return true
  if (content.inlineData || content.inline_data || content.fileData || content.file_data) return true

  // tool_result content, function_call_output, Gemini parts
  for (const key of ["content", "output", "parts"]) {
    const v = content[key]
    if (Array.isArray(v) && hasImageIn(v)) return true
  }
  return false
}

function hasImage(body) {
  if (!body || typeof body !== "object") return false

  if (Array.isArray(body.messages)) {
    for (const m of body.messages) if (hasImageIn(m?.content)) return true
  }

  // Responses input items, including function_call_output
  if (Array.isArray(body.input)) {
    for (const item of body.input) if (hasImageIn(item)) return true
  }

  // Gemini contents
  if (Array.isArray(body.contents)) {
    for (const c of body.contents) if (hasImageIn(c?.parts)) return true
  }

  return false
}

// Characters of text in a message part, including Anthropic tool_result
// content and Responses function_call_output, which hold most of an agent's
// context once tools start running. Images are not counted.
function textLength(content) {
  if (typeof content === "string") return content.length
  if (Array.isArray(content)) {
    let n = 0
    for (const part of content) n += textLength(part)
    return n
  }
  if (!content || typeof content !== "object") return 0

  let n = 0
  for (const key of ["text", "input_text", "output_text"]) {
    const v = content[key]
    if (typeof v === "string") n += v.length
    else if (Array.isArray(v)) n += textLength(v)
  }

  n += textLength(content.content)
  n += textLength(content.parts)
  if (content.type === "tool_result" || content.type === "function_call_output") {
    n += textLength(content.output)
  }
  return n
}

function estimateTokens(body) {
  if (!body || typeof body !== "object") return 0
  let chars = textLength(body.system)

  if (Array.isArray(body.messages)) {
    for (const m of body.messages) chars += textLength(m?.content)
  }
  if (Array.isArray(body.input)) {
    for (const item of body.input) chars += textLength(item?.content) + textLength(item?.output)
  }
  if (Array.isArray(body.contents)) {
    for (const c of body.contents) chars += textLength(c?.parts)
  }
  return Math.ceil(chars / 4)
}

// Only own keys of the mapping are read, and only a string target counts:
// a model named "constructor" or "__proto__" must not find anything on
// Object.prototype. Exact names first, then "*", then /pattern/ keys.
function resolveMap(model, mapping) {
  if (!mapping || typeof mapping !== "object" || typeof model !== "string" || !model) return null

  const pick = (key) => (has(mapping, key) && typeof mapping[key] === "string" && mapping[key] ? mapping[key] : null)

  const exact = pick(model)
  if (exact) return exact
  const star = pick("*")
  if (star) return star

  for (const pattern of Object.keys(mapping)) {
    if (!pattern.startsWith("/") || !pattern.endsWith("/") || pattern.length < 3) continue
    const target = mapping[pattern]
    if (typeof target !== "string" || !target) continue
    try {
      if (new RegExp(pattern.slice(1, -1)).test(model)) return target
    } catch {
      // ignore invalid regex
    }
  }
  return null
}

export function onRequest(body, ctx) {
  if (!body || typeof body !== "object") return
  if (body.model === null || typeof body.model !== "string") return

  const options = ctx.options || {}
  const original = body.model
  let target = null

  // 1. Modality gate: images go to a vision model.
  if (options.constraints?.vision && hasImage(body)) {
    target = options.constraints.vision
  }

  // 2. Scale gate: a large estimated context goes to a long-context model.
  if (!target && options.constraints?.tokens_gte) {
    const conf = options.constraints.tokens_gte
    const threshold = typeof conf === "number" ? conf : typeof conf?.threshold === "number" ? conf.threshold : 64000
    const tgt = typeof conf === "object" ? conf.target : null
    if (typeof tgt === "string" && tgt && estimateTokens(body) >= threshold) target = tgt
  }

  // 3. Schedule gate: only while the schedule itself says off-peak.
  const schedule = options.schedule
  if (!target && schedule?.offpeak_mapping && offPeakNow(schedule, options.now || new Date())) {
    target = resolveMap(original, schedule.offpeak_mapping)
  }

  // 4. The plain mapping.
  if (!target && options.mapping) {
    target = resolveMap(original, options.mapping)
  }

  if (target && typeof target === "string" && target !== original) {
    ctx.state.asked = original
    body.model = target
    return body
  }
}

export function onEvent(ev, ctx) {
  const asked = ctx.state.asked
  if (!asked || ctx.options?.keep_upstream_name) return

  if (ev.type === "message_start" && ev.message && typeof ev.message.model === "string") {
    ev.message.model = asked
    return ev
  }
  if (typeof ev.model === "string" && ev.model !== asked) {
    ev.model = asked
    return ev
  }
  if (ev.response && typeof ev.response.model === "string") {
    ev.response.model = asked
    return ev
  }
  if (typeof ev.modelVersion === "string" && ev.modelVersion !== asked) {
    ev.modelVersion = asked
    return ev
  }
}

export function onResponse(body, ctx) {
  const asked = ctx.state.asked
  if (!asked || ctx.options?.keep_upstream_name || ctx.status >= 400) return

  if (typeof body.model === "string") {
    body.model = asked
    return body
  }
  if (body.response && typeof body.response.model === "string") {
    body.response.model = asked
    return body
  }
  if (typeof body.modelVersion === "string" && body.modelVersion !== asked) {
    body.modelVersion = asked
    return body
  }
}
