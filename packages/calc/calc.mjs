// Exact arithmetic, unit conversion and date math for coding agents. A
// model guesses at 0.1 + 0.2, at 2^64, at how many days lie between two
// dates; these answer exactly. Numbers are fractions of BigInts, so nothing
// is rounded until the answer is written out. Nothing here reaches the
// network or reads a file.

// ---- exact numbers -----------------------------------------------------------

const abs = (a) => (a < 0n ? -a : a)
const gcd = (a, b) => {
  a = abs(a)
  b = abs(b)
  while (b) [a, b] = [b, a % b]
  return a
}

// Q is a fraction n/d in lowest terms, d > 0.
class Q {
  constructor(n, d = 1n) {
    if (d === 0n) throw new Error("division by zero")
    if (d < 0n) [n, d] = [-n, -d]
    const g = gcd(n, d) || 1n
    this.n = n / g
    this.d = d / g
  }
  add(b) { return new Q(this.n * b.d + b.n * this.d, this.d * b.d) }
  sub(b) { return new Q(this.n * b.d - b.n * this.d, this.d * b.d) }
  mul(b) { return new Q(this.n * b.n, this.d * b.d) }
  div(b) {
    if (b.n === 0n) throw new Error("division by zero")
    return new Q(this.n * b.d, this.d * b.n)
  }
  // the remainder of a truncated division, as JavaScript's %
  mod(b) {
    if (b.n === 0n) throw new Error("division by zero")
    const q = (this.n * b.d) / (this.d * b.n)
    return this.sub(b.mul(new Q(q)))
  }
  pow(e) {
    if (e.d !== 1n) throw new Error("a power must be a whole number: this answers exactly, and x^(1/2) mostly isn't")
    if (abs(e.n) > 100000n) throw new Error("a power past 100000 is too big to write out")
    let n = this.n ** abs(e.n)
    let d = this.d ** abs(e.n)
    if (e.n < 0n) [n, d] = [d, n]
    return new Q(n, d)
  }
  cmp(b) {
    const x = this.n * b.d - b.n * this.d
    return x < 0n ? -1 : x > 0n ? 1 : 0
  }
  floor() {
    const q = this.n / this.d
    return new Q(this.n < 0n && q * this.d !== this.n ? q - 1n : q)
  }
  ceil() { return this.neg().floor().neg() }
  neg() { return new Q(-this.n, this.d) }
  int() { return this.d === 1n }
  // the fraction as "n" or "n/d"
  exact() { return this.d === 1n ? String(this.n) : `${this.n}/${this.d}` }
  // the decimal, rounded half away from zero at places digits; exact says
  // whether nothing was rounded
  decimal(places = 20) {
    const neg = this.n < 0n
    const n = abs(this.n)
    const scale = 10n ** BigInt(places)
    let q = (n * scale) / this.d
    const r = (n * scale) % this.d
    if (r * 2n >= this.d) q++
    const digits = q.toString().padStart(places + 1, "0")
    const whole = places > 0 ? digits.slice(0, -places) : digits
    const frac = places > 0 ? digits.slice(-places).replace(/0+$/, "") : ""
    const s = frac ? `${whole}.${frac}` : whole
    const exact = r === 0n
    return { text: (neg && q !== 0n ? "-" : "") + s, exact }
  }
}

// parseNumber reads a literal: 12, -3.5, 1_000, 6.02e23, 0x1F, 0b101, 0o17.
export function parseNumber(src) {
  const s = String(src).trim().replace(/_/g, "")
  let m
  if ((m = /^([+-]?)0x([0-9a-f]+)$/i.exec(s))) return new Q((m[1] === "-" ? -1n : 1n) * BigInt("0x" + m[2]))
  if ((m = /^([+-]?)0b([01]+)$/i.exec(s))) return new Q((m[1] === "-" ? -1n : 1n) * BigInt("0b" + m[2]))
  if ((m = /^([+-]?)0o([0-7]+)$/i.exec(s))) return new Q((m[1] === "-" ? -1n : 1n) * BigInt("0o" + m[2]))
  m = /^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(s)
  if (!m || (m[2] === "" && (m[3] ?? "") === "")) throw new Error(`not a number: ${src}`)
  const frac = m[3] ?? ""
  let n = BigInt((m[2] || "0") + frac)
  let d = 10n ** BigInt(frac.length)
  const e = Number(m[4] ?? 0)
  if (Math.abs(e) > 10000) throw new Error(`exponent too big: ${src}`)
  if (e > 0) n *= 10n ** BigInt(e)
  else if (e < 0) d *= 10n ** BigInt(-e)
  return new Q(m[1] === "-" ? -n : n, d)
}

