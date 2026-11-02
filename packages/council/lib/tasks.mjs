// What each tool does, as a job: ask, vote and review, and the models list.

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { catalog } from "./catalog.mjs"
import { fanOut } from "./fan.mjs"
import { loadImages } from "./files.mjs"
import { postJSON } from "./gateway.mjs"
import { choose, councilGroup, excluded, kindsOf } from "./pick.mjs"
import { fixFor, langOf, words } from "./text.mjs"

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
const EFFORTS = new Set(["auto", "low", "medium", "high", "max"])

const str = (v) => (typeof v === "string" ? v : v == null ? "" : String(v))
const bool = (v) => v === true || v === "true"
const int = (v, d, lo, hi) => (Number.isFinite(+v) && +v >= lo ? Math.min(hi, Math.floor(+v)) : d)

// what the caller asked for, checked: magpie hands the arguments on as they came
export function settle(args, o, defaults) {
  const fast = bool(args.fast) || o.tier === "fast"
  const asked = str(args.effort || o.effort).toLowerCase()
  return {
    fast,
    effort: EFFORTS.has(asked) ? asked : fast ? "low" : defaults.effort,
    count: int(args.count ?? o.count, defaults.count, 1, 12),
    models: args.models ?? args.model ?? o.models,
    web: bool(args.web),
    files: args.files ?? args.images,
    // show the models to choose from first: asked for this time, or always (option confirm) when none are named
    choose: bool(args.choose) || (bool(o.confirm) && args.models == null && args.model == null),
  }
}

const tokensOf = (text, images) => Math.ceil(text.length / 2) + images.length * 1600

async function searchWeb(o, query) {
  const res = await postJSON(
    o,
    "/mcp/magpie/web-search",
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "web_search", arguments: { query: query.slice(0, 400) } } },
    AbortSignal.timeout(45_000),
  )
  const r = res.json?.result
  const text = (r?.content || []).map((c) => c?.text || "").join("\n").trim()
  if (!res.ok || res.json?.error || r?.isError || !text) throw new Error(res.json?.error?.message || text || `HTTP ${res.status}`)
  return text
}

function compose(W, question, context, web) {
  let s = question
  if (context) s += `\n\n${W.contextBlock}\n\n${context}`
  if (web) s += `\n\n${W.webBlock}\n\n${web}`
  return s
}

const head = (W, run) => `## ${run.m.name} · ${run.m.id} · ${W.secs(run.r.ms)}${W.effort(run.r.level)}`

function footer(W, runs, skipped) {
  const lines = []
  const missed = runs.filter((x) => x.r && !x.r.ok && x.r.kind !== "extra").map((x) => `${x.m.id}（${W.reason(x.r.kind)}）`)
  if (missed.length) lines.push(W.missed(missed))
  if (skipped?.length) lines.push(W.skipped(skipped.length))
  return lines.length ? `\n\n---\n${lines.join("\n")}` : ""
}

// What to say when there is nobody to ask, and what to do about it.
function nobody(W, picked, images, text) {
  const lang = W === words("zh") ? "zh" : "en"
  const lines =
    picked.empty === "none"
      ? [W.noCatalog]
      : picked.empty === "vision"
        ? [W.noVisionModels]
        : picked.empty === "toolong"
          ? [W.tooLong(tokensOf(text, images))]
          : [W.noModels, ...picked.skipped.map((s) => W.fixLine(s.provider, W.reason(s.kind), fixFor(lang, s.kind, s.why)))]
  return [...lines, ...picked.notes].join("\n")
}

// The pieces every job starts from: the language, images, notes and models.
async function prepare(o, health, args, s, text, { avoid, tier, count, vision } = {}) {
  const W = words(langOf(text))
  await health.load()
  const { images, notes } = await loadImages(s.files, W)
  const picked = await choose(
    o,
    health,
    s.models,
    { count: count ?? s.count, tier: tier ?? (s.fast ? "fast" : "best"), vision: vision ?? images.length > 0, tokens: tokensOf(text, images), avoid },
    W,
  )
  return { ...picked, W, images, notes: [...notes, ...picked.notes], nobody: () => nobody(W, { ...picked, notes: [...notes, ...picked.notes] }, images, text) }
}

