// Re-measures what the QwenWork Intl entry in index.mjs rests on, against the
// live site, with no credential. Read-only: it starts no sign-in, sends no
// token, and writes nothing.
//
//   node packages/qoder/tools/probe-qwenwork-intl.mjs
//
// It talks to the gateway directly. Where a machine's own route to
// gateway.qwenwork.ai is blocked (CONNECT_TIMEOUT) but magpie's proxy reaches
// it, point HTTP(S)_PROXY at that proxy, or run this from a machine that
// reaches the gateway.
//
// Each section prints the claim the site entry carries beside the answer it
// gets back, so a change on the vendor's side shows up as a mismatch rather
// than as a stale comment.
//
// The entry signs in through two identities, and this measures both:
//
//   device wrapper   gateway.qwenwork.ai/device/selectAccounts
//                    client_id     cc65e5fc-05bd-4f5d-a4e8-0df19aa3d75a
//                    redirect_uri  qwenwork://
//   Ory issuer       qwenwork.ai, client qwenwork-desktop-app
//                    redirect_uri  https://gateway.qwenwork.ai/oauth/callback
//
// The wrapper is what the desktop app calls; the issuer answers what the
// wrapper hands it. A query carrying the issuer's own pair is refused there,
// which is the whole reason the entry has two of each.
import { randomBytes, createHash, randomUUID } from "node:crypto"

const ISSUER = "https://qwenwork.ai"
const GATEWAY = "https://gateway.qwenwork.ai"
const OPENAPI = "https://openapi.qoder.sh"
// the Ory client: what the wrapper authorizes, and what the entry's clientId is
const ORY_CLIENT = "qwenwork-desktop-app"
const ORY_REDIRECT = `${GATEWAY}/oauth/callback`
// the wrapper's own client: the brand's oauthClientId, and its bare scheme
const WRAPPER_CLIENT = "cc65e5fc-05bd-4f5d-a4e8-0df19aa3d75a"
const WRAPPER_REDIRECT = "qwenwork://"
const SCOPE = "openid profile email offline_access qwen_work"

// the names the desktop app puts on its gateway calls, as this package's
// qwenworkClientHeaders builds them
const clientHeaders = () => ({
  "User-Agent": "qoderwork/2.0.2",
  "X-Request-Id": randomUUID(),
  "X-QwenWork-Version": "2.0.2",
  "X-QwenWork-Release-Version": "2.0.2-26111211",
  "X-QwenWork-Build": "26111211",
  "X-QwenWork-Platform": "win32",
  "X-QwenWork-Arch": "x64",
  "X-QwenWork-Channel": "stable",
})

const b64url = (buf) => buf.toString("base64url")
const pkce = () => {
  const verifier = b64url(randomBytes(64))
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) }
}

// a cookie jar: the wrapper's 302 carries its CDN's own cookies (acw_tc and
// friends), and this carries them along the way a browser would. What the
// poll does with them is not established — it answers the same either way
// here — so nothing below rests on them.
const jar = new Map()
const rememberCookies = (res) => {
  const list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : []
  for (const line of list) {
    const [pair] = line.split(";")
    const at = pair.indexOf("=")
    if (at > 0) jar.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim())
  }
}
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ")

async function fetchWithTimeout(url, init = {}, ms = 15_000) {
  const signal = AbortSignal.timeout(ms)
  try {
    const res = await fetch(url, { redirect: "manual", signal, ...init })
    rememberCookies(res)
    const text = await res.text()
    return { status: res.status, location: res.headers.get("location") ?? "", headers: res.headers, text }
  } catch (e) {
    return { status: 0, location: "", headers: new Headers(), text: "", error: e.name === "TimeoutError" ? "timeout" : String(e?.message ?? e) }
  }
}

const jsonOf = (text) => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

const say = (label, claim, got) => console.log(`${label.padEnd(46)} claim: ${claim}\n${"".padEnd(46)} got:   ${got}`)

// a query as the wrapper takes it, built the way deviceSignIn builds it: it
// takes these six names and no others — a scope, a login_hint, anything
// extra is 400 not_allowed, which is why the wrapper sets the scope itself
// when it hands the flow to the issuer
const wrapperQuery = (clientId, redirect) => {
  const { challenge } = pkce()
  const q = new URLSearchParams({
    challenge,
    challenge_method: "S256",
    nonce: randomUUID(),
    machine_id: randomUUID(),
    client_id: clientId,
  })
  if (redirect) q.set("redirect_uri", redirect)
  return q
}