// ---- expressions -------------------------------------------------------------

const FUNCS = {
  abs: (a) => (a.n < 0n ? a.neg() : a),
  floor: (a) => a.floor(),
  ceil: (a) => a.ceil(),
  round: (a) => (a.n < 0n ? a.neg().add(new Q(1n, 2n)).floor().neg() : a.add(new Q(1n, 2n)).floor()),
  trunc: (a) => (a.n < 0n ? a.ceil() : a.floor()),
  min: (...xs) => xs.reduce((a, b) => (b.cmp(a) < 0 ? b : a)),
  max: (...xs) => xs.reduce((a, b) => (b.cmp(a) > 0 ? b : a)),
  gcd: (...xs) => {
    if (!xs.every((x) => x.int())) throw new Error("gcd takes whole numbers")
    return new Q(xs.reduce((a, b) => gcd(a, b.n), 0n))
  },
  lcm: (...xs) => {
    if (!xs.every((x) => x.int())) throw new Error("lcm takes whole numbers")
    return new Q(xs.reduce((a, b) => (a === 0n || b.n === 0n ? 0n : abs(a * b.n) / gcd(a, b.n)), 1n))
  },
  fact: (a) => {
    if (!a.int() || a.n < 0n || a.n > 5000n) throw new Error("fact takes a whole number from 0 to 5000")
    let r = 1n
    for (let i = 2n; i <= a.n; i++) r *= i
    return new Q(r)
  },
}

function tokens(src) {
  const out = []
  const re = /\s*(?:(0x[0-9a-f_]+|0b[01_]+|0o[0-7_]+|(?:\d[\d_]*)?\.?\d[\d_]*(?:e[+-]?\d+)?)|(\*\*|[-+*/%^(),])|([a-z]+))/giy
  let i = 0
  while (i < src.length) {
    if (/^\s*$/.test(src.slice(i))) break
    re.lastIndex = i
    const m = re.exec(src)
    if (!m) throw new Error(`can't read "${src.slice(i).trim().slice(0, 12)}" at ${i}`)
    out.push(m[1] ? { num: m[1] } : m[2] ? { op: m[2] } : { name: m[3].toLowerCase() })
    i = re.lastIndex
  }
  return out
}

// evaluate is the exact value of an arithmetic expression: + - * / % ^ (or
// **), parentheses, and abs floor ceil round trunc min max gcd lcm fact.
export function evaluate(src) {
  const t = tokens(String(src))
  let p = 0
  const peek = () => t[p]
  const op = (o) => peek()?.op === o && ++p
  const expect = (o) => {
    if (!op(o)) throw new Error(`expected "${o}"${peek() ? "" : " before the end"}`)
  }
  function expr() {
    let a = term()
    for (;;) {
      if (op("+")) a = a.add(term())
      else if (op("-")) a = a.sub(term())
      else return a
    }
  }
  function term() {
    let a = unary()
    for (;;) {
      if (op("*")) a = a.mul(unary())
      else if (op("/")) a = a.div(unary())
      else if (op("%")) a = a.mod(unary())
      else return a
    }
  }
  function unary() {
    if (op("-")) return unary().neg()
    if (op("+")) return unary()
    return power()
  }
  function power() {
    const a = atom()
    if (op("^") || op("**")) return a.pow(unary()) // right-assoc: 2^3^2 = 2^9
    return a
  }
  function atom() {
    const x = t[p++]
    if (!x) throw new Error("the expression ends too soon")
    if (x.num) return parseNumber(x.num)
    if (x.op === "(") {
      const a = expr()
      expect(")")
      return a
    }
    if (x.name) {
      const f = FUNCS[x.name]
      if (!f) throw new Error(`no function ${x.name}: ${Object.keys(FUNCS).join(", ")}`)
      expect("(")
      const args = [expr()]
      while (op(",")) args.push(expr())
      expect(")")
      if (["abs", "floor", "ceil", "round", "trunc", "fact"].includes(x.name) && args.length !== 1) throw new Error(`${x.name} takes one number`)
      return f(...args)
    }
    throw new Error(`unexpected "${x.op}"`)
  }
  if (!t.length) throw new Error("no expression")
  const v = expr()
  if (p < t.length) throw new Error(`unexpected "${t[p].op ?? t[p].num ?? t[p].name}"`)
  return v
}

// answer is what a tool says of a value: the exact fraction, and the
// decimal to places (marked when it was rounded).
export function answer(v, places = 20) {
  places = Math.max(0, Math.min(1000, Math.floor(places)))
  const dec = v.decimal(places)
  const out = { exact: v.exact(), decimal: dec.text }
  if (!dec.exact) out.rounded = `to ${places} places`
  return out
}

