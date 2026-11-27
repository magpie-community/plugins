import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin, { findZcode, modelOf } from "./index.mjs"
import { Collector, errorOf, lastErrorLine, usageOf } from "./stream.mjs"
import { ARGV_PROMPT_MAX, render } from "./prompt.mjs"

const fake = join(import.meta.dir, "test", "fake-zcode.mjs")
let dir, record
const saved = {}
const ENV = ["ZCODE_CLI", "ZCODE_CLI_NODE", "FAKE_ZCODE_MODE", "FAKE_ZCODE_RECORD", "ZCODE_CLI_PROVIDER", "ZCODE_CLI_MODE", "PATH"]

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k]
  dir = mkdtempSync(join(tmpdir(), "zcode-cli-test-"))
  record = join(dir, "record.json")
  process.env.ZCODE_CLI = fake
  process.env.ZCODE_CLI_NODE = process.execPath
  process.env.FAKE_ZCODE_RECORD = record
  delete process.env.FAKE_ZCODE_MODE
  delete process.env.ZCODE_CLI_PROVIDER
  delete process.env.ZCODE_CLI_MODE
})
afterEach(() => {
  for (const k of ENV) (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]))
  rmSync(dir, { recursive: true, force: true })
})

async function loader() {
  const hooks = await plugin.server({})
  return { hooks, fetch: (await hooks.auth.loader(async () => ({}))).fetch }
}
const req = (body) => ({ method: "POST", body: JSON.stringify(body) })
const rec = () => JSON.parse(readFileSync(record, "utf8"))

async function events(res) {
  const text = await res.text()
  return text.split("\n\n").filter(Boolean).map((chunk) => JSON.parse(chunk.split("\n").find((l) => l.startsWith("data: ")).slice(6)))
}

