import { expect, test } from "bun:test"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

// Model-level tests for the workbench features: groups, filters, Today,
// no-progress, transcript redaction and the nine languages. The DOM parts
// are checked for their hooks; the model is loaded exactly as the page does.
const dir = import.meta.dir
const page = join(dir, "page")
const read = (f) => readFileSync(join(page, f), "utf8")
const scope = {}
new Function("globalThis", read("agents.js"))(scope)
new Function("globalThis", read("model.js"))(scope)
const M = scope.AgentOfficeModel

const now = 10_000_000
const S = (phase, extra = {}) => ({
  key: "claude|x", source: "files", agent: "claude", session: "x", phase, touched: now, updated: now, ...extra,
})

test("nine languages, one key set, and every label the page asks for", () => {
  expect(M.LANGS).toEqual(["en", "zh-CN", "zh-TW", "ja", "ko", "es", "fr", "de", "pt"])
  const en = Object.keys(M.TEXT.en).sort()
  for (const code of M.LANGS) {
    expect(Object.keys(M.TEXT[code]).sort()).toEqual(en)
    for (const key of en) {
      expect(typeof M.TEXT[code][key]).toBe("string")
      expect(M.TEXT[code][key].length).toBeGreaterThan(0)
    }
    // the group headings the workbench draws exist in every language
    for (const group of ["needYou", "working", "finished"]) expect(M.TEXT[code][group]).toBeTruthy()
  }
  // zh stays an alias of zh-CN for the older page/tests
  expect(M.TEXT.zh).toBe(M.TEXT["zh-CN"])
  expect(M.text("zh-CN").title).toBe("我的 Agent 在干嘛")
  expect(M.text("zh-Hant").title).toBe(M.TEXT["zh-TW"].title)
  expect(M.text("pt-BR").settings).toBe(M.TEXT.pt.settings)
  expect(M.text("xx").settings).toBe(M.TEXT.en.settings)
  // every data-t the page carries is translated in every language
  const html = read("index.html")
  const keys = [...html.matchAll(/data-t="([^"]+)"/g)].map((m) => m[1])
  expect(keys.length).toBeGreaterThan(20)
  for (const code of M.LANGS) for (const key of keys) expect(M.TEXT[code][key]).toBeDefined()
})

test("the language follows the prompt, the theme, the browser, then English", () => {
  expect(M.normalizeLang("zh-HK")).toBe("zh-TW")
  expect(M.normalizeLang("zh-Hans")).toBe("zh-CN")
  expect(M.normalizeLang("pt-BR")).toBe("pt")
  expect(M.normalizeLang("xx-YY")).toBe("")
  // a manual pick wins over everything
  expect(M.detectLang({ manual: "ja", sample: "请修一下", theme: "en" })).toBe("ja")
  // a CJK prompt is the strongest automatic hint
  expect(M.detectLang({ manual: "auto", sample: "请帮我修一下这个 bug", theme: "en", nav: ["en-US"] })).toBe("zh-CN")
  expect(M.detectLang({ sample: "これはテストです" })).toBe("ja")
  expect(M.detectLang({ sample: "이 버그를 고쳐줘" })).toBe("ko")
  expect(M.detectLang({ sample: "這是傳統中文的問題" })).toBe("zh-TW")
  // a Latin prompt says nothing: the theme, then the browser, decide
  expect(M.detectLang({ sample: "fix the bug", theme: "de", nav: ["fr-FR"] })).toBe("de")
  expect(M.detectLang({ nav: ["fr-CA"] })).toBe("fr")
  expect(M.detectLang({})).toBe("en")
  // the newest prompt is the sample
  expect(M.sample({ sessions: [{ updated: 1, query: "old" }, { updated: 9, title: "新しい" }, { updated: 5, query: "" }] })).toBe("新しい")
  expect(M.sample(null)).toBe("")
})

test("the workbench groups into Needs you, Working and Finished", () => {
  const list = M.agents(M.demo(now), now)
  const groups = M.groups(list)
  expect(groups.map((g) => g.key)).toEqual(["needYou", "working", "finished"])
  expect(groups.reduce((n, g) => n + g.list.length, 0)).toBe(list.length)
  expect(groups[0].list.every((a) => a.status === "waiting" || a.status === "error")).toBe(true)
  expect(groups[1].list.every((a) => a.status === "thinking" || a.status === "executing" || a.status === "replying")).toBe(true)
  expect(groups[2].list.every((a) => a.status === "done")).toBe(true)
  // newest first within a group
  for (const g of groups) {
    for (let i = 1; i < g.list.length; i++) expect(g.list[i - 1].at).toBeGreaterThanOrEqual(g.list[i].at)
  }
})

