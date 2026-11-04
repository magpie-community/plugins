// Zed's cloud parses an Anthropic request's thinking.display into its own
// enum, which has only omitted and summarized. Claude Code asks
// claude-sonnet-5-5 for display "updates", which Zed answered 400 "failed to
// parse Anthropic request: unknown variant `updates`, expected `omitted` or
// `summarized`" (gogoing1024, #708). The plugin sends "highlights" as
// summarized, leaves any other unknown value out, and passes the two Zed
// knows as written.
import { afterEach, expect, test } from "bun:test"
import { _internal } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => {
  globalThis.fetch = real
  _internal.tokens.clear()
})

const s = { userId: "4242", access: "plain-access", systemId: "", org: "org-me", plan: "zed_pro", who: "octo" }

// sent is the provider_request the plugin hands Zed for an Anthropic body.
async function sent(body) {
  let got
  globalThis.fetch = async (url, init) => {
    const path = new URL(String(url)).pathname
    if (path === "/client/llm_tokens") return Response.json({ token: "llm-token" })
    if (path === "/completions") {
      got = JSON.parse(init.body)
      const ev = (e) => JSON.stringify({ event: e })
      return new Response(
        [
          ev({ type: "message_start", message: { id: "m1", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], usage: { input_tokens: 1, output_tokens: 0 } } }),
          ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }),
          ev({ type: "message_stop" }),
          JSON.stringify({ status: "stream_ended" }),
        ].join("\n") + "\n",
        { headers: { "x-zed-server-supports-status-messages": "true" } },
      )
    }
    return new Response("", { status: 404 })
  }
  const res = await _internal.complete(s, "https://cloud.zed.dev/v1/messages", { method: "POST", body: JSON.stringify(body) })
  expect(res.status).toBe(200)
  await res.text()
  return got.provider_request
}

// body is a request as Claude Code writes it for claude-sonnet-5-5 at max effort.
const body = (thinking) => ({
  model: "claude-sonnet-5-5",
  stream: true,
  max_tokens: 64000,
  thinking,
  output_config: { effort: "max" },
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
})

test("Claude Code's display updates is left out, the adaptive thinking kept", async () => {
  const pr = await sent(body({ type: "adaptive", display: "updates" }))
  expect(pr.thinking).toEqual({ type: "adaptive" })
  expect(pr.output_config).toEqual({ effort: "max" })
})

test("display highlights goes as summarized", async () => {
  expect((await sent(body({ type: "adaptive", display: "highlights" }))).thinking).toEqual({ type: "adaptive", display: "summarized" })
})

test("a budgeted thinking's unknown display is left out too", async () => {
  expect((await sent(body({ type: "enabled", budget_tokens: 2048, display: "updates" }))).thinking).toEqual({ type: "enabled", budget_tokens: 2048 })
})

test("summarized and omitted go as written", async () => {
  expect((await sent(body({ type: "adaptive", display: "summarized" }))).thinking).toEqual({ type: "adaptive", display: "summarized" })
  expect((await sent(body({ type: "adaptive", display: "omitted" }))).thinking).toEqual({ type: "adaptive", display: "omitted" })
})

test("a request without display is unchanged", async () => {
  expect((await sent(body({ type: "adaptive" }))).thinking).toEqual({ type: "adaptive" })
  expect("thinking" in (await sent({ ...body(undefined), thinking: undefined }))).toBe(false)
})