// 1. the issuer's own document: which endpoints, which grants, which scopes
console.log("\n== 1. issuer discovery")
const disc = await fetchWithTimeout(`${ISSUER}/.well-known/openid-configuration`)
const doc = jsonOf(disc.text) ?? {}
say("GET /.well-known/openid-configuration", "200 with the .ai endpoints", `${disc.status} issuer=${doc.issuer ?? "-"}`)
for (const key of ["authorization_endpoint", "token_endpoint", "userinfo_endpoint", "revocation_endpoint", "device_authorization_endpoint"]) {
  const value = doc[key] ?? "-"
  const origin = value === "-" ? "-" : new URL(value).origin
  say(`  ${key}`, `on ${new URL(ISSUER).origin}`, `${value}  origin=${origin}`)
}
say("  grant_types_supported", "lists device_code (a tenant grant)", JSON.stringify(doc.grant_types_supported ?? []))
say("  scopes_supported", "offline_access offline openid mcp", JSON.stringify(doc.scopes_supported ?? []))

// 2. which redirect the issuer holds for the Ory client — the only one it takes
console.log("\n== 2. registered redirect for the Ory client, at the issuer")
const accepted = []
for (const redirect of [
  ORY_REDIRECT,
  "https://gateway.qwenwork.cn/oauth/callback",
  `${ISSUER}/oauth/callback`,
  "qwenwork-cn://",
  WRAPPER_REDIRECT,
  "qwenwork-intl://",
  "http://127.0.0.1:1455/callback",
]) {
  const { challenge } = pkce()
  const query = new URLSearchParams({
    client_id: ORY_CLIENT,
    redirect_uri: redirect,
    response_type: "code",
    scope: SCOPE,
    state: "probe-state-1234",
    code_challenge: challenge,
    code_challenge_method: "S256",
  })
  const res = await fetchWithTimeout(`${ISSUER}/oauth2/auth?${query}`)
  const landing = res.location
  const ok = /\/signin\?login_challenge=|\/consent|\/login/.test(landing)
  if (ok) accepted.push(redirect)
  console.log(`  ${ok ? "ACCEPTED" : "refused "} ${redirect.padEnd(42)} ${ok ? landing.slice(0, 60) : decodeURIComponent(landing).slice(0, 70)}`)
}
say("the entry sends", ORY_REDIRECT, accepted.includes(ORY_REDIRECT) ? "accepted" : "REFUSED — the entry is wrong")
say("the entry adds", WRAPPER_REDIRECT, accepted.includes(WRAPPER_REDIRECT) ? "accepted" : "refused at the issuer (the wrapper holds it, not the issuer)")

// 3. the issuer's own device grant, which this client does not carry
console.log("\n== 3. device grant at the issuer")
const deviceGrant = await fetchWithTimeout(`${ISSUER}/oauth2/device/auth`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
  body: new URLSearchParams({ client_id: ORY_CLIENT, scope: SCOPE }).toString(),
})
const grant = jsonOf(deviceGrant.text) ?? {}
say("POST /oauth2/device/auth", "invalid_grant: client lacks device_code", `${deviceGrant.status} ${grant.error ?? ""} — ${String(grant.error_description ?? "").slice(0, 90)}`)

// 4. the wrapper: which pair it takes, and what it hands to the issuer
console.log("\n== 4. device wrapper at gateway.qwenwork.ai")
for (const [label, clientId, redirect] of [
  ["wrapper pair + qwenwork://", WRAPPER_CLIENT, WRAPPER_REDIRECT],
  ["Ory pair (entry's clientId + callback)", ORY_CLIENT, ORY_REDIRECT],
  ["Ory client with the bare scheme", ORY_CLIENT, WRAPPER_REDIRECT],
  ["wrapper client with the callback", WRAPPER_CLIENT, ORY_REDIRECT],
  ["wrapper client, no redirect_uri", WRAPPER_CLIENT, ""],
]) {
  const res = await fetchWithTimeout(`${GATEWAY}/device/selectAccounts?${wrapperQuery(clientId, redirect)}`, {
    headers: { accept: "text/html,*/*", ...clientHeaders(), ...(jar.size ? { cookie: cookieHeader() } : {}) },
  })
  const body = jsonOf(res.text)
  const details = body?.details ? `${body.details.field}/${body.details.reason}` : ""
  console.log(`  ${String(res.status).padEnd(4)} ${label.padEnd(38)} ${body?.errorCode ?? ""} ${details}`)
  if (res.location) {
    // what it hands the issuer: the wrapper authorizes the Ory client, and
    // swaps the bare scheme for the one the issuer has registered
    let handed = {}
    try {
      const u = new URL(res.location, ISSUER)
      handed = { client_id: u.searchParams.get("client_id"), redirect_uri: u.searchParams.get("redirect_uri"), scope: u.searchParams.get("scope"), origin: u.origin, path: u.pathname }
    } catch {}
    console.log(`       -> ${handed.origin ?? ""}${handed.path ?? ""}`)
    console.log(`          client_id=${handed.client_id ?? "-"}  redirect_uri=${handed.redirect_uri ?? "-"}`)
    console.log(`          scope=${handed.scope ?? "-"}`)
  }
}
say("the entry's wrapper pair", "302 to /oauth2/auth on the issuer, handed the Ory pair", "see above")

