import { afterEach, expect, test } from "bun:test"
import { AstraFlowPlugin } from "./index.mjs"
import { callbackCode, keys, projects, refresher, _internal } from "./oauth.mjs"

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })
const inputs = { region: "singapore", protocol: "chat", issuer: "ucloud" }
const stored = (extra = {}) => ({ type: "oauth", issuer: "ucloud", access: "access-old", refresh: "refresh-old", expires: Date.now() + 3600_000,
  inferenceKey: "inference-key", projectId: "project-a", projectName: "Default", keyId: "key-a", keyName: "My key",
  accountId: "user / Default / My key", metadata: { region: "singapore", protocol: "chat" }, ...extra })
const projectRows = [{ ProjectId: "project-a", ProjectName: "Default <project>", IsDefault: true }, { ProjectId: "project-b", ProjectName: "Other" }]
const keyRows = [{ KeyId: "key-a", Name: "Existing <key>", Key: "inference-key", Status: 1, ModelverseDisabled: 0 },
  { KeyId: "disabled", Name: "Disabled", Key: "disabled-secret", Status: 0 },
  { KeyId: "sandbox", Key: "sandbox-secret", ModelverseDisabled: 1 }]
function fixture({ issuer = "ucloud", twoKeys = false, failure } = {}) {
  const calls = []
  globalThis.fetch = async (input, init) => {
    const req = new Request(input, init)
    const url = new URL(req.url)
    if (["localhost", "127.0.0.1"].includes(url.hostname)) return realFetch(req)
    calls.push(req.clone())
    if (url.pathname === "/token") {
      expect(url.origin).toBe(_internal.ISSUERS[issuer].oauth)
      const params = new URLSearchParams(await req.text())
      expect(params.get("client_id")).toBeTruthy()
      expect(params.get("client_secret")).toBeTruthy()
      expect(req.redirect).toBe("error")
      if (failure) return failure(params)
      const claims = Buffer.from(JSON.stringify({ email: "user@example.test", sub: "user-id" })).toString("base64url")
      return Response.json({ access_token: "access-new", refresh_token: "refresh-new", token_type: "Bearer", expires_in: 3600, id_token: `h.${claims}.s` })
    }
    if (url.origin === new URL(_internal.ISSUERS[issuer].api).origin) {
      expect(req.headers.get("Authorization")).toBe("Bearer access-new")
      const body = await req.json()
      if (body.Action === "GetProjectList") return Response.json({ RetCode: 0, ProjectSet: projectRows })
      if (body.Action === "ListUMInferAPIKey") return Response.json({ RetCode: 0, Data: twoKeys ? [...keyRows, { KeyId: "second", Key: "second-secret" }] : keyRows })
      if (body.Action === "CreateUMInferAPIKey") {
        expect(body).toEqual({ Action: "CreateUMInferAPIKey", ProjectId: "project-a", Name: "My new key", ModelverseDisabled: 0, SandBoxDisabled: 1, GrantAllModels: true })
        return Response.json({ RetCode: 0, Data: { KeyId: "created", Name: body.Name, Key: "new-inference-key", Status: 1 } })
      }
      if (body.Action === "GetBalance") return Response.json({ RetCode: 0, AccountInfo: { AmountAvailable: "12.34", Amount: "56.78" } })
      throw new Error(`Unexpected action ${body.Action}`)
    }
    expect(req.headers.get("Authorization")).toBe("Bearer inference-key")
    if (url.pathname === "/v1/models") return Response.json({ data: [{ id: "fixture-chat" }] })
    return new Response("inference OK")
  }
  return calls
}
function callback(flow, extra = {}) {
  const url = new URL(flow.url)
  const result = new URL(url.searchParams.get("redirect_uri"))
  result.search = new URLSearchParams({ state: url.searchParams.get("state"), code: "fixture-code", ...extra }).toString()
  return result.href
}

test("OAuth methods keep API login and validate choices before opening callback listeners", async () => {
  const h = await AstraFlowPlugin()
  expect(h.auth.methods.map((m) => m.type)).toEqual(["api", "oauth", "oauth", "oauth"])
  expect(h.auth.methods[1].prompts.map((p) => p.key)).toEqual(["region", "protocol", "issuer"])
  await expect(h.auth.methods[1].authorize({ ...inputs, issuer: "evil" })).rejects.toThrow("UCloud China or UCloud Global")
  await expect(h.auth.methods[1].authorize({ ...inputs, region: "invalid" })).rejects.toThrow("supported region")
  await expect(h.auth.methods[1].authorize({ ...inputs, protocol: "invalid" })).rejects.toThrow("supported API protocol")
  const prompts = h.auth.methods[2].prompts
  expect(prompts.find((p) => p.key === "keyId").condition({ keyMode: "create" })).toBe(false)
  expect(prompts.find((p) => p.key === "keyName").condition({ keyMode: "create" })).toBe(true)
})

