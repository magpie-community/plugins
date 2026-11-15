// The plugin's own surface, offline: the config hook, the request body, the
// canary, the two answer shapes, the turn record and the quota panel. The
// upstream is faked, so nothing here signs in or touches the network.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { _internal, PerchAuthPlugin } from "./index.mjs"

const hooks = await PerchAuthPlugin({ client: { auth: { set: async () => {} } } })

const sse = (list) =>
  new Response(list.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })

describe("config", () => {
  test("declares the provider with every model", async () => {
    const cfg = {}
    await hooks.config(cfg)
    const p = cfg.provider.perchai
    expect(p.npm).toBe("@ai-sdk/openai-compatible")
    expect(Object.keys(p.models)).toHaveLength(Object.keys(_internal.MODELS).length)
    expect(p.models["claude-opus-5.5"].limit.context).toBe(200_000)
    expect(p.models.auto).toBeDefined()
  })

  test("leaves a user's own edit in place", async () => {
    const cfg = { provider: { perchai: { name: "Mine", models: { mine: { id: "mine", name: "Mine" } } } } }
    await hooks.config(cfg)
    expect(cfg.provider.perchai.name).toBe("Mine")
    expect(cfg.provider.perchai.models.mine).toBeDefined()
    expect(cfg.provider.perchai.models.auto).toBeDefined()
  })
})

describe("the request body", () => {
  const body = _internal.callBody(
    { model: "claude-opus-5.5", messages: [{ role: "user", content: "hi" }], max_tokens: 100, temperature: 0.3, stream: true },
    "anthropic-claude-opus-5-5",
  )

  test("opens with the canary, then the caller's messages", () => {
    expect(body.request.messages).toHaveLength(2)
    expect(body.request.messages[0].role).toBe("system")
    expect(body.request.messages[0].content).toBe(_internal.CANARY)
    expect(body.request.messages[1].content).toBe("hi")
  })

  test("uses the CLI's key for the token limit", () => {
    expect(body.request.maxTokens).toBe(100)
    expect("maxOutputTokens" in body.request).toBe(false)
  })

  // A lane on the request itself is what Perch answers perch_surface_required
  // to: the CLI never sends one, and puts its lane beside request instead.
  test("keeps the lane beside request, never inside it", () => {
    expect("lane" in body.request).toBe(false)
    expect(body.lane).toBe("chat")
  })

  test("carries the CLI's turn shape", () => {
    expect(body.request.temperature).toBe(0.3)
    expect(body.request.preferredModelId).toBe("anthropic-claude-opus-5-5")
    expect(body.manualModelOptionId).toBe("anthropic-claude-opus-5-5")
    expect(body.clientSurface).toBe("cli")
    expect(body.resendAfterOutput).toBe(true)
    expect("stream" in body.request).toBe(false)
    expect(body.runId).toMatch(/^cli-turn-\d+-[a-z0-9]{1,6}$/)
  })

  test("runs under a minted ticket when there is one", () => {
    const ticketed = _internal.callBody({ messages: [] }, null, null, "tkt-cli-1-abc")
    expect(ticketed.runId).toBe("tkt-cli-1-abc")
    expect(ticketed.attribution).toBeNull()
  })

  test("asks Roost for a tier only when nothing is pinned", () => {
    const auto = _internal.callBody({ model: "auto", messages: [] }, null)
    expect(auto.preferredModelId).toBeNull()
    expect("manualModelOptionId" in auto).toBe(false)
    expect(auto.roostModelChoice).toBe("standard")
  })

  test("attributes the turn to the account and workspace", () => {
    const a = _internal.callBody({ messages: [] }, null, { userId: "u-1", workspaceId: "w-1" })
    expect(a.attribution.userId).toBe("u-1")
    expect(a.attribution.workspaceId).toBe("w-1")
    expect(a.attribution.runId).toBe(a.runId)
    expect(a.attribution.source).toBe("cli")
  })
})

describe("the canary", () => {
  const own = { role: "system", content: "You are terse." }

  test("keeps a caller's own system prompt behind it", () => {
    const kept = _internal.withCanary([own, { role: "user", content: "hi" }])
    expect(kept).toHaveLength(3)
    expect(kept[0].content).toBe(_internal.CANARY)
    expect(kept[1]).toBe(own)
  })

  test("is not doubled", () => {
    const once = _internal.withCanary([{ role: "system", content: _internal.CANARY }, { role: "user", content: "hi" }])
    expect(once).toHaveLength(2)
  })

  test("is added to a body with no messages", () => {
    expect(_internal.withCanary(undefined)).toHaveLength(1)
  })
})

