import { afterAll, beforeAll, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CouncilTools } from "./index.mjs"
import { classify } from "./lib/health.mjs"

// A stand-in for magpie's gateway: the catalog, the accounts' cards, recent
// requests, the three chat APIs and web search. No real sign-in is read.
const MODELS = [
  { id: "alpha/quick", owned_by: "alpha", native_endpoints: ["/v1/chat/completions"], pricing: { prompt: "0.0000001" }, modalities: { input: ["text", "image"], output: ["text"] }, reasoning: true, reasoning_levels: ["low", "high"], context_length: 128000 },
  { id: "alpha/strong", owned_by: "alpha", native_endpoints: ["/v1/chat/completions"], pricing: { prompt: "0.000005" }, modalities: { input: ["text"], output: ["text"] }, reasoning: true, reasoning_levels: ["low", "medium", "high", "max"], context_length: 200000 },
  { id: "beta/claude-like", owned_by: "claude", pricing: { prompt: "0.000003" }, modalities: { input: ["text", "image"], output: ["text"] }, reasoning: true, reasoning_levels: ["low", "medium", "high", "xhigh", "max"], context_length: 1000000 },
  { id: "gamma/resp", owned_by: "gamma", native_endpoints: ["/v1/responses"], pricing: { prompt: "0.000002" }, modalities: { input: ["text", "image"], output: ["text"] }, reasoning: true, reasoning_levels: ["low", "medium", "high", "xhigh", "max", "ultra"] },
  { id: "delta/msg", owned_by: "delta", native_endpoints: ["/v1/messages"], pricing: { prompt: "0.000001" }, modalities: { input: ["text"], output: ["text"] }, reasoning: false },
  { id: "delta/msg-mini", owned_by: "delta", native_endpoints: ["/v1/messages"], pricing: { prompt: "0.0000002" }, modalities: { input: ["text"], output: ["text"] } },
  { id: "dead/key", owned_by: "dead", native_endpoints: ["/v1/chat/completions"] },
  { id: "gone/acct", owned_by: "gone", native_endpoints: ["/v1/chat/completions"] },
  { id: "art/painter", owned_by: "art", modalities: { input: ["text"], output: ["text", "image"] } },
  { id: "group/mix", owned_by: "alpha" },
]

let calls = []
let behavior = {}
let server
let dir

const reply = (path, text) =>
  path === "/v1/messages"
    ? { content: [{ type: "thinking", thinking: "hm" }, { type: "text", text }] }
    : path === "/v1/responses"
      ? { error: null, output: [{ type: "reasoning" }, { type: "message", content: [{ type: "output_text", text }] }] }
      : { choices: [{ message: { content: text } }] }

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "council-"))
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const path = url.pathname
      if (path === "/v1/models") return Response.json({ data: MODELS })
      if (path === "/v1/magpie/quotas")
        return Response.json({
          data: [
            { provider: "gone", kind: "subscription", error: "Gone is not signed in; run `gone login`", windows: [] },
            { provider: "beta", kind: "subscription", windows: [{ name: "5 hours", remaining: 80 }] },
          ],
        })
      if (path === "/v1/magpie/usage/requests")
        return Response.json({
          rows: [
            { t: new Date().toISOString(), provider: "dead", model: "key", status: 401, err: "Dead: Invalid token", ms: 200 },
            { t: new Date().toISOString(), provider: "alpha", model: "quick", status: 200, ms: 900 },
          ],
        })
      if (path === "/mcp/magpie/web-search") return Response.json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "SEARCH RESULT: magpie 2026" }] } })
      const body = await req.json()
      calls.push({ path, body })
      const b = behavior[body.model]
      if (b) {
        const out = await b(body, req)
        if (out instanceof Response) return out
        if (out) return Response.json(out.json, { status: out.status })
      }
      const ballot = /second step of an anonymous vote|匿名投票的第二步/.test(JSON.stringify(body))
      return Response.json(reply(path, ballot ? '{"vote": "A", "reason": "clearest"}' : `answer from ${body.model}`))
    },
  })
  process.env.MAGPIE_ADDR = `127.0.0.1:${server.port}`
})

afterAll(() => server?.stop(true))

const tools = async (options = {}) => (await CouncilTools({ directory: dir }, { wait: 5, ...options })).tool
const ctx = (agent = "test") => ({ agent, abort: AbortSignal.timeout(50_000) })
const fresh = () => {
  calls = []
  behavior = {}
}
const callTo = (model) => calls.find((c) => c.body.model === model)
const hang = (_body, req) => new Promise((r) => req.signal.addEventListener("abort", () => r(new Response("", { status: 499 }))))