test("manual authorization exchanges the code, uses the default project and existing key, persists account metadata", async () => {
  for (const issuer of ["ucloud", "ucloud-global"]) {
    const calls = fixture({ issuer })
    const h = await AstraFlowPlugin()
    const flow = await h.auth.methods[2].authorize({ ...inputs, issuer, keyMode: "existing" })
    expect(flow.method).toBe("code")
    const authURL = new URL(flow.url)
    expect(authURL.origin).toBe(_internal.ISSUERS[issuer].oauth)
    expect(authURL.searchParams.get("scope")).toBe("openid email offline_access full_access")
    const response = await realFetch(callback(flow))
    expect(response.headers.get("Referrer-Policy")).toBe("strict-origin")
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8")
    expect(await response.text()).toContain("复制回调地址，完成登录")
    expect(calls).toHaveLength(0)
    const result = await flow.callback(callback(flow))
    expect(result.type).toBe("success")
    expect(result.inferenceKey).toBe("inference-key")
    expect(result.access).toBe("access-new")
    expect(result.refresh).toBe("refresh-new")
    expect(result.expires).toBeGreaterThan(Date.now() + 3500_000)
    expect(result.metadata).toEqual({ region: "singapore", protocol: "chat" })
    expect(result.email).toBe("user@example.test")
    expect(result.uid).toBe("user-id")
    expect(result.projectId).toBe("project-a")
    expect(result.keyId).toBe("key-a")
    expect(calls).toHaveLength(3)
    expect((await flow.callback(callback(flow))).type).toBe("failed")
    const tokenBody = new URLSearchParams(await calls[0].text())
    expect(tokenBody.get("grant_type")).toBe("authorization_code")
    expect(tokenBody.get("code")).toBe("fixture-code")
    expect(tokenBody.get("redirect_uri")).toBe(authURL.searchParams.get("redirect_uri"))
  }
})

test("callback validation rejects missing state, foreign URLs, bare codes and denied authorization before network", async () => {
  const redirect = "http://localhost:12345/authorization"
  for (const url of ["bare-code", redirect + "?code=c", redirect + "?state=bad&code=c", "https://evil.test/authorization?state=state&code=c",
    redirect + "?state=state&error=access_denied", redirect + "?state=state"]) {
    expect(() => callbackCode(url, redirect, "state")).toThrow("AstraFlow:")
  }
  fixture()
  const flow = await (await AstraFlowPlugin()).auth.methods[2].authorize(inputs)
  const res = await flow.callback(callback(flow, { state: "wrong" }))
  expect(res.type).toBe("failed")
  expect(res.error).toContain("state does not match")
})

test("manual multiple-key accounts require a selection; creation happens only after explicit create choice", async () => {
  let calls = fixture({ twoKeys: true })
  const h = await AstraFlowPlugin()
  let flow = await h.auth.methods[2].authorize({ ...inputs, keyMode: "existing" })
  expect((await flow.callback(callback(flow))).error).toContain("choose an enabled API key ID")
  expect(calls).toHaveLength(3)
  calls = fixture({ twoKeys: true })
  flow = await h.auth.methods[2].authorize({ ...inputs, projectId: "project-a", keyMode: "existing", keyId: "second" })
  expect((await flow.callback(callback(flow))).inferenceKey).toBe("second-secret")
  calls = fixture()
  flow = await h.auth.methods[2].authorize({ ...inputs, keyMode: "create", keyName: "My new key" })
  expect((await flow.callback(callback(flow))).inferenceKey).toBe("new-inference-key")
  expect(calls).toHaveLength(3)
  expect((await calls[2].json()).Action).toBe("CreateUMInferAPIKey")
})