test("agent mix, subagent and idle filters are applied in the model", () => {
  const snap = { sessions: [
    S("tool", { key: "a", agent: "claude", project: "p1", touched: now - 1000 }),
    S("tool", { key: "b", agent: "codex", project: "p2", touched: now - 2000 }),
    S("done", { key: "c", agent: "claude", project: "p1", touched: now - 30 * 60e3, updated: now - 30 * 60e3 }),
    S("tool", { key: "d", agent: "claude", project: "p3", touched: now - 1000, subagent: true, parent: "a" }),
  ] }
  const ids = (opts) => M.agents(snap, now, { progress: true, ...opts }).map((a) => a.key)
  expect(ids({}).sort()).toEqual(["a", "b", "c", "d"])
  expect(ids({ agents: ["codex"] })).toEqual(["b"])
  expect(ids({ agents: [] }).length).toBe(4) // none selected means all
  expect(ids({ showSub: false })).toEqual(["a", "b", "c"])
  expect(ids({ showIdle: false })).toEqual(["a", "b", "d"])
  const c = M.agents(snap, now, { progress: true }).find((a) => a.key === "c")
  expect(c.idle).toBe(true)
  expect(c.subagent).toBe(false)
  expect(M.agents(snap, now, { progress: true }).find((a) => a.key === "d").subagent).toBe(true)
})

test("no progress keeps a stalled turn in Working, with a badge", () => {
  const thinking = S("thinking", { key: "t", touched: now - 9 * 60e3, updated: now - 9 * 60e3 })
  const tool = S("tool", { key: "u", touched: now - 11 * 60e3, updated: now - 11 * 60e3 })
  expect(M.state(thinking, now, { progress: true })).toEqual({ status: "thinking", sub: "noprog" })
  expect(M.state(tool, now, { progress: true })).toEqual({ status: "executing", sub: "stuck" })
  const list = M.agents({ sessions: [thinking, tool] }, now, { progress: true })
  expect(M.counts(list)).toEqual({ needYou: 0, working: 2, done: 0 })
  expect(M.groups(list).map((g) => [g.key, g.list.length])).toEqual([["needYou", 0], ["working", 2], ["finished", 0]])
  expect(list.every((a) => a.noProgress)).toBe(true)
  // the thresholds are 8 min for thinking and 10 min for a tool
  expect(M.state(S("thinking", { touched: now - 7 * 60e3 }), now, { progress: true })).toEqual({ status: "thinking", sub: "" })
  expect(M.state(S("tool", { touched: now - 9 * 60e3 }), now, { progress: true })).toEqual({ status: "executing", sub: "" })
  // the older, un-opted reading is unchanged for callers that still use it
  expect(M.state(tool, now)).toEqual({ status: "error", sub: "stuck" })
  expect(M.state(S("thinking", { touched: now - 11 * 60e3 }), now)).toEqual({ status: "error", sub: "stuck" })
})