describe("what Perch is allowed to see", () => {
  // Every string the host harness puts in a prompt, plus its two runtime-context lines.
  const branded = [
    "You are an AI agent powered by DeepSeek Harness.",
    "The runtime context names the DeepSeek Harness implementation checkout. The checkout location and current working directory are separate values and may differ; never infer the working directory from the checkout path. Use pwd to determine the current working directory. Use this checkout only to inspect or extend DSH itself.",
    'You are interacting with the user through the DeepSeek Harness Web GUI whose URL the runtime context names. When the user refers to "this page", they mean this GUI.',
    'The DeepSeek Harness implementation checkout is at "/opt/dsh". Use this checkout only to inspect or extend DSH itself.',
    'You are interacting with the user through the DeepSeek Harness Web GUI at "http://127.0.0.1:57457".',
    'Current DeepSeek Harness implementation checkout: "D:\\\\dsh".',
    'Current DeepSeek Harness Web GUI URL: "http://127.0.0.1:57457".',
  ]

  test("leaves no brand in any prompt line", () => {
    for (const text of branded) expect(_internal.unbrand(text)).not.toContain("DeepSeek Harness")
  })

  test("leaves no bare DSH in the source paragraph", () => {
    expect(_internal.unbrand(branded[1])).not.toMatch(/\bDSH\b/)
  })

  test("keeps the checkout path", () => {
    expect(_internal.unbrand(branded[5])).toContain('"D:\\\\dsh"')
  })

  test("keeps the GUI URL", () => {
    expect(_internal.unbrand(branded[6])).toContain("57457")
  })

  test("leaves identifiers that contain DSH alone", () => {
    const line = "Set DSH_HOME, then run pnpm dsh --profile web; window.__DSH_BOOT__ is injected."
    expect(_internal.unbrand(line)).toBe(line)
  })

  test("passes ordinary text through untouched", () => {
    const line = "Read AGENTS.md, then run `dsh web`."
    expect(_internal.unbrand(line)).toBe(line)
  })

  test("rewrites the request body without touching a tool's name", () => {
    const sent = _internal.callBody(
      {
        messages: [
          { role: "system", content: branded[0] },
          { role: "user", content: [{ type: "text", text: branded[6] }] },
        ],
        tools: [{ type: "function", function: { name: "read", description: `Reads a file. ${branded[0]}`, parameters: {} } }],
      },
      null,
    )
    const wire = JSON.stringify(sent.request)
    expect(wire).not.toContain("DeepSeek Harness")
    expect(wire).toContain("http://127.0.0.1:57457")
    expect(sent.request.messages[2].content[0].text.startsWith("Current Web GUI URL:")).toBe(true)
    expect(sent.request.tools[0].function.name).toBe("read")
  })

  test("keeps rewritten tools valid JSON", () => {
    expect(JSON.stringify(_internal.unbrandTools([{ description: "x" }]))).not.toContain("undefined")
  })
})

describe("the Starter aliases", () => {
  test("are listed with the option ids Perch pins them by", () => {
    expect(_internal.MODELS["deepseek-flash-starter"].optionId).toBe("openrouter-deepseek-deepseek-v4-1-flash-crusoe")
    expect(_internal.MODELS["glm-5.3-flash-starter"].optionId).toBe("openrouter-z-ai-glm-5-3-flash-crusoe")
    expect(_internal.MODELS["beam-1.0-starter"].optionId).toBe("openrouter-reflection-beam-1-0-501b-a23b")
  })
})

describe("pasting a token", () => {
  const claim = (v) => Buffer.from(JSON.stringify(v)).toString("base64url")
  const fakeJwt = `x.${claim({ sub: "u-9", exp: 1_800_000_000, email: "me@example.com" })}.y`

  test("takes a bare access token", () => {
    const bare = _internal.pastedSignIn({ session: fakeJwt })
    expect(bare.access).toBe(fakeJwt)
    expect(bare.uid).toBe("u-9")
    expect(bare.accountId).toBe("me@example.com")
    expect(bare.expires).toBe(1_800_000_000_000)
  })

  test("takes a whole session file", () => {
    const whole = _internal.pastedSignIn({
      session: JSON.stringify({ accessToken: fakeJwt, refreshToken: "r-1", expiresAt: 1_700_000_000, email: "a@b.c", userId: "u-1" }),
    })
    expect(whole.refresh).toBe("r-1")
    expect(whole.expires).toBe(1_700_000_000_000)
    expect(whole.accountId).toBe("a@b.c")
    expect(whole.uid).toBe("u-1")
  })

  test("refuses an empty or broken paste", () => {
    expect(() => _internal.pastedSignIn({ session: "   " })).toThrow(/nothing was pasted/)
    expect(() => _internal.pastedSignIn({ session: "{ nope" })).toThrow(/not valid JSON/)
  })
})