test("browser callback lists projects and enabled keys without exposing credentials, checks forms and completes automatically", async () => {
  for (const mode of ["existing", "create"]) {
    const calls = fixture()
    const h = await AstraFlowPlugin()
    const flow = await h.auth.methods[1].authorize(inputs)
    const redirect = new URL(new URL(flow.url).searchParams.get("redirect_uri"))
    const state = new URL(flow.url).searchParams.get("state")
    const wrong = await realFetch(callback(flow, { state: "wrong" }))
    expect(wrong.status).toBe(400)
    expect(calls).toHaveLength(0)
    const response = await realFetch(callback(flow))
    const page = await response.text()
    expect(page).toContain("Default &lt;project&gt;")
    expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'")
    expect(response.headers.get("Cache-Control")).toBe("no-store")
    expect(response.headers.get("Referrer-Policy")).toBe("strict-origin")
    for (const secret of ["access-new", "refresh-new", "inference-key"]) expect(page).not.toContain(secret)
    const post = (params, origin = redirect.origin) => realFetch(redirect.origin + "/select", { method: "POST", headers: { Origin: origin }, body: new URLSearchParams(params) })
    expect((await post({ state: "bad", project: "project-a" })).status).toBe(400)
    expect((await post({ state, project: "project-a" }, "https://evil.test")).status).toBe(400)
    const picked = await (await post({ state, project: "project-a" })).text()
    expect(picked).toContain("Existing &lt;key&gt;")
    expect(picked).not.toContain("disabled-secret")
    expect(picked).not.toContain("sandbox-secret")
    expect(picked).not.toContain("inference-key")
    expect(calls).toHaveLength(3)
    const revisited = await (await post({ state, mode: "back" })).text()
    expect(revisited).toContain("Default &lt;project&gt;")
    expect(revisited).not.toContain("inference-key")
    expect(calls).toHaveLength(3)
    expect((await post({ state, project: "project-a" })).status).toBe(200)
    expect((await post({ state, mode, key: "key-a", name: "My new key" })).status).toBe(200)
    const result = await flow.callback()
    expect(result.type).toBe("success")
    expect(result.inferenceKey).toBe(mode === "create" ? "new-inference-key" : "inference-key")
    expect(calls).toHaveLength(5)
    await expect(realFetch(redirect.href)).rejects.toThrow()
  }
})

test("control plane rejects failures, filters disabled/missing keys and paginates before filtering", async () => {
  let offsets = []
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(init.body)
    offsets.push(body.Offset)
    return Response.json({ RetCode: 0, Data: body.Offset === 0 ? Array.from({ length: 100 }, (_, n) => ({ KeyId: `disabled-${n}`, Key: "secret", Status: 0 })) : keyRows })
  }
  expect(await keys(stored(), "project-a")).toEqual([{ id: "key-a", name: "Existing <key>", key: "inference-key" }])
  expect(offsets).toEqual([0, 100])
  for (const body of [{ RetCode: 1, Message: "denied access-old inference-key refresh-old" }, {}, { RetCode: 0, ProjectSet: [] }]) {
    globalThis.fetch = async () => Response.json(body)
    await expect(projects(stored())).rejects.toThrow("AstraFlow:")
  }
  expect(_internal.keyOf({ KeyId: "id", Key: "k\r\ninjected" })).toBeNull()
})

test("renewal rotates tokens once for concurrent host/fetch/model/usage reads and keeps inference metadata", async () => {
  let saved = stored({ expires: Date.now() + 1000 }), writes = [], tokens = 0
  const calls = fixture()
  const mock = globalThis.fetch
  globalThis.fetch = async (...args) => {
    if (String(args[0]).endsWith("/token")) { tokens++; await new Promise((r) => setTimeout(r, 5)) }
    return mock(...args)
  }
  const h = await AstraFlowPlugin({ client: { auth: { set: async (req) => { writes.push(req); saved = req.body; return {} } } } })
  const getAuth = async () => saved
  const opts = await h.auth.loader(async () => stored())
  const [patch, models, usage] = await Promise.all([
    h.auth.refresh(saved), h.provider.models({}, { auth: saved }), h.auth.usage(getAuth), opts.fetch(opts.baseURL + "/chat/completions", { method: "POST", body: "{}" }),
  ])
  expect(tokens).toBe(1)
  expect(patch.refresh).toBe("refresh-new")
  expect(patch.type).toBeUndefined()
  expect(patch.inferenceKey).toBeUndefined()
  expect(models["fixture-chat"].api.url).toBe("https://api-sg.umodelverse.ai/v1")
  expect(usage.balance).toBe("12.34 (UCloud account currency)")
  expect(usage.windows).toEqual([])
  expect(saved.inferenceKey).toBe("inference-key")
  expect(saved.projectId).toBe("project-a")
  expect(writes.every((w) => w.path.id === "astraflow")).toBe(true)
  expect(writes).toHaveLength(1)
  // A host's stale store must get the already-rotated result.
  expect((await h.auth.refresh(stored({ expires: Date.now() - 1 }))).access).toBe("access-new")
  expect(tokens).toBe(1)
  expect(calls.filter((r) => new URL(r.url).pathname === "/token")).toHaveLength(1)
})