test("Today totals turns and tokens by agent and folder, and reads context", () => {
  const snap = { sessions: [
    S("tool", { key: "a", agent: "claude", project: "blog", touched: now - 1000, turnsToday: 2, tokensToday: 1200, context: 50000, contextWindow: 200000 }),
    S("tool", { key: "b", agent: "claude", project: "blog", touched: now - 1000, turnsToday: 1, tokensToday: 800, context: 120000, contextWindow: 200000 }),
    S("tool", { key: "c", agent: "codex", project: "app", touched: now - 1000, turnsToday: 2, tokensToday: 40000, context: 170000, contextWindow: 200000 }),
    S("tool", { key: "d", agent: "gemini", project: "app", touched: now - 1000 }), // no usage fields
  ] }
  const list = M.agents(snap, now, { progress: true })
  const a = list.find((x) => x.key === "a")
  expect(a).toMatchObject({ turnsToday: 2, tokensToday: 1200, context: 50000, contextWindow: 200000 })
  expect(a.ctx).toEqual({ used: 50000, window: 200000, pct: 25, level: "ok" })

  const day = M.today(list)
  expect(day.hasUsage).toBe(true)
  expect(day.turns).toBe(5)
  expect(day.tokens).toBe(42000)
  expect(day.agentCount).toBe(2)
  expect(day.byAgent.claude).toEqual({ agent: "claude", name: "Claude Code", turns: 3, tokens: 2000 })
  expect(day.byAgent.codex).toMatchObject({ turns: 2, tokens: 40000 })
  expect(day.projects.map((p) => p.project)).toEqual(["blog", "app"])
  expect(day.projects[0]).toEqual({ project: "blog", turns: 3, tokens: 2000 })
  // context bars: 85% is full, 60% warns, below is fine
  expect(day.contexts.map((c) => c.pct)).toEqual([85, 60, 25])
  expect(day.contexts.map((c) => c.level)).toEqual(["full", "warn", "ok"])

  // context may arrive as {used, window} and contextWindow is the override
  expect(M.context({ context: { used: 7000, window: 10000 } })).toMatchObject({ pct: 70, level: "warn" })
  expect(M.context({ context: { used: 1, window: 10 }, contextWindow: 10000 })).toMatchObject({ used: 1, window: 10000, pct: 0 })

  expect(M.fmtTokens(999)).toBe("999")
  expect(M.fmtTokens(1234)).toBe("1.2k")
  expect(M.fmtTokens(42000)).toBe("42k")
  expect(M.fmtTokens(2_500_000)).toBe("2.50M")

  // no usage anywhere is shown as such, not as zeroes pretending to be data
  expect(M.today([])).toEqual({ hasUsage: false, turns: 0, tokens: 0, agentCount: 0, byAgent: {}, projects: [], contexts: [] })
  const bare = M.agents({ sessions: [S("tool", { key: "e", agent: "gemini", turnsToday: 0, tokensToday: 0, context: 0, contextWindow: 0 })] }, now, { progress: true })
  expect(M.today(bare).hasUsage).toBe(false)
  expect(M.today(bare).contexts).toEqual([])
})

test("resume commands cover the newer readers and their extra fields", () => {
  expect(M.resume({ agent: "copilot", session: "c1", cwd: "/x" })).toBe("cd /x && copilot --resume c1")
  expect(M.resume({ agent: "kimi", session: "k1", cwd: "/x" })).toBe("cd /x && kimi --session k1")
  expect(M.resume({ agent: "grok", session: "g1", cwd: "/x" })).toBe("cd /x && grok --resume g1")
  expect(M.resume({ agent: "omp", session: "o1", cwd: "/x" })).toBe("cd /x && omp --resume o1")
  // a reader that knows the agent's own syntax wins
  expect(M.resume({ agent: "omp", session: "o1", cwd: "/x", resumeCommand: "omp profile resume o1" })).toBe("omp profile resume o1")
  const [a] = M.agents({ sessions: [{ ...S("tool", { key: "s" }), subagent: true, parent: "p", profile: "work", messages: [{ role: "tool", text: "Bash", name: "Bash", at: now }] }] }, now, { progress: true })
  expect(a).toMatchObject({ subagent: true, parent: "p", profile: "work" })
  expect(a.messages).toHaveLength(1)
})

test("conversations are redacted with the rest of the text", () => {
  const secret = {
    key: "claude|x", agent: "claude", brand: { name: "Claude Code" }, project: "safe", title: "SAFE",
    query: "SECRET-QUERY", reply: "SECRET-REPLY", error: "SECRET-ERROR", step: "Bash · SECRET-CMD",
    messages: [{ role: "user", text: "SECRET-MESSAGE", at: now }],
  }
  const [r] = M.redact([secret])
  expect(r.messages).toEqual([])
  expect(r.private).toBe(true)
  expect(r).toMatchObject({ title: "safe", query: "", reply: "", error: "", step: "Bash" })
  // a plain tool name may survive; an argument may not
  expect(M.redact([{ ...secret, step: "Bash" }])[0].step).toBe("Bash")
  expect(M.redact([{ ...secret, step: "SECRET-CMD curl x" }])[0].step).toBe("")
})

test("the page carries the workbench hooks and still reaches no network", () => {
  const html = read("index.html")
  const app = read("app.js")
  for (const id of ["toasts", "rail", "railGroups", "todayMenu", "todayTokens", "todayBtn", "sideBtn", "optAgents", "optLang", "optSub", "optIdle"]) {
    expect(html).toContain(`id="${id}"`)
  }
  for (const token of ["M.groups", "M.today", "M.detectLang", "M.redact", "showToast", "document.title"]) expect(app).toContain(token)
  // desktop notifications are unavailable in magpie's allow="" frame: never called
  expect(app).not.toMatch(/Notification|requestPermission/)
  expect(app).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource|importScripts|new Worker/)
  expect(app).not.toContain("navigator.clipboard")
  // the page serves only its own files
  for (const f of readdirSync(page).filter((f) => f.endsWith(".js") && f !== "live.js")) expect(read(f)).toBeTruthy()
})