// 5. the poll: only nonce/verifier/challenge_method, and 404 is a wait
console.log("\n== 5. poll at gateway.qwenwork.ai")
{
  // a flow started but never authorized: the wrapper's 302 above set the
  // session cookies this poll presents, as the desktop app does
  const started = wrapperQuery(WRAPPER_CLIENT, WRAPPER_REDIRECT)
  const nonce = started.get("nonce")
  const verifier = pkce().verifier
  const poll = (params, label, claim) =>
    fetchWithTimeout(`${GATEWAY}/api/v1/deviceToken/poll?${new URLSearchParams(params)}`, {
      headers: { accept: "application/json", ...clientHeaders(), ...(jar.size ? { cookie: cookieHeader() } : {}) },
    }).then((res) => {
      const body = jsonOf(res.text)
      const state = res.headers.get("x-device-flow-state") ?? "-"
      say(label, claim, `${res.status} ${res.text.trim().slice(0, 40) || "(empty body)"} x-device-flow-state=${state}`)
    })
  await poll(
    { nonce, verifier, challenge_method: "S256" },
    "poll, three params",
    "404 {} (a wait, not a failure); the header is the gateway's own, CN sets it",
  )
  await poll(
    { nonce, verifier, challenge_method: "S256", client_id: WRAPPER_CLIENT },
    "poll + client_id",
    "400 INVALID_DEVICE_FLOW, reason=not_allowed",
  )
}

// 6. the global profile's API host: which prefix is mounted
console.log("\n== 6. openapi.qoder.sh mount points")
const poll = `nonce=${randomUUID()}&verifier=probe&challenge_method=S256`
for (const path of [`/api/v1/deviceToken/poll?${poll}`, "/device/selectAccounts", `/sash/api/v1/deviceToken/poll?${poll}`, "/sash/api/v1/adapter/user/account-context?include=user"]) {
  const res = await fetchWithTimeout(`${OPENAPI}${path}`, { headers: { accept: "application/json", ...clientHeaders() } })
  const body = jsonOf(res.text)
  const note = body?.code ? `${body.code}: ${body.message}` : body?.errorCode ? `${body.errorCode}: ${body.errorMessage}` : res.text.slice(0, 40)
  say(`GET ${path.split("?")[0]}`, path.startsWith("/sash") ? "mounted, wants a bearer token" : "unmounted (404)", `${res.status} ${note}`)
}
say("the entry's API host", GATEWAY, "openapi.qoder.sh serves no sign-in route; that is why it is not the API host")