describe("the sign-in this machine already has", () => {
  // A Supabase session cookie is `base64-<json>`, split across .0/.1 — the
  // shape the desktop app leaves in its Chromium jar.
  const session = {
    access_token: "access-abc",
    refresh_token: "refresh-xyz",
    expires_at: 1_900_000_000,
    user: { id: "u-7", email: "me@example.com" },
  }
  const value = `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`
  const half = Math.ceil(value.length / 2)
  const rows = [
    { name: "sb-abcdefghij-auth-token.0", value: value.slice(0, half) },
    { name: "sb-abcdefghij-auth-token.1", value: value.slice(half) },
  ]

  test("joins a split cookie back into a session", () => {
    const fromJar = _internal.sessionFromCookie(rows)
    expect(fromJar.access).toBe("access-abc")
    expect(fromJar.refresh).toBe("refresh-xyz")
    expect(fromJar.expires).toBe(1_900_000_000_000)
    expect(fromJar.accountId).toBe("me@example.com")
    expect(fromJar.uid).toBe("u-7")
    expect(fromJar.source).toBe("desktop")
  })

  test("ignores a jar with nothing usable in it", () => {
    expect(_internal.sessionFromCookie([])).toBeNull()
    expect(_internal.sessionFromCookie([{ name: "unrelated", value: "x".repeat(64) }])).toBeNull()
    expect(_internal.sessionFromCookie([{ name: "sb-abcdefghij-auth-token.0", value: "base64-not-json" }])).toBeNull()
    expect(
      _internal.sessionFromCookie([{ name: "sb-abcdefghij-auth-token.0", value: `base64-${Buffer.from("{}").toString("base64url")}` }]),
    ).toBeNull()
  })

  test("enumerates the cookie stores", () => {
    expect(Array.isArray(_internal.cookieStores())).toBe(true)
  })

  // The desktop app writes the same session file into its own user-data
  // folder instead of ~/.perch, so both paths have to be read.
  const tmp = mkdtempSync(join(tmpdir(), "perch-test-"))
  afterAll(() => rmSync(tmp, { recursive: true, force: true }))

  test("reads a session file at any path", () => {
    const file = join(tmp, "cli-auth-session.json")
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        appUrl: "https://app.perchai.app",
        accessToken: "access-desktop",
        refreshToken: "refresh-desktop",
        expiresAt: 1_900_000_000,
        userId: "u-8",
        email: "desktop@example.com",
      }),
      "utf8",
    )
    const readBack = _internal.fromAuthFile(file)
    expect(readBack.access).toBe("access-desktop")
    expect(readBack.accountId).toBe("desktop@example.com")
    expect(_internal.fromAuthFile(join(tmp, "nope.json"))).toBeNull()
  })

  test("only lists session files", () => {
    expect(_internal.sessionFiles().every((p) => p.endsWith("cli-auth-session.json"))).toBe(true)
  })
})

describe("a non-streamed answer", () => {
  const answer = () =>
    _internal.events(
      sse([
        { type: "reasoning_delta", text: "think" },
        { type: "answer_delta", text: "Hel" },
        { type: "answer_delta", text: "lo" },
        { type: "done", ok: true, text: "Hello", provider: "anthropic", model: "claude-opus-5.5", usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 } },
      ]),
    )

  test("becomes a chat.completion", async () => {
    const body = await (await _internal.openai({ model: "claude-opus-5.5" }, answer())).json()
    expect(body.object).toBe("chat.completion")
    expect(body.choices[0].message.content).toBe("Hello")
    expect(body.choices[0].message.reasoning_content).toBe("think")
    expect(body.usage.total_tokens).toBe(14)
    expect(body.choices[0].finish_reason).toBe("stop")
  })
})