test("gives five tools, each with a description, JSON Schema args and an execute", async () => {
  const tool = await tools()
  expect(Object.keys(tool).sort()).toEqual(["ask", "models", "result", "review", "vote"])
  for (const [name, t] of Object.entries(tool)) {
    expect(name).toMatch(/^[A-Za-z0-9_-]{1,48}$/)
    expect(t.description.length).toBeGreaterThan(80)
    expect(t.args.type).toBe("object")
    expect(typeof t.execute).toBe("function")
  }
})

test("models starts with a check-up: who is ready, who isn't, why and how to fix it", async () => {
  fresh()
  const out = await (await tools()).models.execute({ lang: "en" }, ctx())
  expect(out).toContain("magpie has 10 models from 8 providers.\n- Ready (answered lately): alpha\n- Not checked yet (tried as usual, replaced by itself if they fail): beta, gamma, delta")
  expect(out).toContain("## To fix (2; once fixed, call council_models with refresh: true")
  expect(out).toContain("- gone: signed out or key invalid → sign in to it again on magpie's Providers page, or give it a working key (it says: `gone login`)")
  expect(out).toContain("- dead: signed out or key invalid →")
  expect(out).toContain("★ alpha/strong")
  expect(out).toContain("★ beta/claude-like")
  expect(out).toContain("art/painter — makes images")
  expect(out).toContain("reasoning low/medium/high/xhigh/max/ultra")
  expect(calls).toEqual([]) // knowing who is down cost no request
  const zh = await (await tools()).models.execute({ lang: "zh" }, ctx())
  expect(zh).toContain("- 能用（最近答过）：alpha")
  expect(zh).toContain("## 需要处理（2 家")
})

test("ask takes each working provider's strongest model, each on its own API, without max_tokens", async () => {
  fresh()
  const out = await (await tools()).ask.execute({ question: "Which is better?" }, ctx())
  expect(out).toContain("4 models answered.")
  for (const id of ["alpha/strong", "beta/claude-like", "gamma/resp", "delta/msg"]) expect(out).toContain(`answer from ${id}`)
  expect(callTo("alpha/strong").path).toBe("/v1/chat/completions")
  expect(callTo("beta/claude-like").path).toBe("/v1/messages") // owned by Claude, translated anyway
  expect(callTo("gamma/resp").path).toBe("/v1/responses")
  expect(callTo("delta/msg").path).toBe("/v1/messages")
  expect(calls.some((c) => c.body.model === "dead/key" || c.body.model === "gone/acct" || c.body.model === "art/painter")).toBe(false)
  expect(calls.every((c) => c.body.max_tokens === undefined && c.body.max_output_tokens === undefined)).toBe(true)
  expect(out).toContain("2 more providers are unavailable right now")
})

test("effort reaches each model as its nearest level, in its API's own field", async () => {
  fresh()
  await (await tools()).ask.execute({ question: "Think hard", effort: "max" }, ctx())
  expect(callTo("alpha/strong").body.reasoning_effort).toBe("max")
  expect(callTo("beta/claude-like").body.output_config).toEqual({ effort: "max" })
  expect(callTo("beta/claude-like").body.thinking).toEqual({ type: "adaptive" })
  expect(callTo("gamma/resp").body.reasoning).toEqual({ effort: "ultra" })
  expect(callTo("delta/msg").body.output_config).toBeUndefined() // it doesn't think
  fresh()
  await (await tools()).ask.execute({ question: "Middle", effort: "medium", models: ["alpha/quick", "gamma"] }, ctx())
  expect(callTo("alpha/quick").body.reasoning_effort).toBe("low") // low and high only: the lower on a tie
  expect(callTo("gamma/resp").body.reasoning).toEqual({ effort: "medium" })
})

test("a vendor that refuses the reasoning field is asked again without it", async () => {
  fresh()
  behavior["alpha/strong"] = (body) => (body.reasoning_effort ? { status: 400, json: { error: { message: "Unknown parameter: reasoning_effort" } } } : null)
  const out = await (await tools()).ask.execute({ question: "x", effort: "high", models: ["alpha/strong"] }, ctx())
  expect(out).toContain("answer from alpha/strong")
  expect(calls.filter((c) => c.body.model === "alpha/strong").length).toBe(2)
})

