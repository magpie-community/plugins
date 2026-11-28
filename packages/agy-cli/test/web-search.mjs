// magpie's web search through agy's own search_web (Kayphoon, magpie#7632):
// a session of an agent whose one tool is search_web, the pages read from
// the step output agy keeps, the turn cancelled once the search is done.
// search-web-output.txt is a real agy 1.5.17 step output, as it was written.
//
// bun test ./web-search.mjs

import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { createBridgeKit } from "./testkit.mjs"

const OUTPUT = fs.readFileSync(new URL("./search-web-output.txt", import.meta.url), "utf8")
const OFFERED = [
  ["gemini-4-neon-high", "Gemini 4 Neon (High)"],
  ["gemini-3.8-flash-high", "Gemini 3.8 Flash (High)"],
  ["gemini-3.8-flash-low", "Gemini 3.8 Flash (Low)"],
]

async function withKit(fn, options = {}) {
  const kit = await createBridgeKit({ initialAgyModel: "gemini-4-neon-high", offeredModels: OFFERED, ...options })
  try { return await fn(kit) } finally { await kit.dispose() }
}

// where the agy a spawn ran keeps a session's steps
function stepsOf(spawn, sessionId) {
  const i = spawn.args.indexOf("--gemini-dir")
  const base = i >= 0 ? path.join(spawn.args[i + 1], "antigravity-cli") : path.join(spawn.env.HOME, ".gemini", "antigravity-cli")
  return path.join(base, "brain", sessionId, ".system_generated", "steps")
}

// agy's search: the call, its output on disk, the call done; then the turn
// waits, as agy's model would go on to answer, until it is cancelled
function searches(kit, output = OUTPUT, seen = {}) {
  kit.defaultPrompt = async (agent) => {
    const spawn = kit.acpSpawns.at(-1)
    seen.agent = fs.readFileSync(path.join(spawn.cwd, ".agents", "agents", "magpie-web-search", "agent.md"), "utf8")
    seen.home = spawn.env.HOME
    agent.update({ sessionUpdate: "tool_call", toolCallId: "c1", name: "search_web", args: { query: "q" }, status: "in_progress", kind: "search" })
    const dir = path.join(stepsOf(spawn, agent.sessionId), "2")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "output.txt"), output)
    agent.update({ sessionUpdate: "tool_call_update", toolCallId: "c1", name: "search_web", status: "completed", kind: "search" })
    await agent.waitCancel()
    return { stopReason: "cancelled" }
  }
  return seen
}

test("the plugin gives magpie a web search that signs in as agy-cli", async () => {
  await withKit(async (kit) => {
    const def = kit.plugin.search?.agy
    assert.equal(def?.auth, "agy-cli")
    assert.equal(typeof def?.execute, "function")
  })
})