export function askJob(o, health, args, s) {
  return async (job) => {
    const question = str(args.question).trim()
    const context = str(args.context).trim()
    const { W, images, notes, picks, reserve, spare, skipped, nobody } = await prepare(o, health, args, s, question + context)
    if (!picks.length) return nobody()
    let web = ""
    if (s.web) {
      job.view = () => W.searching(job.id)
      try {
        web = await searchWeb(o, question)
      } catch (e) {
        notes.push(W.webFailed(String(e?.message || e).slice(0, 120)))
      }
    }
    const prompt = { text: compose(W, question, context, web), images }
    const render = (runs, done) => {
      const ok = runs.filter((x) => x.r?.ok)
      const parts = [ok.length || !done ? W.answered(ok.length) : W.noneAnswered, ...notes]
      for (const x of ok) parts.push(`${head(W, x)}\n\n${x.r.text}`)
      const wait = runs.filter((x) => !x.r)
      if (!done && wait.length) parts.push(W.thinking(wait.map((x) => x.m.id), job.id))
      return parts.join("\n\n") + (done ? footer(W, runs, skipped) : "")
    }
    const { runs, finished } = fanOut({ o, health, picks, reserve, spare, prompt, effort: s.effort, need: picks.length, graceMs: graceOf(s, o) })
    job.view = () => render(runs, false)
    await finished
    return render(runs, true)
  }
}

const graceOf = (s, o) => Number(o.graceMs) || (s.effort === "high" || s.effort === "max" ? 150_000 : 60_000)

const shuffle = (xs) => {
  const a = [...xs]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

function readBallot(text, valid) {
  let vote
  let reason
  try {
    const j = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || "")
    vote = str(j.vote).trim().toUpperCase().replace(/^(方案|PROPOSAL)\s*/i, "")
    reason = str(j.reason).trim()
  } catch {
    vote = text.match(/(?:方案|proposal)\s*([A-Z])|"vote"\s*:\s*"([A-Z])"|^\s*([A-Z])\b/i)?.slice(1).find(Boolean)?.toUpperCase()
  }
  return valid.has(vote) ? { vote, reason } : null
}

