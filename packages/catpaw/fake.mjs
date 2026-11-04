// the fake 妙手 (CatPaw) upstream: the round/event/turn conversation machine
// on a local port, with cumulative SSE frames as the real gateway sends.

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const defaultModelTypes = () => [
  { modelTypeId: 77, modelTypeName: "LongCat-2.0", provider: "CATPAW", supportImage: true },
  { modelTypeId: 83, modelTypeName: "Kimi-K3", provider: "CATPAW", supportImage: true, extendedInfo: { rateMultiplier: "1.5" } },
  { modelTypeId: 120, modelTypeName: "LongCat-2.5", provider: "CATPAW", supportImage: true, extendedInfo: { rateMultiplier: "0", marketingCopy: "限时免费" } },
  { modelTypeId: -3, modelTypeName: "my-own-model", provider: "USER_CUSTOM", supportImage: false },
]

export function fakeCatPaw() {
  const state = {
    token: "cat-token-1",
    conversations: [],
    rounds: 0,
    events: 0,
    turns: 0,
    turnError: null, // "sse-error" makes the turn stream send an error frame
    // per-turn frame scripts: each shift() plays one entry as the turn's
    // cumulative frames (the tools tests use it to script a reply, then a
    // forced-retry reply); empty → the default 你好 frames
    turnFramesQueue: [],
    // per-turn delay before the SSE starts (the keep-alive teardown test
    // uses it to keep the stream open while the agent cancels)
    turnDelayMs: 0,
    // sources the gateway has turned off: it answers them HTTP 200 with
    // {code: 400, msg: "source 不存在或未启用: <source>"}, the body behind
    // plugins#605. CatPawCLI was turned off by 2026-11-01.
    disabledSources: new Set(["CatPawCLI"]),
    turnBodies: [],
    balanceCalls: 0,
    // POST /api/agent/maas/model-types, the list the desktop client asks for
    // (items as its renderer reads them: modelTypeId, modelTypeName, provider,
    // supportImage). The ids here are the table's own, plus one the table has
    // never heard of (type 120 is a fixture, not the vendor's number).
    modelTypes: defaultModelTypes(),
    modelTypeCalls: [],
    modelTypesFail: false,
    // the web sign-in: sids awaiting their token, like the real vendor
    webSids: new Map(), // sid -> token to hand out
    webTokens: new Set(), // tokens poll-token has handed out (current-user accepts these)
    pollCalls: 0,
    currentUserCalls: 0,
    reset() {
      state.conversations = []
      state.rounds = 0
      state.events = 0
      state.turns = 0
      state.turnError = null
      state.turnFramesQueue = []
      state.turnDelayMs = 0
      state.disabledSources = new Set(["CatPawCLI"])
      state.turnBodies = []
      state.balanceCalls = 0
      state.modelTypes = defaultModelTypes()
      state.modelTypeCalls = []
      state.modelTypesFail = false
      state.webSids = new Map()
      state.webTokens = new Set()
      state.pollCalls = 0
      state.currentUserCalls = 0
    },
  }
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)

      // the credit balance lives on its own host in the real vendor and takes
      // `X-Auth-Token`; the cookie the conversation gateway wants is refused
      // here with the real body (401 / code 4010)
      if (url.pathname === "/api/gateway/credit/balance") {
        state.balanceCalls++
        if (req.headers.get("x-auth-token") !== state.token && !state.webTokens?.has(req.headers.get("x-auth-token"))) return json(401, { code: 4010, message: "Authentication token is required", data: null, errorCode: null })
        return json(200, {
          code: 0,
          message: "success",
          data: { availableCredits: "1134.67", userPlan: { planId: "plan_free", planName: "体验版", pro: false, status: "active" } },
          errorCode: null,
        })
      }

      // the web sign-in: login-config → poll-token → current-user
      // (no auth on any of them; poll-token hands the token once the sid
      // was "claimed" by a browser login the fake cannot have, so tests
      // arm it via state.webSids)
      if (url.pathname === "/api/gateway/passport/login-config") {
        return json(200, { code: 0, message: "success", data: { loginEntryUrl: `${url.origin}/passport/login-entry` }, errorCode: null })
      }
      if (url.pathname === "/api/gateway/passport/poll-token") {
        state.pollCalls++
        const sid = url.searchParams.get("sid") ?? ""
        const issued = state.webSids.get(sid)
        if (!issued) return json(200, { code: 0, data: null, errorCode: null })
        state.webSids.delete(sid)
        state.webTokens ??= new Set()
        state.webTokens.add(issued)
        return json(200, { code: 0, data: issued, errorCode: null })
      }
      if (url.pathname === "/api/gateway/passport/current-user") {
        state.currentUserCalls++
        if (req.headers.get("x-auth-token") !== state.token && !state.webTokens?.has(req.headers.get("x-auth-token")))
          return json(401, { code: 401, message: "token refused", data: null, errorCode: null })
        return json(200, { code: 0, message: "success", data: { userId: 42, userName: "网页用户" }, errorCode: null })
      }

      const token = (req.headers.get("cookie") ?? "").match(/X-Passport-Token=(.+)/)?.[1] ?? ""
      // any valid login state passes: the desktop file's, and any token the
      // web sign-in handed out (the real vendor accepts both alike)
      if (token !== state.token && !state.webTokens?.has(token)) return json(401, { code: 401, msg: "token refused" })
      if (req.headers.get("m-appkey") !== "com.sankuai.mcopilot.cli") return json(400, { code: 400, msg: "m-appkey missing" })

      const body = await req.json().catch(() => ({}))

      if (url.pathname === "/api/agent/maas/model-types") {
        state.modelTypeCalls.push(body)
        if (state.modelTypesFail) return json(500, { code: 500, msg: "boom" })
        return json(200, { code: 0, message: "success", data: state.modelTypes, errorCode: null })
      }

      if (url.pathname === "/api/agent/conversation/round") {
        state.rounds++
        if (state.disabledSources.has(body.source)) return json(200, { code: 400, msg: `source 不存在或未启用: ${body.source}` })
        if (body.source !== "CatX" || body.mode !== "CATX_APP") return json(400, { code: 400, msg: `source/mode wrong: ${body.source}/${body.mode}` })
        state.conversations.push({ id: body.conversationId, modelType: body.modelType, prompt: body.message?.content?.[0]?.text ?? "", token: (req.headers.get("cookie") ?? "").match(/X-Passport-Token=([^;]+)/)?.[1] ?? "", permissionMode: body.permissionMode, source: body.source, mode: body.mode })
        return json(200, { code: 0, data: { conversationId: body.conversationId } })
      }

      if (url.pathname === "/api/agent/conversation/event") {
        state.events++
        if (body.conversationId !== state.conversations.at(-1)?.id) return json(400, { code: 400, msg: "event for unknown conversation" })
        return json(200, { code: 0 })
      }

      if (url.pathname === "/api/agent/conversation/turn") {
        state.turns++
        state.turnBodies.push(body)
        const conv = state.conversations.at(-1)
        if (body.source !== conv?.source || body.mode !== conv?.mode) return json(400, { code: 400, msg: `turn source/mode ${body.source}/${body.mode} differ from the round's` })
        if (body.conversationId !== conv?.id) return json(400, { code: 400, msg: "turn for unknown conversation" })
        if (state.turnError === "sse-error")
          return new Response(`data: ${JSON.stringify({ error: { code: 500, message: "vendor broke" } })}\n\n`, { headers: { "content-type": "text/event-stream" } })
        if (state.turnDelayMs) await new Promise((r) => setTimeout(r, state.turnDelayMs))
        // cumulative frames: each carries the whole text so far (as the real gateway does)
        const frames = state.turnFramesQueue.length
          ? state.turnFramesQueue.shift()
          : [
          { message: { content: [{ type: "text", text: "你", reasoningContent: "思" }] } },
          { message: { content: [{ type: "text", text: "你好", reasoningContent: "思考" }] } },
          { message: { content: [{ type: "text", text: "你好，", reasoningContent: "思考" }] } },
          { message: { content: [{ type: "text", text: "你好，收到", reasoningContent: "思考" }] }, finished: true },
        ]
        const sse = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("") + "data: [DONE]\n\n"
        return new Response(sse, { headers: { "content-type": "text/event-stream" } })
      }

      return json(404, { code: 404, msg: "no such route" })
    },
  })
  return { server, state, url: `http://127.0.0.1:${server.port}` }
}