test("a search is agy's search_web, its pages read from the step output", async () => {
  await withKit(async (kit) => {
    const seen = searches(kit)
    const pages = await kit.plugin.search.agy.execute({ query: "opencode plugin hooks", count: 3 }, {})
    assert.deepEqual(pages.map((p) => p.title), ["boot.dev", "symposium.dev", "open-code.ai"])
    for (const p of pages) {
      assert.match(p.url, /^https:\/\/vertexaisearch\.cloud\.google\.com\/grounding-api-redirect\//)
      assert.ok(p.text, `${p.title} has no text`)
      assert.doesNotMatch(p.text, /\[\d+\]/)
    }
    // open-code.ai is cited once, on the line about Plugin definitions; boot.dev
    // has its own lines, not every line of a summary citing many
    assert.match(pages[2].text, /Plugin definitions/)
    assert.doesNotMatch(pages[0].text, /Plugin definitions/)
    // the one tool, asked for the query as it is, planned on the lightest Flash
    assert.match(seen.agent, /^tools: \[search_web\]$/m)
    assert.match(seen.agent, /^inheritMcp: false$/m)
    const spawn = kit.acpSpawns.at(-1)
    assert.deepEqual(spawn.args.slice(0, 3), ["acp", "--agent", "magpie-web-search"])
    assert.ok(!spawn.args.includes("--dangerously-skip-permissions"))
    assert.deepEqual(kit.setModels, ["gemini-3.8-flash-low"])
    const prompt = kit.acpLog.find((e) => e.method === "session/prompt")
    assert.equal(prompt.params.prompt[0].text, "search_web: opencode plugin hooks")
    // the model writes no answer: the turn is cancelled once the search is in
    assert.ok(kit.acpLog.some((e) => e.method === "session/cancel"))
    // the agy is gone, and its folder
    assert.ok(spawn.child.closed || spawn.child.killed)
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(fs.existsSync(spawn.cwd), false)
  })
})

test("an account's search runs in that account's agy", async () => {
  await withKit(async (kit) => {
    const seen = searches(kit)
    await kit.plugin.search.agy.execute({ query: "x" }, { getAuth: async () => ({ type: "oauth", metadata: { agyHome: "accountb1" } }) })
    assert.notEqual(seen.home, kit.home)
    assert.match(seen.home, /accountb1/)
  })
})

test("a turn that searched nothing is an error, not an empty list", async () => {
  await withKit(async (kit) => {
    kit.defaultPrompt = async (agent) => {
      await agent.text("I can't search")
      return { stopReason: "end_turn" }
    }
    await assert.rejects(kit.plugin.search.agy.execute({ query: "x" }, {}), /didn't search the web/)
  })
})

test("agy not signed in is the account refused, for magpie to rest", async () => {
  await withKit(async (kit) => {
    const error = await kit.plugin.search.agy.execute({ query: "x" }, {}).catch((e) => e)
    assert.equal(error.status, 401)
  }, { sessionNewError: { code: -32000, message: "Authentication required" } })
})

test("anything agy asks to run besides the search is refused", async () => {
  await withKit(async (kit) => {
    let answer
    searches(kit)
    const search = kit.defaultPrompt
    kit.defaultPrompt = async (agent) => {
      const child = kit.acpSpawns.at(-1).child
      const fake = child.onStdin
      const replied = new Promise((resolve) => {
        child.onStdin = (chunk) => {
          for (const line of chunk.split("\n")) {
            if (!line.trim()) continue
            const m = JSON.parse(line)
            if (m.id === 900 && !m.method) resolve(m)
          }
          fake(chunk)
        }
      })
      // asked as agy asks before a tool of its own
      child.stdout.emit("data", JSON.stringify({ jsonrpc: "2.0", id: 900, method: "session/request_permission", params: {
        sessionId: agent.sessionId, toolCall: { toolCallId: "c0", title: "run_command" },
        options: [{ optionId: "a", kind: "allow_once" }, { optionId: "r", kind: "reject_once" }] } }) + "\n")
      answer = await replied
      child.onStdin = fake
      return search(agent)
    }
    await kit.plugin.search.agy.execute({ query: "x" }, {})
    assert.deepEqual(answer.result, { outcome: { outcome: "selected", optionId: "r" } })
  })
})

test("pagesOfSearchWeb: count, a summary citing nothing, and no Sources", async () => {
  await withKit(async (kit) => {
    const pagesOf = kit.module.pagesOfSearchWeb
    assert.equal(pagesOf(OUTPUT).length, 6)
    assert.equal(pagesOf(OUTPUT, 2).length, 2)
    const plain = "The search for \"x\" returned the following summary:\nJust words.\n\nSources:\n[1] [a.dev](https://a.dev/x)\n[2] [b.dev](https://b.dev/y)\n"
    assert.deepEqual(pagesOf(plain), [{ title: "a.dev", url: "https://a.dev/x", text: "Just words." }, { title: "b.dev", url: "https://b.dev/y", text: "" }])
    assert.deepEqual(pagesOf("The search for \"x\" returned no results."), [])
    assert.deepEqual(pagesOf(OUTPUT.replace(/\n/g, "\r\n")).map((p) => p.title), pagesOf(OUTPUT).map((p) => p.title))
  })
})