test("refresh handles missing rotated tokens, temporary failures and revoked grants without leaking secrets", async () => {
  fixture({ failure: () => Response.json({ access_token: "access-new", expires_in: 3600 }) })
  let h = await AstraFlowPlugin()
  expect((await h.auth.refresh(stored())).refresh).toBe("refresh-old")
  fixture({ failure: () => Response.json({ error: "invalid_grant", error_description: "revoked refresh-old access-old" }, { status: 400 }) })
  h = await AstraFlowPlugin()
  try { await h.auth.refresh(stored()); throw Error("expected") } catch (e) {
    expect(e.signIn).toBe("expired")
    expect(e.message).not.toContain("refresh-old")
    expect(e.message).not.toContain("access-old")
  }
  fixture({ failure: () => new Response("outage", { status: 503 }) })
  h = await AstraFlowPlugin()
  expect((await h.auth.loader(async () => stored({ expires: Date.now() + 1000 }))).apiKey).toBe("inference-key")
  await expect(h.auth.loader(async () => stored({ expires: Date.now() - 1 }))).rejects.toThrow("UCloud request failed")
  await expect(h.auth.refresh(stored({ refresh: "" }))).rejects.toThrow("sign in again")
})

test("native protocols retain bodies and stream/error objects, use the inference key and reject other protocols", async () => {
  for (const [protocol, npm, path] of [["responses", "@ai-sdk/openai", "/responses"], ["anthropic", "@ai-sdk/anthropic", "/messages"]]) {
    fixture()
    const h = await AstraFlowPlugin()
    const auth = stored({ metadata: { region: "singapore", protocol } })
    const ms = await h.provider.models({}, { auth })
    expect(ms[`fixture-chat@${protocol}`].api.npm).toBe(npm)
    expect(ms[`fixture-chat@${protocol}`].api.id).toBe("fixture-chat")
    const opts = await h.auth.loader(async () => auth)
    const body = JSON.stringify({ model: "fixture-chat", stream: true, tools: [], input: "hello", messages: [] })
    const reply = new Response("data: native\n\n", { status: 200, headers: { "Content-Type": "text/event-stream" } })
    globalThis.fetch = async (req) => {
      expect(req.headers.get("Authorization")).toBe("Bearer inference-key")
      expect(req.headers.get("x-api-key")).toBe(protocol === "anthropic" ? "inference-key" : null)
      if (protocol === "anthropic") expect(req.headers.get("anthropic-version")).toBe("2023-06-01")
      expect(await req.text()).toBe(body)
      return reply
    }
    expect(await opts.fetch(opts.baseURL + path, { method: "POST", body })).toBe(reply)
    expect(reply.bodyUsed).toBe(false)
    await expect(opts.fetch(opts.baseURL + "/chat/completions")).rejects.toThrow("outside the selected endpoint")
  }
})

test("OAuth renewal rejects malformed expiries and never shares rotated credentials between accounts", async () => {
  for (const expires_in of [0, -1, "invalid", "Infinity", 1e308]) {
    fixture({ failure: () => Response.json({ access_token: "access-new", expires_in }) })
    const h = await AstraFlowPlugin()
    await expect(h.auth.refresh(stored())).rejects.toThrow("invalid token expiry")
  }
  const calls = []
  globalThis.fetch = async (_url, init) => {
    const refresh = new URLSearchParams(init.body).get("refresh_token")
    calls.push(refresh)
    return Response.json({ access_token: `access-for-${refresh}`, refresh_token: `rotated-${refresh}`, expires_in: 3600 })
  }
  const h = await AstraFlowPlugin()
  const a = stored(), b = stored({ access: "other-access", refresh: "other-refresh" })
  const [first, second] = await Promise.all([h.auth.refresh(a), h.auth.refresh(b)])
  expect(first.refresh).toBe("rotated-refresh-old")
  expect(second.refresh).toBe("rotated-other-refresh")
  expect((await h.auth.refresh(a)).refresh).toBe(first.refresh)
  expect(calls).toEqual(["refresh-old", "other-refresh"])
})