export function voteJob(o, health, args, s) {
  return async (job) => {
    const question = str(args.question).trim()
    const context = str(args.context).trim()
    const { W, images, notes, picks, reserve, spare, skipped, nobody } = await prepare(o, health, args, s, question + context)
    if (!picks.length) return nobody()
    let web = ""
    if (s.web) {
      job.view = () => W.searching(job.id)
      try {
        web = await searchWeb(o, question)
      } catch (e) {
        notes.push(W.webFailed(String(e?.message || e).slice(0, 120)))
      }
    }
    const q = compose(W, question, context, web)
    const first = fanOut({ o, health, picks, reserve, spare, prompt: { text: `${W.vote1}\n\n${q}`, images }, effort: s.effort, need: picks.length, graceMs: graceOf(s, o) })
    job.view = () => W.votingNow(first.runs.filter((x) => x.r?.ok).length, first.runs.length, job.id)
    await first.finished
    const proposals = shuffle(first.runs.filter((x) => x.r.ok)).map((x, i) => ({ ...x, letter: LETTERS[i] }))
    if (proposals.length < 2) {
      const only = proposals[0] ? `\n\n${W.onlyOne(proposals[0].m.id)}\n\n${proposals[0].r.text}` : ""
      return [W.voteShort(proposals.length), ...notes].join("\n\n") + only + footer(W, first.runs, skipped)
    }

    const ballot =
      `${W.vote2(proposals.length)}\n\n${W.question}\n\n${q}\n\n` + proposals.map((p) => `### ${W.proposal(p.letter)}\n\n${p.r.text}`).join("\n\n")
    const second = fanOut({ o, health, picks: proposals.map((p) => p.m), prompt: { text: ballot, images }, effort: s.effort, need: proposals.length, graceMs: graceOf(s, o) })
    job.view = () => W.ballotingNow(second.runs.filter((x) => x.r?.ok).length, second.runs.length, job.id)
    await second.finished

    const valid = new Set(proposals.map((p) => p.letter))
    const tally = Object.fromEntries(proposals.map((p) => [p.letter, []]))
    const lines = []
    for (const x of second.runs) {
      if (!x.r.ok) {
        lines.push(`- ${x.m.id}: ${W.noBallot(W.reason(x.r.kind))}`)
        continue
      }
      const b = readBallot(x.r.text, valid)
      if (!b) {
        lines.push(`- ${x.m.id}: ${W.spoilt(x.r.text.slice(0, 80).replace(/\s+/g, " "))}`)
        continue
      }
      tally[b.vote].push(x.m.id)
      lines.push(`- ${x.m.id} → ${W.proposal(b.vote)}${b.reason ? `: ${b.reason.slice(0, 200)}` : ""}`)
    }
    const ranked = [...proposals].sort((a, b) => tally[b.letter].length - tally[a.letter].length)
    const top = tally[ranked[0].letter].length
    const winners = ranked.filter((p) => tally[p.letter].length === top)
    const verdict = !top ? W.noVotes : winners.length > 1 ? W.tie(winners.map((p) => p.letter), top) : W.winner(winners[0].letter, top, winners[0].m.id)
    const board = ranked.map((p) => `- ${W.proposal(p.letter)}: ${W.votes(tally[p.letter].length, p.m.id)}`).join("\n")
    const body = proposals.map((p) => `### ${W.proposal(p.letter)} · ${p.m.id}${W.effort(p.r.level)}\n\n${p.r.text}`).join("\n\n")
    return (
      [verdict, ...notes, `${W.tally}\n${board}`, `${W.ballots}\n${lines.join("\n")}`, `## ${W.allProposals}\n\n${body}`].join("\n\n") +
      footer(W, first.runs, skipped)
    )
  }
}

export function reviewJob(o, health, args, s, agent) {
  return async (job) => {
    const content = str(args.content).trim()
    const goal = str(args.goal).trim()
    // an independent look: a provider other than the calling agent's, when there is one
    const { W, images, notes, picks, reserve, spare, skipped, nobody } = await prepare(o, health, args, s, content + goal, { avoid: agent })
    if (!picks.length) return nobody()
    const prompt = { system: W.reviewSystem, text: (goal ? `${W.goal}${goal}\n\n` : "") + `${W.toReview}\n\n${content}`, images }
    const render = (runs, done) => {
      const parts = [...notes]
      for (const x of runs.filter((r) => r.r?.ok)) parts.push(`## ${W.reviewBy(x.m.name)} · ${x.m.id} · ${W.secs(x.r.ms)}${W.effort(x.r.level)}\n\n${x.r.text}`)
      if (!runs.some((x) => x.r?.ok) && done) parts.unshift(W.noneAnswered)
      const wait = runs.filter((x) => !x.r)
      if (!done && wait.length) parts.push(W.thinking(wait.map((x) => x.m.id), job.id))
      return parts.join("\n\n") + (done ? footer(W, runs, skipped) : "")
    }
    const { runs, finished } = fanOut({ o, health, picks, reserve, spare, prompt, effort: s.effort, need: picks.length, graceMs: graceOf(s, o) })
    job.view = () => render(runs, false)
    await finished
    return render(runs, true)
  }
}