// ---- units -------------------------------------------------------------------

// each unit's size in its kind's base unit, as an exact fraction
const UNITS = {}
const unit = (kind, factor, ...names) => {
  for (const n of names) UNITS[n] = { kind, f: typeof factor === "string" ? parseNumber(factor) : factor }
}
// data, in bytes; a lowercase b is bits
unit("data", "0.125", "bit", "bits")
unit("data", "1", "B", "byte", "bytes")
for (const [i, p] of ["k", "M", "G", "T", "P", "E"].entries()) {
  unit("data", new Q(1000n ** BigInt(i + 1)), `${p === "k" ? "kB" : p + "B"}`, `${p === "k" ? "KB" : p + "B"}`)
  unit("data", new Q(1024n ** BigInt(i + 1)), `${p === "k" ? "K" : p}iB`)
  unit("data", new Q(1000n ** BigInt(i + 1), 8n), `${p === "k" ? "kb" : p + "b"}`, `${p === "k" ? "Kb" : p + "b"}`, `${p === "k" ? "k" : p}bit`)
}
// time, in seconds
unit("time", "1e-9", "ns")
unit("time", "1e-6", "us", "µs")
unit("time", "1e-3", "ms")
unit("time", "1", "s", "sec", "second", "seconds")
unit("time", "60", "min", "minute", "minutes")
unit("time", "3600", "h", "hr", "hour", "hours")
unit("time", "86400", "d", "day", "days")
unit("time", "604800", "wk", "week", "weeks")
// length, in metres
unit("length", "1e-9", "nm")
unit("length", "1e-6", "um", "µm")
unit("length", "1e-3", "mm")
unit("length", "1e-2", "cm")
unit("length", "1", "m")
unit("length", "1e3", "km")
unit("length", "0.0254", "in", "inch")
unit("length", "0.3048", "ft", "foot", "feet")
unit("length", "0.9144", "yd")
unit("length", "1609.344", "mi", "mile")
unit("length", "1852", "nmi")
// typographic, in CSS pixels at 96 per inch
unit("css", "1", "px")
unit("css", new Q(4n, 3n), "pt")
unit("css", "16", "pc")
unit("css", "96", "in-css")
// mass, in grams
unit("mass", "1e-3", "mg")
unit("mass", "1", "g")
unit("mass", "1e3", "kg")
unit("mass", "1e6", "t")
unit("mass", "28.349523125", "oz")
unit("mass", "453.59237", "lb")
// angles, in turns: degrees and turns are exact, radians are not
unit("angle", new Q(1n, 360n), "deg")
unit("angle", "1", "turn")
unit("angle", new Q(1n, 400n), "grad")

// temperatures are offsets, so each is a pair: to kelvin and back
const TEMPS = {
  C: { to: (v) => v.add(new Q(27315n, 100n)), from: (k) => k.sub(new Q(27315n, 100n)) },
  F: { to: (v) => v.sub(new Q(32n)).mul(new Q(5n, 9n)).add(new Q(27315n, 100n)), from: (k) => k.sub(new Q(27315n, 100n)).mul(new Q(9n, 5n)).add(new Q(32n)) },
  K: { to: (v) => v, from: (k) => k },
}

// convert is value in from, in to.
export function convert(value, from, to) {
  const v = typeof value === "string" ? evaluate(value) : parseNumber(String(value))
  const tf = from.replace(/^°/, "")
  const tt = to.replace(/^°/, "")
  if (TEMPS[tf] || TEMPS[tt]) {
    if (!TEMPS[tf] || !TEMPS[tt]) throw new Error(`can't convert ${from} to ${to}`)
    return TEMPS[tt].from(TEMPS[tf].to(v))
  }
  const a = UNITS[from]
  const b = UNITS[to]
  if (!a) throw new Error(`no unit ${from}: ${Object.keys(UNITS).concat("C", "F", "K").join(" ")}`)
  if (!b) throw new Error(`no unit ${to}: ${Object.keys(UNITS).concat("C", "F", "K").join(" ")}`)
  if (a.kind !== b.kind) throw new Error(`${from} is ${a.kind} and ${to} is ${b.kind}`)
  return v.mul(a.f).div(b.f)
}

// ---- dates -------------------------------------------------------------------

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

// offsetMs is tz's offset from UTC at instant ms.
function offsetMs(ms, tz) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]))
  const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second)
  return wall - Math.floor(ms / 1000) * 1000
}