// The refresh's pair decides which layer answers: the wrapper's pair reaches
// the issuer (a 401 that carries Ory's own invalid_grant upstream), the
// issuer's pair is refused by the gateway before it leaves (400
// INVALID_REFRESH_REQUEST, no upstream). So a renewal must carry the pair the
// wrapper minted with, not the one the issuer knows.
console.log("\n== 5a. the refresh pair, at the gateway")
for (const [label, pair] of [
  ["wrapper pair (cc65e5fc + qwenwork://)", { client_id: "cc65e5fc-05bd-4f5d-a4e8-0df19aa3d75a", redirect_uri: "qwenwork://" }],
  ["issuer pair (qwenwork-desktop-app + gateway callback)", { client_id: "qwenwork-desktop-app", redirect_uri: "https://gateway.qwenwork.ai/oauth/callback" }],
  ["no pair", {}],
]) {
  const res = await fetchWithTimeout(`${GATEWAY}/api/v1/deviceToken/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", ...clientHeaders() },
    body: JSON.stringify({ refresh_token: "probe", target: "c", ...pair }),
  })
  const body = jsonOf(res.text)
  const note = `${res.status} ${body?.errorCode ?? ""}${body?.upstreamError?.code ? ` upstream=${body.upstreamError.code}` : ""}`
  say(`POST refresh with ${label}`, pair.client_id ? (pair.client_id.startsWith("cc65") ? "reaches the issuer: the wrapper's pair" : "refused at the gateway, never reaches the issuer") : "also reaches the issuer", note.trim())
}

// the refresh and the wallets, on both hosts: only the wallets is missing
// from the gateway, which is why the entry names walletsHost for it and no
// refreshHost at all
console.log("\n== 6a. refresh and wallets, on both hosts")
for (const [label, path, init] of [
  ["POST /api/v1/deviceToken/refresh", "/api/v1/deviceToken/refresh", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ refresh_token: "probe", target: "c" }) }],
  ["GET /api/v1/adapter/user/wallets", "/api/v1/adapter/user/wallets", {}],
]) {
  for (const [host, hostLabel] of [[GATEWAY, "gateway.qwenwork.ai"], [OPENAPI, "openapi.qoder.sh"]]) {
    const res = await fetchWithTimeout(`${host}${path}`, { ...init, headers: { accept: "application/json", ...clientHeaders(), ...(init.headers ?? {}) } })
    const body = jsonOf(res.text)
    const note = body?.errorCode ? `${body.errorCode}: ${body.errorMessage}` : body?.code ? `${body.code}: ${body.message}` : res.text.slice(0, 30)
    const claim = host === OPENAPI
      ? path.includes("wallets") ? "served here — the entry's walletsHost" : "served here too (the entry keeps the gateway)"
      : path.includes("wallets") ? "404: not on the gateway" : "served here (401, not 404): the entry keeps it here"
    say(`${label} on ${hostLabel}`, claim, `${res.status} ${note}`)
  }
}

// the API host itself: the two paths every chat goes through, on both hosts.
// A 404 would say the host is wrong; a refusal that names the request says
// the route is there and only the request was refused. On qwenwork.ai's
// gateway the refusal is a plain 403; openapi.qoder.sh wraps the same 403
// in an SSE envelope (statusCodeValue 403), which is this package's client
// reading a streamed error — not a success.
console.log("\n== 6b. the chat paths, on both hosts")
for (const [host, label] of [[GATEWAY, "gateway.qwenwork.ai"], [OPENAPI, "openapi.qoder.sh"]]) {
  const models = await fetchWithTimeout(`${host}/algo/api/v2/model/list?Encode=1`, { headers: { accept: "application/json", ...clientHeaders() } })
  const modelsBody = jsonOf(models.text)
  say(`GET ${label}/algo/api/v2/model/list`, "mounted (an unsigned call is refused)", `${models.status} ${modelsBody?.code ? `${modelsBody.code}: ${modelsBody.message}` : models.text.slice(0, 30)}`)
  const chat = await fetchWithTimeout(`${host}/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`, {
    method: "POST",
    headers: { accept: "text/event-stream", "content-type": "application/json", ...clientHeaders() },
    body: JSON.stringify({}),
  })
  // the envelope's own status is the one that counts when it is streamed
  const enveloped = /"statusCodeValue":(\d+)/.exec(chat.text)?.[1]
  const refused = /"code":"(\d+)","message":"([^"]+)"/.exec(chat.text)
  say(
    `POST ${label}/algo/api/v2/…/agent_chat_generation`,
    "mounted: 403 Signature invalid, never 404",
    `${chat.status}${enveloped ? ` (envelope ${enveloped})` : ""} ${refused ? `${refused[1]}: ${refused[2]}` : chat.text.slice(0, 40)}`,
  )
}

// 7. the control: the public cloud's wrapper, whose pending answer is the same
console.log("\n== 7. control — the public cloud's wrapper, qwenwork.cn")
const cnPkce = pkce()
const cnQuery = new URLSearchParams({
  challenge: cnPkce.challenge,
  challenge_method: "S256",
  nonce: randomUUID(),
  machine_id: randomUUID(),
  client_id: "e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb",
  redirect_uri: "qwenwork-cn://",
})
const cn = await fetchWithTimeout(`https://gateway.qwenwork.cn/device/selectAccounts?${cnQuery}`, {
  headers: { accept: "text/html,*/*", ...clientHeaders() },
})
say("GET gateway.qwenwork.cn/device/selectAccounts", "302 to qwenwork.cn/oauth2/auth", `${cn.status} -> ${cn.location.slice(0, 80)}`)
const cnPoll = await fetchWithTimeout(
  `https://gateway.qwenwork.cn/api/v1/deviceToken/poll?${new URLSearchParams({ nonce: cnQuery.get("nonce"), verifier: cnPkce.verifier, challenge_method: "S256" })}`,
  { headers: { accept: "application/json", ...clientHeaders(), ...(jar.size ? { cookie: cookieHeader() } : {}) } },
)
say("poll, three params (CN control)", "404 {} + x-device-flow-state: pending", `${cnPoll.status} ${cnPoll.text.trim().slice(0, 40) || "(empty body)"} x-device-flow-state=${cnPoll.headers.get("x-device-flow-state") ?? "-"}`)

console.log("\ndone. no credential was sent, no sign-in was completed.")