test("images go only to models that see them, in each API's own form; a PDF gets a note", async () => {
  fresh()
  const png = join(dir, "dot.png")
  writeFileSync(png, Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108020000009077" + "53de0000000c4944415408d763f8cfc000000301010018dd8db40000000049454e44ae426082", "hex"))
  const pdf = join(dir, "doc.pdf")
  writeFileSync(pdf, "%PDF-1.4\n%%EOF\n")
  const out = await (await tools()).ask.execute({ question: "What colour?", files: [png, pdf] }, ctx())
  expect(out).toContain("doc.pdf is a PDF")
  const asked = calls.map((c) => c.body.model).sort()
  expect(asked).toEqual(["alpha/quick", "beta/claude-like", "gamma/resp"])
  expect(callTo("alpha/quick").body.messages[0].content[1].image_url.url).toStartWith("data:image/png;base64,")
  expect(callTo("beta/claude-like").body.messages[0].content[0].source.media_type).toBe("image/png")
  expect(callTo("gamma/resp").body.input[0].content[1].type).toBe("input_image")
})

test("a pick that fails is replaced by a stand-in, and the failure is remembered across restarts", async () => {
  fresh()
  behavior["alpha/strong"] = () => ({ status: 500, json: { error: { message: "upstream exploded" } } })
  const out = await (await tools()).ask.execute({ question: "Again" }, ctx())
  expect(out).toContain("answer from alpha/quick")
  expect(out).toContain("4 models answered.")
  expect(out).toMatch(/Didn't answer: alpha\/strong（failed）/)
  await Bun.sleep(1700) // the debounced save
  const saved = JSON.parse(readFileSync(join(dir, "council-health.json"), "utf8"))
  expect(saved.entries["alpha/strong"].kind).toBe("other")
})

test("a slow pick gets a stand-in beside it, and the answer doesn't wait for it", async () => {
  fresh()
  behavior["delta/msg"] = hang
  const t0 = Date.now()
  const out = await (await tools({ graceMs: 2000 })).ask.execute({ question: "Who is slow?" }, ctx())
  expect(Date.now() - t0).toBeLessThan(1500) // the stand-in goes at graceMs / 4, not at graceMs
  expect(out).toContain("4 models answered.")
  expect(out).toMatch(/answer from (delta\/msg-mini|alpha\/quick)/)
  expect(out).toMatch(/Didn't answer: delta\/msg（too slow）/)
})

test("a model of its own refusing (429) is stood in for by its own provider first", async () => {
  fresh()
  behavior["delta/msg"] = () => ({ status: 429, json: { error: { message: "Rate limit reached for msg." } } })
  const out = await (await tools()).ask.execute({ question: "Credits?" }, ctx())
  expect(out).toContain("answer from delta/msg-mini")
  expect(out).toMatch(/Didn't answer: delta\/msg（out of allowance）/)
  // one stand-in, and it is delta's own: nothing else was asked beyond the four picks
  expect(calls.length).toBe(5)
})

test("an answer still coming is handed back later through result", async () => {
  fresh()
  behavior["gamma/resp"] = async () => {
    await Bun.sleep(1500)
    return null
  }
  const tool = await tools({ wait: 1 })
  const first = await tool.ask.execute({ question: "Slow one", models: ["gamma/resp", "delta/msg"] }, ctx())
  expect(first).toContain("answer from delta/msg")
  const id = first.match(/id: (ask-[a-z0-9]+)/)?.[1]
  expect(id).toBeTruthy()
  expect(first).toContain("Still thinking: gamma/resp")
  const rest = await tool.result.execute({ id }, ctx())
  expect(rest).toContain("answer from gamma/resp")
  expect(rest).toContain("2 models answered.")
  expect(await tool.result.execute({ id: "ask-nope" }, ctx())).toContain("No such task")
})

test("a model that only keeps the line open is let go once the others are in", async () => {
  fresh()
  behavior["delta/msg"] = hang
  const own = mkdtempSync(join(tmpdir(), "council-hang-")) // nothing remembered from the tests before
  const tool = (await CouncilTools({ directory: own }, { wait: 5, graceMs: 300 })).tool
  const out = await tool.ask.execute({ question: "Who hangs?", models: ["alpha/quick", "delta/msg"] }, ctx())
  expect(out).toContain("answer from alpha/quick")
  expect(out).toMatch(/Didn't answer: delta\/msg（too slow）/)
})

test("vote collects proposals blind, tallies the ballots and names the authors", async () => {
  fresh()
  const out = await (await tools()).vote.execute({ question: "Pick a name" }, ctx())
  expect(out).toMatch(/^Winner: proposal A \(4 votes, by [a-z]+\/[a-z-]+\)\./)
  expect(out).toContain("## All proposals")
  const ballots = calls.filter((c) => /second step/.test(JSON.stringify(c.body)))
  expect(ballots.length).toBe(4)
  for (const b of ballots) {
    const shown = JSON.stringify(b.body.messages ?? b.body.input)
    expect(shown).toContain("### Proposal D")
    expect(shown).not.toMatch(/### Proposal [A-Z] ·/) // no author beside a proposal
  }
})

test("review takes a provider other than the calling agent's", async () => {
  fresh()
  const out = await (await tools()).review.execute({ content: "function f(){}", goal: "do nothing" }, ctx("alpha"))
  expect(calls.map((c) => c.body.model)).toEqual(["beta/claude-like"])
  expect(callTo("beta/claude-like").body.system).toContain("strict reviewer")
  expect(callTo("beta/claude-like").body.output_config).toEqual({ effort: "high" })
  expect(out).toContain("Review (claude-like)")
})

test("names that can't be used become notes, never errors", async () => {
  fresh()
  const out = await (await tools()).ask.execute({ question: "x", models: ["nope/none", "gone/acct", "art/painter"] }, ctx())
  expect(out).toContain('magpie has no "nope/none"')
  expect(out).toContain("gone/acct can't be used right now (signed out or key invalid)")
  expect(out).toContain("art/painter makes images")
  expect(out).toContain("picked automatically instead")
  expect(out).toContain("answer from beta/claude-like")
})

test("a Chinese question gets Chinese around the answers, and web results reach every model", async () => {
  fresh()
  const out = await (await tools()).ask.execute({ question: "哪个更好？", web: true, models: ["delta/msg"] }, ctx())
  expect(out).toContain("1 个模型回答了。")
  expect(JSON.stringify(callTo("delta/msg").body)).toContain("SEARCH RESULT: magpie 2026")
})

test("failures are told apart: account, allowance, busy, filtered, unreachable", () => {
  expect(classify(401, "")).toBe("account")
  expect(classify(0, "Grok is not signed in; run `grok login`")).toBe("account")
  expect(classify(502, "This client is no longer supported for Gemini Code Assist")).toBe("account")
  expect(classify(429, "Fable 5.1 requires usage credits.")).toBe("plan")
  expect(classify(429, "Rate limit reached, try again in 20s")).toBe("quota")
  expect(classify(503, "imported: Service temporarily unavailable")).toBe("busy")
  expect(classify(529, "Overloaded")).toBe("busy")
  expect(classify(400, "Output blocked by content filtering policy")).toBe("refused")
  expect(classify(400, "prompt is too long: 300000 tokens > 200000 maximum")).toBe("toolong")
  expect(classify(0, 'Post "http://127.0.0.1:8000/v1/chat/completions": dial tcp 127.0.0.1:8000: connect: connection refused')).toBe("unreachable")
  expect(classify(404, "model not found")).toBe("model")
})

test("a refusal by a content filter is stood in for, and holds nothing against the model", async () => {
  fresh()
  behavior["beta/claude-like"] = () => ({ status: 400, json: { error: { message: "Output blocked by content filtering policy" } } })
  const out = await (await tools()).ask.execute({ question: "Something touchy" }, ctx())
  expect(out).toMatch(/Didn't answer: beta\/claude-like（refused by a content filter）/)
  expect(out).toContain("4 models answered.")
  fresh()
  await (await tools()).ask.execute({ question: "Something plain" }, ctx())
  expect(callTo("beta/claude-like")).toBeTruthy() // still picked
})

test("when nothing can be used, it says what to fix for each provider", async () => {
  fresh()
  for (const m of MODELS) behavior[m.id] = () => ({ status: 401, json: { error: { message: `${m.id.split("/")[0]}: Invalid API key` } } })
  const alone = mkdtempSync(join(tmpdir(), "council-down-"))
  const tool = (await CouncilTools({ directory: alone }, { wait: 5 })).tool
  await tool.ask.execute({ question: "First try" }, ctx()) // learns that every account is down
  const out = await tool.ask.execute({ question: "Second try" }, ctx())
  expect(out).toStartWith("No model can be used right now. Fixing any one of these is enough:")
  expect(out).toContain("- alpha: signed out or key invalid → sign in to it again on magpie's Providers page")
  expect(out).toContain("- gone: signed out or key invalid →")
})

test("short names and auto together: sonnet-like on top of the usual picks", async () => {
  fresh()
  const out = await (await tools()).vote.execute({ question: "Pick", models: ["auto", "msg-mini"] }, ctx())
  const voters = [...new Set(calls.filter((c) => /second step/.test(JSON.stringify(c.body))).map((c) => c.body.model))]
  expect(voters).toContain("delta/msg-mini")
  expect(voters.length).toBe(5) // the named one plus the usual four
  expect(out).toContain("## All proposals")
  // and a pick that fails beside a named one still gets a stand-in
  fresh()
  behavior["beta/claude-like"] = () => ({ status: 500, json: { error: { message: "upstream exploded" } } })
  const own = (await CouncilTools({ directory: mkdtempSync(join(tmpdir(), "council-auto-")) }, { wait: 5 })).tool
  const again = await own.ask.execute({ question: "Again", models: ["auto", "msg-mini"] }, ctx())
  expect(again).toContain("5 models answered.")
})

test("exclude keeps a provider or a kind of model out of everything, the check-up too", async () => {
  fresh()
  const tool = await tools({ exclude: ["gamma", "msg-mini", "gone"] })
  await tool.ask.execute({ question: "Who?" }, ctx())
  const asked = calls.map((c) => c.body.model)
  expect(asked).not.toContain("gamma/resp")
  expect(asked).not.toContain("delta/msg-mini")
  const page = await tool.models.execute({ lang: "en" }, ctx())
  expect(page).not.toContain("- gone:")
  expect(page).toContain("gamma/resp — Responses")
  expect(page).toMatch(/gamma\/resp — .* · excluded/)
})

test("a vote still going hands back an id, and result gets the outcome", async () => {
  fresh()
  behavior["gamma/resp"] = async () => {
    await Bun.sleep(1500)
    return null
  }
  const tool = await tools({ wait: 1 })
  const first = await tool.vote.execute({ question: "Slow vote", models: ["gamma/resp", "delta/msg"] }, ctx())
  const id = first.match(/id: (vote-[a-z0-9]+)/)?.[1]
  expect(id).toBeTruthy()
  let rest = ""
  for (let i = 0; i < 4 && !/Winner|Tie/.test(rest); i++) rest = await tool.result.execute({ id }, ctx())
  expect(rest).toMatch(/Winner|Tie/)
})

test("choose shows the models to pick from first, and asks nobody", async () => {
  fresh()
  const menu = await (await tools()).vote.execute({ question: "Pick a name", choose: true }, ctx())
  expect(menu).toStartWith("Choose the models first:")
  expect(menu).toContain("call council_vote again with models")
  expect(menu).toMatch(/- ★ beta\/claude-like — reasoning up to max, images/)
  expect(menu).toContain("delta/msg-mini")
  expect(menu).not.toContain("gone/acct") // can't be used now
  expect(calls).toEqual([])
  const zh = await (await tools()).ask.execute({ question: "选哪个？", choose: true }, ctx())
  expect(zh).toStartWith("先选模型：")
})

test("with the option confirm, every call that names no models shows the menu first", async () => {
  fresh()
  const tool = await tools({ confirm: true })
  expect(await tool.ask.execute({ question: "Who?" }, ctx())).toStartWith("Choose the models first:")
  expect(calls).toEqual([])
  const out = await tool.ask.execute({ question: "Who?", models: ["delta/msg", "beta"] }, ctx())
  expect(out).toContain("answer from delta/msg")
  expect(out).toContain("answer from beta/claude-like")
  expect(calls.length).toBe(2)
})

test("a routing group named council, made in magpie, is what is asked when no models are named", async () => {
  fresh()
  const own = mkdtempSync(join(tmpdir(), "council-groups-"))
  writeFileSync(
    join(own, "providers.json"),
    JSON.stringify({
      providers: [{ id: "alpha", key: "sk-SECRET-should-never-show" }],
      groups: [
        { id: "council", name: "Council", members: ["delta/msg", "gamma/resp:low", "nope/none"], routing: "order" },
        { id: "fast-pair", name: "快组", members: ["alpha/quick", "delta/msg-mini"], routing: "order" },
      ],
    }),
  )
  const tool = (await CouncilTools({ directory: own }, { wait: 5 })).tool
  const out = await tool.ask.execute({ question: "Who?" }, ctx())
  expect(calls.map((c) => c.body.model).sort()).toEqual(["delta/msg", "gamma/resp"])
  expect(callTo("gamma/resp").body.reasoning).toEqual({ effort: "low" }) // the level fixed on the member
  expect(out).toContain('magpie has no "nope/none"')
  fresh()
  await tool.ask.execute({ question: "Who?", models: ["快组"] }, ctx())
  expect(calls.map((c) => c.body.model).sort()).toEqual(["alpha/quick", "delta/msg-mini"])
  const page = await tool.models.execute({ lang: "en" }, ctx())
  expect(page).toContain('council asks the 3 models of magpie\'s routing group "Council"')
  expect(page + out).not.toContain("SECRET")
})

test("a missing question is said plainly", async () => {
  await expect((await tools()).ask.execute({}, ctx())).rejects.toThrow("question is required")
  expect(existsSync(dir)).toBe(true)
})