// wallParts is the calendar date and time at ms in tz ("UTC" when none).
function wallParts(ms, tz) {
  const d = new Date(ms + (tz ? offsetMs(ms, tz) : 0))
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds(), ms: d.getUTCMilliseconds() }
}

// fromWall is the instant a wall time in tz names.
function fromWall(w, tz) {
  const wall = Date.UTC(w.y, w.mo, w.d, w.h, w.mi, w.s, w.ms)
  if (!tz) return wall
  let t = wall - offsetMs(wall, tz)
  t = wall - offsetMs(t, tz)
  return t
}

// parseDate is an instant: "now", unix seconds or milliseconds, or an ISO
// 8601 date or date-time. One with no offset is a wall time in tz (UTC
// when tz is "").
export function parseDate(src, tz, now = Date.now()) {
  const s = String(src ?? "now").trim()
  if (s === "" || s.toLowerCase() === "now") return now
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const n = Number(s)
    return Math.abs(n) < 1e11 ? Math.round(n * 1000) : Math.round(n)
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(s)
  if (!m) throw new Error(`not a date: ${src} (ISO 8601, unix seconds or ms, or "now")`)
  const w = { y: +m[1], mo: +m[2] - 1, d: +m[3], h: +(m[4] ?? 0), mi: +(m[5] ?? 0), s: +(m[6] ?? 0), ms: Math.floor(+((m[7] ?? "0") + "00").slice(0, 3)) }
  const check = new Date(Date.UTC(w.y, w.mo, w.d))
  if (check.getUTCMonth() !== w.mo || check.getUTCDate() !== w.d || w.h > 23 || w.mi > 59 || w.s > 60) throw new Error(`no such date: ${src}`)
  if (!m[8]) return fromWall(w, tz)
  const z = m[8].toUpperCase()
  if (z === "Z") return fromWall(w, "")
  const sign = z[0] === "-" ? -1 : 1
  const [, hh, mm] = /^[+-](\d{2}):?(\d{2})$/.exec(z)
  return fromWall(w, "") - sign * (+hh * 3600000 + +mm * 60000)
}

const DUR = { y: "y", yr: "y", year: "y", years: "y", mo: "mo", month: "mo", months: "mo", w: "w", wk: "w", week: "w", weeks: "w", d: "d", day: "d", days: "d", h: "h", hr: "h", hour: "h", hours: "h", m: "m", min: "m", minute: "m", minutes: "m", s: "s", sec: "s", second: "s", seconds: "s", ms: "ms" }

// parseDuration reads "3d 4h", "-90m", "1y2mo", "2 weeks" or ISO 8601's
// "P1Y2M3DT4H5M6S" into its parts.
export function parseDuration(src) {
  let s = String(src).trim()
  const out = { y: 0, mo: 0, w: 0, d: 0, h: 0, m: 0, s: 0, ms: 0 }
  const iso = /^([+-])?P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(s)
  if (iso && s.length > 1 + (iso[1] ? 1 : 0)) {
    const k = iso[1] === "-" ? -1 : 1
    ;[out.y, out.mo, out.w, out.d, out.h, out.m] = [2, 3, 4, 5, 6, 7].map((i) => k * +(iso[i] ?? 0))
    const sec = +(iso[8] ?? 0)
    out.s = k * Math.trunc(sec)
    out.ms = k * Math.round((sec % 1) * 1000)
    return out
  }
  let sign = 1
  if (/^[+-]/.test(s)) {
    sign = s[0] === "-" ? -1 : 1
    s = s.slice(1)
  }
  const re = /\s*(\d+(?:\.\d+)?)\s*([a-z]+)\s*,?/giy
  let i = 0
  let any = false
  while (i < s.length) {
    re.lastIndex = i
    const m = re.exec(s)
    if (!m) throw new Error(`not a duration: ${src} (like "3d 4h", "-90m", "1y2mo" or "P1DT2H")`)
    const u = DUR[m[2].toLowerCase()] ?? (m[2] === "M" ? "mo" : undefined)
    if (!u) throw new Error(`no duration unit ${m[2]}: y mo w d h m s ms`)
    const n = Number(m[1])
    if (["y", "mo"].includes(u) && !Number.isInteger(n)) throw new Error(`${m[0].trim()}: years and months are whole`)
    out[u] += sign * n
    any = true
    i = re.lastIndex
  }
  if (!any) throw new Error(`not a duration: ${src}`)
  return out
}

