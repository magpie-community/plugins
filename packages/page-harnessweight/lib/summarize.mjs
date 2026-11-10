// The comparison: magpie's usage rows and the hook's tool samples, grouped by
// agent. Everything here is plain arithmetic over numbers already recorded;
// nothing is estimated except the tool tokens, which say so.
import { kindOf } from "./usage.mjs"

export const PERIODS = { today: 24 * 3600e3, "7d": 7 * 24 * 3600e3, "30d": 30 * 24 * 3600e3 }

// JSON bytes per token of a tool declaration, roughly. JSON is dense (short
// ASCII keys), about 3.5 bytes a token. The same estimate for every agent.
export const BYTES_PER_TOKEN = 3.5

function median(xs) {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

function bump(map, key, n = 1) { map.set(key, (map.get(key) || 0) + n) }
function top(map, n) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, count]) => ({ name, count }))
}

function dayKey(t, tzOffsetMin) {
  return new Date(t - tzOffsetMin * 60e3).toISOString().slice(0, 10)
}

export function summarize({ usage = [], tools = [], period = "7d", now = Date.now(), showClients = false, tzOffsetMin = 0, nameOf = (a) => a }) {
  const span = PERIODS[period] ?? PERIODS["7d"]
  const since = now - span
  const by = new Map()
  const get = (agent) => {
    let a = by.get(agent)
    if (!a) {
      a = {
        agent, kind: kindOf(agent), calls: 0, failed: 0, cancelled: 0,
        in: 0, out: 0, cacheRead: 0, cacheWrite: 0, credits: 0,
        ms: [], ttft: [], models: new Map(), protocols: new Map(), days: new Map(),
        first: Infinity, last: 0,
        tool: { samples: 0, count: 0, bytes: 0, names: new Map(), first: Infinity },
      }
      by.set(agent, a)
    }
    return a
  }

  let hidden = 0
  for (const r of usage) {
    if (r.t < since) continue
    if (!showClients && kindOf(r.agent) === "client") { hidden++; continue }
    const a = get(r.agent)
    a.calls++
    if (r.failed) a.failed++
    if (r.cancelled) a.cancelled++
    a.in += r.in; a.out += r.out; a.cacheRead += r.cacheRead; a.cacheWrite += r.cacheWrite
    a.credits += r.credits
    if (r.ms > 0 && !r.failed) a.ms.push(r.ms)
    if (r.ttft > 0 && !r.failed) a.ttft.push(r.ttft)
    bump(a.models, r.model)
    bump(a.protocols, r.protocol)
    const prompt = r.in + r.cacheRead + r.cacheWrite
    const d = dayKey(r.t, tzOffsetMin)
    const day = a.days.get(d) || { day: d, calls: 0, prompt: 0, out: 0 }
    day.calls++; day.prompt += prompt; day.out += r.out
    a.days.set(d, day)
    if (r.t < a.first) a.first = r.t
    if (r.t > a.last) a.last = r.t
  }

  let toolSamples = 0
  let toolsSince = Infinity
  for (const r of tools) {
    if (r.t < since) continue
    if (!showClients && kindOf(r.agent) === "client") continue
    const a = get(r.agent)
    toolSamples++
    a.tool.samples++
    a.tool.count += r.tools || 0
    a.tool.bytes += r.toolBytes || 0
    for (const n of r.toolNames || []) bump(a.tool.names, n)
    if (r.t < a.tool.first) a.tool.first = r.t
    if (r.t < toolsSince) toolsSince = r.t
  }

  const agents = [...by.values()].filter((a) => a.calls > 0 || a.tool.samples > 0).map((a) => {
    const prompt = a.in + a.cacheRead + a.cacheWrite
    const avgPrompt = a.calls ? prompt / a.calls : 0
    const tb = a.tool.samples ? a.tool.bytes / a.tool.samples : 0
    const toolTokens = tb / BYTES_PER_TOKEN
    return {
      agent: a.agent, kind: a.kind,
      calls: a.calls, failed: a.failed, cancelled: a.cancelled,
      errorRate: a.calls ? a.failed / a.calls : 0,
      prompt, avgPrompt, out: a.out, avgOut: a.calls ? a.out / a.calls : 0,
      in: a.in, cacheRead: a.cacheRead, cacheWrite: a.cacheWrite,
      // share of what the model read that came from the cache (billed cheap)
      cacheRate: prompt ? a.cacheRead / prompt : 0,
      // what was read at full price: fresh input plus cache writes
      fullPrice: a.in + a.cacheWrite,
      credits: a.credits,
      p50ms: median(a.ms), p50ttft: median(a.ttft),
      models: top(a.models, 8), protocols: top(a.protocols, 4),
      series: [...a.days.values()].sort((x, y) => (x.day < y.day ? -1 : 1)),
      first: Number.isFinite(a.first) ? a.first : null, last: a.last || null,
      tools: a.tool.samples ? {
        samples: a.tool.samples,
        avgCount: a.tool.count / a.tool.samples,
        avgBytes: tb,
        avgTokens: toolTokens,
        shareOfPrompt: avgPrompt ? Math.min(1, toolTokens / avgPrompt) : null,
        names: top(a.tool.names, 40),
        since: a.tool.first,
      } : null,
    }
  }).sort((x, y) => y.prompt - x.prompt)

  const totals = agents.reduce((t, a) => {
    t.calls += a.calls; t.failed += a.failed; t.prompt += a.prompt; t.out += a.out
    t.cacheRead += a.cacheRead; t.fullPrice += a.fullPrice; t.credits += a.credits
    return t
  }, { calls: 0, failed: 0, prompt: 0, out: 0, cacheRead: 0, fullPrice: 0, credits: 0 })
  totals.cacheRate = totals.prompt ? totals.cacheRead / totals.prompt : 0

  let lastUsage = 0, lastTool = 0
  for (let i = usage.length - 1; i >= 0 && i >= usage.length - 50; i--) if (usage[i].t > lastUsage) lastUsage = usage[i].t
  for (const r of tools) if (r.t > lastTool) lastTool = r.t
  return {
    lastUsage: lastUsage || null, lastTool: lastTool || null,
    period, since, generatedAt: now, agents, totals, hiddenClients: hidden,
    toolSamples, toolsSince: Number.isFinite(toolsSince) ? toolsSince : null,
    insights: insights(agents, nameOf),
  }
}

