// One international sign-in, end to end, run by the person holding the
// account. It starts the wrapper's device flow, prints the page to sign in
// on, then polls the gateway until the browser authorizes — and finally
// asks every host the site names, with the token it got, so the two open
// questions answer themselves:
//
//   - which host the chat, the account-context and the wallets are on, and
//   - whether the poll needs the session the 302 handed out.
//
// Three steps, each its own run, because the sign-in happens in between and
// in a browser this process cannot drive:
//
//   node packages/qoder/tools/finish-qwenwork-intl.mjs start      # prints the URL
//   node packages/qoder/tools/finish-qwenwork-intl.mjs poll       # after you sign in
//   node packages/qoder/tools/finish-qwenwork-intl.mjs probe      # which host answers
//
// The state file (`--state`, default `qwenwork-intl-signin.json` in the
// current directory) holds the PKCE verifier, the nonce and, after poll, the
// token. It is a credential: the script never prints it, and `probe` removes
// it when it finishes. `poll --no-cookies` runs the same poll without the
// session, which is what the sign-in itself sends — comparing the two is the
// measurement for the cookie question.
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { readFileSync, writeFileSync, rmSync, existsSync } from "node:fs"

const GATEWAY = "https://gateway.qwenwork.ai"
const OPENAPI = "https://openapi.qoder.sh"
// the wrapper's own client and scheme: the only pair gateway.qwenwork.ai
// answers 302 for (qwenwork-desktop-app and the gateway callback are 400)
const WRAPPER_CLIENT = "cc65e5fc-05bd-4f5d-a4e8-0df19aa3d75a"
const WRAPPER_REDIRECT = "qwenwork://"
// the names the desktop app puts on its gateway calls
const APP = { version: "2.0.2", release: "2.0.2-26111211", build: "26111211" }
const clientHeaders = () => ({
  "User-Agent": `qoderwork/${APP.version}`,
  "X-Request-Id": randomUUID(),
  "X-QwenWork-Version": APP.version,
  "X-QwenWork-Release-Version": APP.release,
  "X-QwenWork-Build": APP.build,
  "X-QwenWork-Platform": process.platform,
  "X-QwenWork-Arch": process.arch,
  "X-QwenWork-Channel": "stable",
})

const b64url = (buf) => buf.toString("base64url")
const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const statePath = (() => {
  const at = args.indexOf("--state")
  return at >= 0 && args[at + 1] ? args[at + 1] : "qwenwork-intl-signin.json"
})()
const [mode] = args.filter((a) => !a.startsWith("--") && a !== statePath)

const load = () => (existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : null)
const save = (v) => writeFileSync(statePath, JSON.stringify(v), "utf8")

async function request(url, init = {}) {
  const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(20_000), ...init })
  const text = await res.text()
  return { status: res.status, headers: res.headers, location: res.headers.get("location") ?? "", text }
}

// the session a 302 hands out: acw_tc / cdn_sec_tc and anything else the
// gateway sets, kept as a cookie header for the poll
const cookiesOf = (res) => {
  const list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : []
  const jar = {}
  for (const line of list) {
    const [pair] = line.split(";")
    const at = pair.indexOf("=")
    if (at > 0) jar[pair.slice(0, at).trim()] = pair.slice(at + 1).trim()
  }
  return jar
}
const cookieHeader = (jar) => Object.entries(jar ?? {}).map(([k, v]) => `${k}=${v}`).join("; ")

async function start() {
  const verifier = b64url(randomBytes(64))
  const state = {
    verifier,
    challenge: b64url(createHash("sha256").update(verifier).digest()),
    nonce: randomUUID(),
    machineId: randomUUID(),
    startedAt: Date.now(),
  }
  const q = new URLSearchParams({
    challenge: state.challenge,
    challenge_method: "S256",
    nonce: state.nonce,
    machine_id: state.machineId,
    client_id: WRAPPER_CLIENT,
    redirect_uri: WRAPPER_REDIRECT,
  })
  const url = `${GATEWAY}/device/selectAccounts?${q}`
  // the wrapper is asked once, so the session it hands out is the one a real
  // sign-in would carry; the 302 is expected, and it is kept, not followed
  const res = await request(url, { headers: { accept: "text/html,*/*", ...clientHeaders() } })
  state.cookies = cookiesOf(res)
  save(state)
  console.log(`wrapper    ${res.status}${res.location ? ` -> ${res.location.slice(0, 120)}` : ""}`)
  if (res.status !== 302) {
    const body = (() => {
      try {
        return JSON.parse(res.text)
      } catch {
        return null
      }
    })()
    console.error(`不是 302：${body?.errorCode ?? ""} ${body?.details ? `${body.details.field}/${body.details.reason}` : res.text.slice(0, 160)}`)
    console.error("包装器只对 cc65e5fc-… + qwenwork:// 回 302；别的答案说明厂商侧改了。")
    process.exit(1)
  }
  console.log(`\n在这台机器的浏览器里打开并登录：\n\n  ${url}\n`)
  if (state.cookies && Object.keys(state.cookies).length) console.log(`会话已记下：${Object.keys(state.cookies).join(", ")}`)
  console.log(`状态存在 ${statePath}（含 verifier，登录完成后运行：node ${process.argv[1]} poll）`)
}