describe("zcode-cli", () => {
  test("streams ZCode's text and reasoning as Anthropic events, with its usage", async () => {
    const { fetch } = await loader()
    const res = await fetch("zcode://local/v1/messages", req({ model: "zcode-cli/GLM-5.3", messages: [{ role: "user", content: "hi" }] }))
    expect(res.status).toBe(200)
    const evs = await events(res)
    expect(evs[0].type).toBe("message_start")
    expect(evs[1].content_block.type).toBe("thinking")
    const thinking = evs.filter((e) => e.delta?.type === "thinking_delta").map((e) => e.delta.thinking).join("")
    const text = evs.filter((e) => e.delta?.type === "text_delta").map((e) => e.delta.text).join("")
    expect(thinking).toBe("Thinking it over.")
    expect(text).toBe("Hello from ZCode")
    const delta = evs.find((e) => e.type === "message_delta")
    expect(delta.usage).toEqual({ input_tokens: 100, output_tokens: 7, cache_read_input_tokens: 20 })
    expect(evs.at(-1).type).toBe("message_stop")
    // a block per kind, each closed
    expect(evs.filter((e) => e.type === "content_block_start").length).toBe(2)
    expect(evs.filter((e) => e.type === "content_block_stop").length).toBe(2)
  })

  test("runs ZCode's documented headless mode, read-only, with the asking tools removed", async () => {
    const { fetch } = await loader()
    await (await fetch("zcode://local/v1/messages", req({ model: "GLM-5.3", messages: [{ role: "user", content: "hi" }] }))).text()
    const { args, cwd } = rec()
    const at = (f) => args[args.indexOf(f) + 1]
    expect(at("--prompt")).toBe("hi")
    expect(at("--output-format")).toBe("stream-json")
    expect(at("--mode")).toBe("plan")
    expect(at("--disallowed-tools")).toBe("AskUserQuestion EnterPlanMode ExitPlanMode Agent Task")
    expect(args).toContain("--no-color")
    expect(args).not.toContain("--model")
    // macOS reports /var/... as /private/var/...
    expect(cwd.endsWith(at("--cwd").replace(/^\/private/, ""))).toBe(true)
    // the run's own folder is gone afterwards
    expect(existsSync(at("--cwd"))).toBe(false)
  })

  test("a chosen model goes to ZCode in a provider file of the run's own", async () => {
    const { fetch } = await loader()
    await (await fetch("x/v1/messages", req({ model: "GLM-5.3-Flash", messages: [{ role: "user", content: "hi" }] }))).text()
    expect(rec().providerConfig.config.defaultModelSelection).toEqual({ providerId: "account:zai-individual-coding-plan", modelId: "GLM-5.3-Flash" })
    expect(rec().providerConfig.config.providerConfigRules.providerRules).toEqual([])
    process.env.ZCODE_CLI_PROVIDER = "account:bigmodel-individual-coding-plan"
    await (await fetch("x/v1/messages", req({ model: "GLM-5.3", messages: [{ role: "user", content: "hi" }] }))).text()
    expect(rec().providerConfig.config.defaultModelSelection.providerId).toBe("account:bigmodel-individual-coding-plan")
  })

  test("zcode-default leaves ZCode's own choice alone", async () => {
    const { fetch } = await loader()
    await (await fetch("x/v1/messages", req({ model: "zcode-default", messages: [{ role: "user", content: "hi" }] }))).text()
    expect(rec().providerConfig).toBe(null)
    expect(modelOf({ model: "zcode-cli/glm-5.3[1m]" })).toBe("GLM-5.3")
    expect(modelOf({ model: "nope" })).toBe(null)
  })

  test("a non-streaming request gets one message", async () => {
    const { fetch } = await loader()
    const res = await fetch("x/v1/messages", req({ model: "GLM-5.3", stream: false, messages: [{ role: "user", content: "hi" }] }))
    const msg = await res.json()
    expect(msg.content.map((b) => b.type)).toEqual(["thinking", "text"])
    expect(msg.content[1].text).toBe("Hello from ZCode")
    expect(msg.usage.output_tokens).toBe(7)
  })

  test("ZCode's risk-control block is a 403 that says what it is", async () => {
    process.env.FAKE_ZCODE_MODE = "blocked"
    const { fetch } = await loader()
    const res = await fetch("x/v1/messages", req({ model: "GLM-5.3", messages: [{ role: "user", content: "hi" }] }))
    expect(res.status).toBe(403)
    const err = (await res.json()).error
    expect(err.code).toBe("zcode_blocked")
    expect(err.message).toContain("3012")
  })

  test("a ZCode that isn't signed in asks for zcode login", async () => {
    process.env.FAKE_ZCODE_MODE = "signin"
    const { fetch } = await loader()
    const res = await fetch("x/v1/messages", req({ model: "GLM-5.3", messages: [{ role: "user", content: "hi" }] }))
    expect(res.status).toBe(401)
    expect((await res.json()).error.message).toContain("zcode login")
  })

  test("a failed turn is the HTTP error, not an empty stream", async () => {
    process.env.FAKE_ZCODE_MODE = "turnfail"
    const { fetch } = await loader()
    const res = await fetch("x/v1/messages", req({ model: "GLM-5.3", messages: [{ role: "user", content: "hi" }] }))
    expect(res.status).toBe(429)
  })

  test("the client hanging up ends ZCode", async () => {
    process.env.FAKE_ZCODE_MODE = "slow"
    const { fetch } = await loader()
    const ac = new AbortController()
    const res = await fetch("x/v1/messages", { ...req({ model: "GLM-5.3", messages: [{ role: "user", content: "hi" }] }), signal: ac.signal })
    const reader = res.body.getReader()
    let seen = ""
    while (!seen.includes("partial")) seen += new TextDecoder().decode((await reader.read()).value)
    ac.abort()
    // the stream ends once ZCode has gone; a ZCode left running would hold it open
    for (;;) if ((await reader.read()).done) break
    expect(seen).toContain("partial")
  }, 15_000)

  test("no ZCode on this computer is a 503 naming what to install", async () => {
    process.env.ZCODE_CLI = join(dir, "missing")
    expect(findZcode()).toBe(null)
    const { fetch } = await loader()
    const res = await fetch("x/v1/messages", req({ model: "GLM-5.3", messages: [{ role: "user", content: "hi" }] }))
    expect(res.status).toBe(503)
  })

  test("count_tokens is answered without running ZCode", async () => {
    const { fetch } = await loader()
    const res = await fetch("x/v1/messages/count_tokens", req({ model: "GLM-5.3", messages: [{ role: "user", content: "hello there" }] }))
    expect((await res.json()).input_tokens).toBeGreaterThan(0)
    expect(existsSync(record)).toBe(false)
  })

  test("the provider's models and sign-in", async () => {
    const { hooks } = await loader()
    const cfg = { provider: { "zcode-cli": { name: "Mine" } } }
    await hooks.config(cfg)
    expect(cfg.provider["zcode-cli"].name).toBe("Mine")
    expect(Object.keys(await hooks.provider.models())).toEqual(["zcode-default", "GLM-5.3", "GLM-5.3-Flash", "GLM-5-Turbo"])
    const a = await hooks.auth.methods[0].authorize()
    expect(await a.callback()).toEqual({ type: "success", key: "zcode-cli" })
    process.env.ZCODE_CLI = join(dir, "missing")
    expect((await hooks.auth.methods[0].authorize()).type).toBe("failed")
  })
})