test("balance keeps zero/negative values, does not invent quota and preserves permission errors", async () => {
  const h = await AstraFlowPlugin()
  for (const amount of [0, "0.00", -2]) {
    globalThis.fetch = async () => Response.json({ RetCode: 0, Amount: amount })
    expect((await h.auth.usage(async () => stored())).balance).toBe(`${amount} (UCloud account currency)`)
  }
  for (const body of [{ RetCode: 0 }, { RetCode: 0, Amount: "unknown" }, { RetCode: 0, Amount: true }, { RetCode: 0, Amount: [] }, { RetCode: 1, Message: "permission denied" }]) {
    globalThis.fetch = async () => Response.json(body)
    const result = await h.auth.usage(async () => stored())
    expect(result.error).toBeTruthy()
    expect(result.balance).toBeUndefined()
    expect(result.signIn).toBe("kept")
  }
  globalThis.fetch = () => { throw new Error("API key has no control-plane access") }
  const api = await h.auth.usage(async () => ({ type: "api", key: "fixture-key" }))
  expect(api.windows).toEqual([])
  expect(api.balance).toBeUndefined()
})

test("key selection filters expired Unix timestamps without excluding non-expiring keys", () => {
  const key = { KeyId: "id", Key: "fixture-key", Status: 1 }
  for (const ExpireTime of [Math.floor(Date.now() / 1000) - 1, "1", -2, "invalid", Infinity, true]) {
    expect(_internal.keyOf({ ...key, ExpireTime })).toBeNull()
  }
  for (const ExpireTime of [undefined, null, "", 0, -1, "-1", Math.floor(Date.now() / 1000) + 60]) {
    expect(_internal.keyOf({ ...key, ExpireTime })?.key).toBe("fixture-key")
  }
})

test("browser existing-key submission rechecks revocation, expiry and rotation before saving", async () => {
  for (const changed of [{ Status: 0 }, { ExpireTime: 1 }, { Key: "rotated-inference-key" }]) {
    fixture()
    const mock = globalThis.fetch
    let lists = 0
    globalThis.fetch = async (input, init) => {
      const req = new Request(input, init)
      if (new URL(req.url).hostname === "api.ucloud.cn" && (await req.clone().json()).Action === "ListUMInferAPIKey" && ++lists === 2) {
        return Response.json({ RetCode: 0, Data: [{ ...keyRows[0], ...changed }] })
      }
      return mock(input, init)
    }
    const flow = await (await AstraFlowPlugin()).auth.methods[1].authorize(inputs)
    const url = new URL(callback(flow)), state = url.searchParams.get("state")
    await realFetch(url)
    const post = (params) => realFetch(url.origin + "/select", { method: "POST", headers: { Origin: url.origin }, body: new URLSearchParams({ state, ...params }) })
    await post({ project: "project-a" })
    const response = await post({ mode: "existing", key: "key-a" })
    const result = await flow.callback()
    expect(lists).toBe(2)
    expect(response.status).toBe(changed.Key ? 200 : 400)
    expect(result.type).toBe(changed.Key ? "success" : "failed")
    if (changed.Key) expect(result.inferenceKey).toBe(changed.Key)
    else expect(result.inferenceKey).toBeUndefined()
  }
})

test("renewal never saves an old sign-in after logout, account changes or another refresh", async () => {
  for (const rejected of [false, true]) {
    for (const replacement of [undefined, { type: "api", key: "replacement-key" }, stored({ access: "other-access" }), stored({ projectId: "other-project" })]) {
      let saved = stored({ expires: Date.now() - 1 }), writes = 0, release, started
      const ready = new Promise((resolve) => { started = resolve })
      globalThis.fetch = async () => {
        started()
        await new Promise((resolve) => { release = resolve })
        return rejected ? Response.json({ error: "invalid_grant" }, { status: 400 }) :
          Response.json({ access_token: "renewed-access", refresh_token: "renewed-refresh", expires_in: 3600 })
      }
      const renew = refresher({ auth: { set: async () => { writes++ } } })
      const pending = renew.fresh(async () => saved)
      await ready
      saved = replacement
      release()
      expect(await pending).toBe(replacement)
      expect(writes).toBe(0)
    }
  }
})

test("model discovery never renews or saves its stale OAuth snapshot", async () => {
  let tokens = 0, writes = 0
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/token")) { tokens++; throw new Error("snapshot must not renew") }
    if (String(url).endsWith("/v1/models")) return Response.json({ data: [{ id: "fixture-chat" }] })
    return Response.json({ RetCode: 1, Message: "expired control-plane token" })
  }
  const h = await AstraFlowPlugin({ client: { auth: { set: async () => { writes++ } } } })
  expect(Object.keys(await h.provider.models({}, { auth: stored({ expires: Date.now() - 1 }) }))).toEqual(["fixture-chat"])
  expect(tokens).toBe(0)
  expect(writes).toBe(0)
})