describe("a streamed answer", () => {
  const frames = async (list) => {
    const res = await _internal.openai({ model: "claude-opus-5.5", stream: true }, _internal.events(sse(list)))
    const text = await res.text()
    const parts = text.split("\n\n").filter(Boolean).map((f) => f.replace(/^data: /, ""))
    return { last: parts.at(-1), frames: parts.slice(0, -1).map((f) => JSON.parse(f)) }
  }

  test("is OpenAI chunks ending in [DONE]", async () => {
    const { last, frames: out } = await frames([
      { type: "answer_delta", text: "Hi" },
      { type: "tool_call_delta", toolCalls: [{ id: "c1", name: "ls", arguments: "{}", sealed: true }] },
      { type: "done", ok: true, text: "Hi", toolCalls: [{ id: "c1", name: "ls", arguments: "{}" }] },
    ])
    expect(last).toBe("[DONE]")
    expect(out[0].choices[0].delta.role).toBe("assistant")
    expect(out.some((f) => f.choices[0]?.delta?.content === "Hi")).toBe(true)
    const call = out.find((f) => f.choices[0]?.delta?.tool_calls)
    expect(call.choices[0].delta.tool_calls[0].function.name).toBe("ls")
    expect(call.choices[0].delta.tool_calls[0].index).toBe(0)
    expect(out.find((f) => f.choices[0]?.finish_reason).choices[0].finish_reason).toBe("tool_calls")
  })

  test("appends rather than retracts when Perch restarts the turn", async () => {
    const { frames: out } = await frames([
      { type: "answer_delta", text: "partial" },
      { type: "stream_restart", reason: "same_model_resend" },
      { type: "answer_delta", text: "final" },
      { type: "done", ok: true, text: "final" },
    ])
    expect(out.filter((f) => f.choices[0]?.delta?.content).map((f) => f.choices[0].delta.content).join("")).toBe("partialfinal")
  })

  test("turns an exhausted allowance into 429", async () => {
    const res = await _internal.openai(
      { model: "claude-opus-5.5" },
      _internal.events(sse([{ type: "done", ok: false, error: "no credit", errorCode: "usage_limit_reached" }])),
    )
    expect(res.status).toBe(429)
    expect((await res.json()).error.type).toBe("rate_limit_error")
  })
})

describe("the turn record", () => {
  test("names the thread the way the CLI does", () => {
    expect(_internal.threadId()).toMatch(/^cli-cwd-[0-9a-f]{16}$/)
  })

  test("takes the prompt from the last user message", () => {
    expect(_internal.lastUserText([{ role: "user", content: "hi" }])).toBe("hi")
    expect(
      _internal.lastUserText([{ role: "user", content: "a" }, { role: "assistant", content: "x" }, { role: "user", content: "b" }]),
    ).toBe("b")
    expect(
      _internal.lastUserText([{ role: "user", content: [{ type: "text", text: "a" }, { type: "image_url", image_url: { url: "x" } }, { type: "text", text: "b" }] }]),
    ).toBe("a\nb")
    expect(_internal.lastUserText([])).toBe("")
  })

  test("files nothing without a token or a run id", async () => {
    expect(await _internal.reportTurn("", { runId: "cli-turn-1-a" })).toBe(false)
    expect(await _internal.reportTurn("tok", {})).toBe(false)
  })

  test("files exactly one record per turn, after the answer", async () => {
    const seen = []
    const res = await _internal.openai(
      { model: "claude-opus-5.5", stream: true },
      _internal.events(
        sse([
          { type: "answer_delta", text: "Hel" },
          { type: "answer_delta", text: "lo" },
          { type: "done", ok: true, text: "Hello" },
        ]),
      ),
      undefined,
      (t) => {
        seen.push(t)
        return Promise.resolve(true)
      },
    )
    await res.text()
    expect(seen).toHaveLength(1)
    expect(seen[0].status).toBe("completed")
    expect(seen[0].assistantText).toBe("Hello")
    expect(typeof seen[0].durationMs).toBe("number")
  })

  test("files a refused turn as failed, with its reason", async () => {
    const seen = []
    await (
      await _internal.openai({ model: "m" }, _internal.events(sse([{ type: "done", ok: false, error: "nope" }])), undefined, (t) => {
        seen.push(t)
        return Promise.resolve(true)
      })
    ).text()
    expect(seen[0].status).toBe("error")
    expect(seen[0].error).toBe("nope")
  })
})

describe("the quota panel", () => {
  // The live meter is what the desktop app's account page shows; POST /usage
  // without run ids reports zero, so the meter is what the panel is built from.
  const meter = {
    monthlyTokens: 81_572,
    monthlyCalls: 9,
    monthlyUsd: 0.006,
    roostRolling: {
      enabled: true,
      window5hUsd: 0.002,
      window5hCapUsd: 2.5,
      window5hNextFreedAt: "2026-11-15T11:30:00.000Z",
      window7dUsd: 0.006,
      window7dCapUsd: 7.5,
      window7dNextFreedAt: "2026-11-21T13:30:00.000Z",
    },
  }

  test("shows the month, its allowance and both rolling windows", () => {
    const panels = _internal.meterWindows(meter, 20)
    expect(panels[0].display).toBe("81,572 tokens · 9 calls · $0.01")
    expect(Math.abs(panels[1].used - 0.03)).toBeLessThan(0.02)
    expect(panels[2].name).toBe("Five-hour window")
    expect(panels[2].resetsAt).toBe("2026-11-15T11:30:00.000Z")
    expect(panels[3].name).toBe("Weekly window")
  })

  test("shows only what the meter has", () => {
    expect(_internal.meterWindows({ monthlyTokens: 10, monthlyUsd: 1 }, 0)).toHaveLength(1)
    expect(_internal.meterWindows({}, 20)).toHaveLength(0)
  })
})