describe("prompt", () => {
  test("one user message goes as it is", () => {
    expect(render({ messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }, dir).prompt).toBe("hi")
  })

  test("instructions, history and tool turns go in order", () => {
    const { prompt } = render({
      system: [{ type: "text", text: "Be brief." }],
      messages: [
        { role: "user", content: "list files" },
        { role: "assistant", content: [{ type: "thinking", thinking: "secret" }, { type: "tool_use", id: "t1", name: "ls", input: { p: "." } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "a.txt" }, { type: "text", text: "and now?" }] },
      ],
    }, dir)
    expect(prompt.indexOf("Be brief.")).toBeLessThan(prompt.indexOf("list files"))
    expect(prompt).toContain('[called tool ls with {"p":"."}]')
    expect(prompt).toContain("a.txt")
    expect(prompt).not.toContain("secret")
    expect(prompt.trim().endsWith("Answer the last user message.")).toBe(true)
  })

  test("an inline image is attached as a file", async () => {
    process.env.ZCODE_CLI = fake
    const { fetch } = await loader()
    const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64")
    await (await fetch("x/v1/messages", req({ model: "GLM-5.3", messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: png } }, { type: "text", text: "what is it" }] }] }))).text()
    expect(rec().attached).toEqual([8])
  })

  test("a conversation too long for a command line goes in a file ZCode reads", async () => {
    const { fetch } = await loader()
    const long = "x".repeat(ARGV_PROMPT_MAX + 10)
    await (await fetch("x/v1/messages", req({ model: "GLM-5.3", messages: [{ role: "user", content: long }] }))).text()
    const r = rec()
    expect(r.args[r.args.indexOf("--prompt") + 1].length).toBeLessThan(1000)
    expect(r.conversationFile).toContain(long)
  })
})

describe("stream", () => {
  test("a result with no streamed text is the reply", () => {
    const c = new Collector()
    expect(c.take(JSON.stringify({ type: "result", response: "done" }))).toEqual([{ kind: "text", delta: "done" }])
  })

  test("usage in either spelling, and the projection when there is none", () => {
    expect(usageOf({ input_tokens: 5, output_tokens: 2 })).toEqual({ input_tokens: 5, output_tokens: 2 })
    expect(usageOf(undefined, { totalTokenCount: 40 })).toEqual({ input_tokens: 40, output_tokens: 0 })
  })

  test("errors", () => {
    expect(lastErrorLine("warn\nError: boom (traceId: x)\n")).toBe("boom (traceId: x)")
    expect(errorOf("Z.ai user information is invalid").status).toBe(401)
    expect(errorOf("something").status).toBe(502)
  })
})