// addDuration is ms plus dur, years, months, weeks and days on tz's
// calendar (a month on from Jan 31 is the last of February), the rest
// in elapsed time.
export function addDuration(ms, dur, tz) {
  const w = wallParts(ms, tz)
  const months = w.mo + dur.y * 12 + dur.mo
  const y = w.y + Math.floor(months / 12)
  const mo = ((months % 12) + 12) % 12
  const last = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate()
  const day = Math.min(w.d, last)
  // whole days, as the calendar's days, then fractions of one as time
  const days = dur.w * 7 + dur.d
  const wholeDays = Math.trunc(days)
  const base = fromWall({ ...w, y, mo, d: day + wholeDays }, tz)
  return base + Math.round((days - wholeDays) * 86400000 + dur.h * 3600000 + dur.m * 60000 + dur.s * 1000 + dur.ms)
}

const pad = (n, l = 2) => String(n).padStart(l, "0")

// describe is what the date tool says of an instant in tz.
export function describe(ms, tz) {
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) throw new Error("the date is out of range")
  const w = wallParts(ms, tz)
  const off = tz ? offsetMs(ms, tz) / 60000 : 0
  const offText = off === 0 && !tz ? "Z" : `${off < 0 ? "-" : "+"}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`
  const local = `${pad(w.y, 4)}-${pad(w.mo + 1)}-${pad(w.d)}T${pad(w.h)}:${pad(w.mi)}:${pad(w.s)}${w.ms ? "." + pad(w.ms, 3) : ""}${offText}`
  const day0 = Date.UTC(w.y, w.mo, w.d)
  const dayOfYear = Math.round((day0 - Date.UTC(w.y, 0, 1)) / 86400000) + 1
  // ISO week: the week with the year's first Thursday is week 1
  const wd = (new Date(day0).getUTCDay() + 6) % 7
  const thu = new Date(day0 + (3 - wd) * 86400000)
  const isoWeek = Math.floor((thu - Date.UTC(thu.getUTCFullYear(), 0, 1)) / (7 * 86400000)) + 1
  const out = { iso: new Date(ms).toISOString() }
  if (tz) out.local = local
  if (tz) out.timeZone = tz
  Object.assign(out, { weekday: WEEKDAYS[new Date(day0).getUTCDay()], unix: Math.floor(ms / 1000), unixMs: ms, dayOfYear, isoWeek: `${thu.getUTCFullYear()}-W${pad(isoWeek)}` })
  return out
}

// between is the time from a to b: in elapsed units, and as calendar
// years, months and days in tz.
export function between(a, b, tz) {
  const sign = b < a ? -1 : 1
  const [lo, hi] = sign < 0 ? [b, a] : [a, b]
  const ms = hi - lo
  // the calendar count: the most whole months that fit, then days
  const wl = wallParts(lo, tz)
  const wh = wallParts(hi, tz)
  let months = (wh.y - wl.y) * 12 + (wh.mo - wl.mo)
  while (months > 0 && addDuration(lo, { y: 0, mo: months, w: 0, d: 0, h: 0, m: 0, s: 0, ms: 0 }, tz) > hi) months--
  let at = addDuration(lo, { y: 0, mo: months, w: 0, d: 0, h: 0, m: 0, s: 0, ms: 0 }, tz)
  let days = 0
  while (addDuration(at, { y: 0, mo: 0, w: 0, d: 1, h: 0, m: 0, s: 0, ms: 0 }, tz) <= hi) {
    at = addDuration(at, { y: 0, mo: 0, w: 0, d: 1, h: 0, m: 0, s: 0, ms: 0 }, tz)
    days++
  }
  const rest = hi - at
  const parts = []
  const y = Math.floor(months / 12)
  if (y) parts.push(`${y}y`)
  if (months % 12) parts.push(`${months % 12}mo`)
  if (days) parts.push(`${days}d`)
  const h = Math.floor(rest / 3600000)
  const m = Math.floor((rest % 3600000) / 60000)
  const s = Math.floor((rest % 60000) / 1000)
  const r = rest % 1000
  if (h) parts.push(`${h}h`)
  if (m) parts.push(`${m}m`)
  if (s) parts.push(`${s}s`)
  if (r) parts.push(`${r}ms`)
  const k = (x) => sign * x
  return {
    calendar: (sign < 0 ? "-" : "") + (parts.join(" ") || "0s"),
    days: k(ms / 86400000),
    hours: k(ms / 3600000),
    minutes: k(ms / 60000),
    seconds: k(ms / 1000),
    ms: k(ms),
  }
}

// checkZone is tz if the system knows it.
export function checkZone(tz) {
  if (!tz) return ""
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz })
  } catch {
    throw new Error(`no time zone ${tz}: an IANA name such as Europe/Berlin or Asia/Shanghai`)
  }
  return tz
}