// The models to choose from, before asking: every chat model that can be used
// now, by provider and kind, ★ on the ones council would take by itself.
export async function menuView(o, health, s, text, tool, count) {
  const lang = langOf(text)
  const W = words(lang)
  const zh = lang === "zh"
  await health.load()
  const all = (await catalog(o)).filter((m) => !excluded(o, m))
  const picked = await choose(o, health, s.models ?? [], { count, tier: s.fast ? "fast" : "best", vision: false, tokens: 0 }, W)
  const star = new Set(picked.picks.map((m) => m.id))
  const up = all.filter((m) => m.chat && !m.group && !health.held(m))
  if (!up.length) return nobody(W, picked, [], text)
  const groups = new Map()
  for (const m of up) {
    if (!groups.has(m.provider)) groups.set(m.provider, [])
    groups.get(m.provider).push(m)
  }
  const lines = [
    zh
      ? `先选模型：下面是现在能用的 ${up.length} 个对话模型，★ 是推荐的 ${star.size} 个。请把清单给用户看、让用户选，然后带上 models 再调用一次 ${tool}。用户说「用推荐的」就传 ["auto"]；也可以传完整 id、简称（sonnet）或供应商名（claude），想在推荐的基础上加几个就传 ["auto", "sonnet"]。`
      : `Choose the models first: below are the ${up.length} chat models that can be used now, ★ on the ${star.size} recommended. Show this to the user, let them choose, then call ${tool} again with models. "The recommended ones" is ["auto"]; full ids, short names (sonnet) and providers (claude) work too, and ["auto", "sonnet"] is the recommended ones plus Sonnet.`,
  ]
  for (const [p, ms] of groups) {
    lines.push(`\n### ${p}`)
    for (const m of kindsOf(ms, health).concat(ms.filter((x) => !kindsOf(ms, health).includes(x)))) {
      const caps = []
      if (m.reasoning) caps.push(`${zh ? "推理到" : "reasoning up to"} ${m.levels[m.levels.length - 1]}`)
      if (m.vision) caps.push(zh ? "看图" : "images")
      const st = health.state(m)
      if (st.s === "ok") caps.push(`${zh ? "最近" : "lately"} ${W.secs(st.ms)}`)
      if (st.s === "slow") caps.push(zh ? "最近较慢" : "slow lately")
      lines.push(`- ${star.has(m.id) ? "★ " : ""}${m.id}${caps.length ? ` — ${caps.join(", ")}` : ""}`)
    }
  }
  if (picked.skipped.length) lines.push(`\n${W.skipped(picked.skipped.length)}`)
  return lines.join("\n")
}

const fmtCtx = (n) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n))

// The language for a page nobody asked a question on: magpie's own (Settings ›
// Language), and when that follows the system, the system's. magpie started
// from the Dock has no LANG, so on a Mac the system's is asked of `defaults`.
let langCache
function systemLang(dir) {
  if (langCache) return langCache
  const zh = (s) => /^zh/i.test(String(s || "").trim())
  let lang = ""
  try {
    lang = JSON.parse(readFileSync(join(dir || "", "settings.json"), "utf8"))?.lang || ""
  } catch {}
  if (!lang || lang === "system") {
    lang = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || ""
    if (!lang && process.platform === "darwin") {
      try {
        lang = String(Bun.spawnSync(["defaults", "read", "-g", "AppleLanguages"]).stdout).match(/[a-z]{2,3}(?:-[A-Za-z0-9]+)*/i)?.[0] || ""
      } catch {}
    }
    if (!lang) lang = Intl.DateTimeFormat().resolvedOptions().locale
  }
  return (langCache = zh(lang) ? "zh" : "en")
}