// The few sentences a reader takes away. Only about agents with enough calls
// to say anything, and only when there is something to compare.
export function insights(agents, nameOf = (a) => a) {
  const N = (a) => nameOf(a.agent)
  // only agents a person works in; scripts and probes never make a takeaway
  agents = agents.filter((a) => a.kind === "agent")
  const out = []
  const real = agents.filter((a) => a.calls >= 20)
  if (real.length >= 2) {
    const byPrompt = [...real].sort((a, b) => b.avgPrompt - a.avgPrompt)
    const hi = byPrompt[0], lo = byPrompt[byPrompt.length - 1]
    if (lo.avgPrompt > 0 && hi.avgPrompt / lo.avgPrompt >= 1.5) {
      out.push({ kind: "prompt", agents: [hi.agent, lo.agent], ratio: hi.avgPrompt / lo.avgPrompt,
        text: `${N(hi)} 每次请求平均读 ${fmt(hi.avgPrompt)} token，是 ${N(lo)} 的 ${(hi.avgPrompt / lo.avgPrompt).toFixed(1)} 倍。` })
    }
    const byCache = [...real].sort((a, b) => b.cacheRate - a.cacheRate)
    const c1 = byCache[0], c2 = byCache[byCache.length - 1]
    if (c1.cacheRate - c2.cacheRate >= 0.05) {
      out.push({ kind: "cache", agents: [c1.agent, c2.agent],
        text: `缓存命中最高的是 ${N(c1)}（${pct(c1.cacheRate)}），最低的是 ${N(c2)}（${pct(c2.cacheRate)}）。命中越低，按原价算的 token 越多。` })
    }
    const share = [...real].sort((a, b) => b.prompt - a.prompt)[0]
    const total = real.reduce((n, a) => n + a.prompt, 0)
    if (total) out.push({ kind: "volume", agents: [share.agent],
      text: `${N(share)} 占了这段时间 ${pct(share.prompt / total)} 的输入 token，是最大的开销来源。` })
  }
  const shaky = agents.filter((a) => a.calls >= 20 && a.errorRate >= 0.03).sort((a, b) => b.errorRate - a.errorRate)[0]
  if (shaky) out.push({ kind: "errors", agents: [shaky.agent],
    text: `${N(shaky)} 的失败率是 ${pct(shaky.errorRate)}，失败的请求同样会读 token。` })
  const withTools = agents.filter((a) => a.tools && a.tools.samples >= 3 && a.tools.avgCount > 0).sort((a, b) => b.tools.avgBytes - a.tools.avgBytes)
  if (withTools.length >= 2) {
    const h = withTools[0], l = withTools[withTools.length - 1]
    out.push({ kind: "tools", agents: [h.agent, l.agent],
      text: `${N(h)} 每次请求重发的工具定义约 ${fmt(h.tools.avgTokens)} token（${Math.round(h.tools.avgCount)} 个），是 ${N(l)}（约 ${fmt(l.tools.avgTokens)} token，${Math.round(l.tools.avgCount)} 个）的 ${(h.tools.avgTokens / Math.max(1, l.tools.avgTokens)).toFixed(1)} 倍。` })
  }
  return out
}

function fmt(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`
  return String(Math.round(n))
}
function pct(x) { return `${(x * 100).toFixed(1)}%` }