async function poll() {
  const state = load()
  if (!state?.nonce || !state?.verifier) throw new Error(`没有进行中的流程：先运行 node ${process.argv[1]} start`)
  const useCookies = !flag("--no-cookies")
  const cookie = useCookies ? cookieHeader(state.cookies) : ""
  const until = Date.now() + 15 * 60_000
  let last = ""
  for (;;) {
    if (Date.now() > until) throw new Error("超时：15 分钟内浏览器没有完成授权（重新 start 一次）")
    const res = await request(`${GATEWAY}/api/v1/deviceToken/poll?${new URLSearchParams({ nonce: state.nonce, verifier: state.verifier, challenge_method: "S256" })}`, {
      headers: { accept: "application/json", ...clientHeaders(), ...(cookie ? { cookie } : {}) },
    })
    const flowState = res.headers.get("x-device-flow-state") ?? "-"
    const body = (() => {
      try {
        return JSON.parse(res.text)
      } catch {
        return {}
      }
    })()
    const line = `${res.status} ${flowState}${body?.token ? ` token(${String(body.token).length})` : ""}`
    if (line !== last) {
      console.log(`${useCookies ? "with session" : "no cookies  "}  ${line}`)
      last = line
    }
    if (res.status === 200 && String(body?.token ?? "").trim()) {
      save({ ...state, token: body.token, refresh: body.refresh_token ?? "", gotAt: Date.now() })
      console.log(`\n拿到 token（长度 ${String(body.token).length}，未打印）`)
      console.log(`运行：node ${process.argv[1]} probe`)
      return
    }
    if (res.status === 400) {
      // a 400 here is the query being refused, not a wait: the three names
      // are the only ones the poll takes
      console.error(`\npoll 被拒：${body?.errorCode ?? ""} ${body?.details ? `${body.details.field}/${body.details.reason}` : ""}`)
      process.exit(1)
    }
    // 404 with an empty body is the gateway's "not yet", as on the public
    // cloud, where a pending flow answers the same 404
    await new Promise((r) => setTimeout(r, 2_000))
  }
}

async function probe() {
  const state = load()
  const token = String(state?.token ?? "")
  if (!token) throw new Error(`没有 token：先 start 再 poll`)
  // every route the site names, on both hosts, so the answer says which host
  // the site entry should carry for each — and the refusal is read as the
  // route being there (401/403) versus not (404)
  const routes = [
    { path: "/algo/api/v2/model/list?Encode=1", label: "model list" },
    { path: "/api/v1/adapter/user/account-context?include=user,plan,quota", label: "account-context" },
    { path: "/api/v1/adapter/user/wallets", label: "wallets" },
    { path: "/api/v1/userinfo", label: "user info" },
  ]
  const out = []
  for (const host of [GATEWAY, OPENAPI]) {
    for (const { path, label } of routes) {
      const res = await request(host + path, { headers: { accept: "application/json", Authorization: `Bearer ${token}`, ...clientHeaders() } })
      const note = res.text.trim().replace(/\s+/g, " ").slice(0, 100)
      const verdict = res.status === 404 ? "not here" : res.status === 200 ? "ANSWERS" : "mounted (refused)"
      out.push([host.replace("https://", ""), label, String(res.status), verdict, note])
    }
  }
  const w = [0, 1, 2, 3].map((i) => Math.max(...out.map((r) => r[i].length)))
  for (const row of out) console.log(row.map((cell, i) => cell.padEnd(w[i])).join("  "))
  console.log("")
  for (const { label } of routes) {
    const answers = out.filter((r) => r[1] === label && r[3] === "ANSWERS").map((r) => r[0])
    console.log(`${label.padEnd(16)} -> ${answers.length ? answers.join(", ") : "neither host answered with this token"}`)
  }
  // the token is a credential: it goes away once it has been read for this
  rmSync(statePath, { force: true })
  console.log(`\n${statePath} 已删除（里面的 token 不再保留）`)
}

try {
  if (mode === "start") await start()
  else if (mode === "poll") await poll()
  else if (mode === "probe") await probe()
  else {
    console.error(`用法: node ${process.argv[1]} start|poll|probe [--state <file>] [--no-cookies]`)
    process.exit(2)
  }
} catch (e) {
  console.error(e?.message ?? String(e))
  process.exit(1)
}