export async function modelsView(o, health, refresh, lang = systemLang(health.dir)) {
  if (refresh) health.clear()
  await health.load()
  const all = await catalog(o, refresh)
  const zh = lang === "zh"
  const W = words(lang)
  if (!all.length) return W.noCatalog
  const picked = await choose(o, health, [], { count: 99, tier: "best", vision: false, tokens: 0 }, W)
  const star = new Set(picked.picks.map((m) => m.id))
  const groups = new Map()
  for (const m of all) {
    if (!groups.has(m.provider)) groups.set(m.provider, [])
    groups.get(m.provider).push(m)
  }
  const picks = [...groups.keys()].filter((p) => groups.get(p).some((m) => star.has(m.id)))
  const ready = picks.filter((p) => groups.get(p).some((m) => health.state(m).s === "ok"))
  const unsure = picks.filter((p) => !ready.includes(p))
  const held = new Set(picked.skipped.map((s) => s.provider))
  const slowOnes = [...groups.keys()].filter((p) => !picks.includes(p) && !held.has(p) && groups.get(p).some((m) => m.chat && !m.group))
  const list = (ps) => (ps.length ? ps.join(zh ? "、" : ", ") : zh ? "无" : "none")
  const own = councilGroup(health.dir)
  const lines = [
    (own
      ? zh
        ? `不点名时用 magpie 路由组「${own.name}」里的 ${own.members.length} 个模型（在 magpie 的「路由」页改它）。\n`
        : `With no models named, council asks the ${own.members.length} models of magpie's routing group "${own.name}" (change it on magpie's Routing page).\n`
      : zh
        ? "想在 magpie 里原生地选模型：在「路由」页建一个叫 council 的路由组，把模型加进去，不点名时就问它们。\n"
        : "To choose the models in magpie itself: make a routing group named council on magpie's Routing page; council asks its models when none are named.\n") +
    (zh
      ? `magpie 里有 ${all.length} 个模型，来自 ${groups.size} 个供应商。\n- 能用（最近答过）：${list(ready)}\n- 待确认（最近没用过，会照常试，不行就自动换掉）：${list(unsure)}${slowOnes.length ? `\n- 最近很慢（只在能用的不够时替补）：${list(slowOnes)}` : ""}`
      : `magpie has ${all.length} models from ${groups.size} providers.\n- Ready (answered lately): ${list(ready)}\n- Not checked yet (tried as usual, replaced by itself if they fail): ${list(unsure)}${slowOnes.length ? `\n- Slow lately (stand in only when too few answer): ${list(slowOnes)}` : ""}`),
  ]
  if (picked.skipped.length) {
    lines.push(
      zh
        ? `\n## 需要处理（${picked.skipped.length} 家；修好后调用 council_models 并设 refresh: true，就会马上重新用上）`
        : `\n## To fix (${picked.skipped.length}; once fixed, call council_models with refresh: true to use them again at once)`,
    )
    for (const s of picked.skipped) lines.push(W.fixLine(s.provider, W.reason(s.kind), fixFor(lang, s.kind, s.why)) + (s.why ? (zh ? `\n  原始报错：${s.why.slice(0, 160)}` : `\n  Its message: ${s.why.slice(0, 160)}`) : ""))
  }
  lines.push(
    zh
      ? "\n## 全部模型\n★ = 不点名时这家用的模型。下面每个对话模型都可以在 ask、vote、review 里点名。"
      : "\n## Every model\n★ = the one council picks for that provider when none is named. Every chat model below can be named in ask, vote and review.",
  )
  const api = { chat: "Chat", messages: "Messages", responses: "Responses" }
  for (const [p, ms] of groups) {
    lines.push(`\n### ${p} (${ms.length})`)
    for (const m of ms) {
      const caps = []
      if (m.group) caps.push(zh ? "路由组" : "routing group")
      if (m.imageOut) caps.push(zh ? "出图模型 → 用 magpie 自带的 generate_image" : "makes images → magpie's generate_image")
      else if (!m.chat) caps.push(zh ? "不是对话模型" : "not a chat model")
      else caps.push(api[m.protocol])
      if (m.reasoning) caps.push(`${zh ? "推理" : "reasoning"} ${m.levels.filter((l) => l !== "none").join("/")}`)
      if (m.vision) caps.push(zh ? "看图" : "images")
      if (m.context) caps.push(`${fmtCtx(m.context)} ${zh ? "上下文" : "context"}`)
      if (m.price) caps.push(`$${+(m.price * 1e6).toFixed(2)}/M`)
      const st = health.state(m)
      const state = excluded(o, m) ? (zh ? " · 已设为不用（exclude）" : " · excluded") : st.s === "ok" ? ` ✓ ${W.secs(st.ms)}` : st.s === "held" ? ` ✗ ${W.reason(st.kind)}` : st.s === "slow" ? (zh ? " · 最近较慢" : " · slow lately") : ""
      lines.push(`- ${star.has(m.id) ? "★ " : ""}${m.id} — ${caps.join(", ")}${state}`)
    }
  }
  return lines.join("\n")
}
