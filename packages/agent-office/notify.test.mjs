import { expect, test } from "bun:test"
import { card, createNotifier, createRouter } from "./lib/notify.mjs"

const T0 = 1793196000000

const alert = (extra = {}) => ({
  type: "waiting", sub: "approval", agent: "codex", session: "019a-x", project: "blog",
  cwd: "/Users/me/blog", model: "gpt-6.1", turns: 3, step: "shell · rm -rf dist",
  reply: "Deploy this?", error: "", resume: "cd /Users/me/blog && codex resume 019a-x",
  since: 2 * 60e3, at: T0, now: T0, ...extra,
})

// ---- a card --------------------------------------------------------------

test("a card says who waits and why, and keeps a tool step to its name", () => {
  const c = card(alert(), "zh", false)
  expect(c).toContain("⏸ Codex 等你批准")
  expect(c).toContain("项目：blog")
  expect(c).toContain("动作：shell")
  expect(c).toContain("已等 2 分钟")
  expect(c).toContain("会话 019a-x")
  expect(c).not.toContain("rm -rf")
  expect(c).not.toContain("Deploy this?")
  expect(c).not.toContain("codex resume")
})

test("with the text asked for, a card carries the command, the words and the resume", () => {
  const c = card(alert(), "zh", true)
  expect(c).toContain("shell · rm -rf dist")
  expect(c).toContain("它说：Deploy this?")
  expect(c).toContain("续接：`cd /Users/me/blog && codex resume 019a-x`")
})

test("every card has its own words, in Chinese and in English", () => {
  expect(card(alert({ type: "done", since: 5 * 60e3 }), "zh", false)).toContain("✅ Codex 完成了一轮")
  expect(card(alert({ type: "error", error: "429: usage limit reached" }), "zh", false)).toContain("❌ Codex 出错了")
  expect(card(alert({ type: "stuck", since: 11 * 60e3 }), "zh", false)).toContain("⚠️ Codex 11 分钟没有动静")
  expect(card(alert({ type: "recover" }), "zh", false)).toContain("↩️ Codex 又动起来了")
  expect(card(alert({ sub: "ask", type: "waiting", reply: "Which?" }), "en", false)).toContain("❓ Codex asks you something")
  expect(card(alert(), "en", false)).toContain("⏸ Codex waits for your approval")
})

test("an error's words leave only when the text was asked for", () => {
  expect(card(alert({ type: "error", error: "SECRET-ERROR" }), "zh", false)).not.toContain("SECRET-ERROR")
  expect(card(alert({ type: "error", error: "SECRET-ERROR" }), "zh", true)).toContain("SECRET-ERROR")
})

test("a card never passes WeCom's 4096 bytes", () => {
  const big = card(alert({ project: "长".repeat(9000), step: "x".repeat(9000), reply: "话".repeat(9000) }), "zh", true)
  expect(Buffer.byteLength(big)).toBeLessThanOrEqual(4096)
})

// ---- the sending ----------------------------------------------------------

const ok = () => ({ ok: true, json: async () => ({ errcode: 0 }) })

function notifier(fetch, opts = {}) {
  return createNotifier({ webhook: "http://127.0.0.1:1/hook", every: 1e9, fetch, sleep: async () => {}, ...opts })
}

test("what piles up is merged into one card a send", async () => {
  const posts = []
  const n = notifier(async (url, init) => { posts.push(JSON.parse(init.body)); return ok() })
  n.push([alert({ session: "a" }), alert({ session: "b", agent: "claude" }), alert({ session: "c", type: "error" })])
  await n.flush()
  expect(posts.length).toBe(1)
  expect(posts[0].msgtype).toBe("markdown")
  const text = posts[0].markdown.content
  expect(text).toContain("a")
  expect(text).toContain("Claude")
  expect(text).toContain("出错了")
  expect(n.pending()).toBe(0)
})

test("a send refused on its merits is not tried again", async () => {
  let calls = 0
  const n = notifier(async () => { calls++; return { ok: true, json: async () => ({ errcode: 400 }) } })
  n.push([alert()])
  await n.flush()
  expect(calls).toBe(1)
  expect(n.pending()).toBe(0)
})

test("the minute's limit is waited out and then gone on with", async () => {
  let calls = 0
  const n = notifier(async () => { calls++; return ok() })
  n.push([alert()])
  // a minute already full of sends holds the card
  for (let i = 0; i < 18; i++) n.stamps.push(Date.now() - 1000)
  await n.flush()
  expect(calls).toBe(0)
  expect(n.pending()).toBe(1)
  // a minute later the bucket fills again and the card goes
  n.stamps.splice(0, n.stamps.length, Date.now() - 61e3)
  await n.flush()
  expect(calls).toBe(1)
  expect(n.pending()).toBe(0)
})

test("the limit's own refusal, 45009, is retried and then lands", async () => {
  let calls = 0
  const n = notifier(async () => { calls++; return calls < 3 ? { ok: true, json: async () => ({ errcode: 45009 }) } : ok() })
  n.push([alert()])
  await n.flush()
  expect(calls).toBe(3)
  expect(n.pending()).toBe(0)
})

test("a flood beyond the queue's cap is said as a number, not lost silently", async () => {
  const posts = []
  const n = notifier(async (url, init) => { posts.push(JSON.parse(init.body)); return ok() })
  const flood = []
  for (let i = 0; i < 260; i++) flood.push(alert({ session: String(i) }))
  n.push(flood)
  await n.flush()
  const all = posts.map((p) => p.markdown.content).join("")
  expect(all).toContain("另有 60 条")
  expect(n.pending()).toBe(0)
}, 20000)

// ---- many bots, one team ---------------------------------------------------

test("a router sends each person's card on that person's own bot", async () => {
  const posts = []
  const r = createRouter({
    defaultWebhook: "http://default/hook",
    fetch: async (url, init) => { posts.push([url, JSON.parse(init.body)]); return ok() },
    sleep: async () => {},
  })
  r.push([
    alert({ webhook: "http://xm/hook", agent: "codex", session: "x1" }),   // 小明's own bot
    alert({ webhook: "", agent: "gemini", session: "g1" }),                // no person: default bot
  ])
  await r.flush()
  expect(r.targets().sort()).toEqual(["http://default/hook", "http://xm/hook"])
  const byUrl = Object.fromEntries(posts.map(([u, b]) => [u, b.markdown.content]))
  expect(byUrl["http://xm/hook"]).toContain("Codex")
  expect(byUrl["http://default/hook"]).toContain("Gemini")
  expect(r.pending()).toBe(0)
  r.stop()
  expect(r.targets()).toEqual([])
})

test("an alert with nowhere to go is held back, not half-sent", () => {
  const posts = []
  const r = createRouter({ fetch: async (url, init) => { posts.push(url); return ok() }, sleep: async () => {} })
  r.push([alert({ webhook: "" })])
  expect(r.targets()).toEqual([])
  expect(posts).toEqual([])
  r.stop()
})
