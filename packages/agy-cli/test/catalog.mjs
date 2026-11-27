// magpie-agy 模型目录回归（源自 configs 仓 test_agy_bridge_catalog.mjs）：目录刷新不得拖过 Magpie 的 2 秒 provider.models 超时，
// 失败不得冲掉已有动态目录，limit 元数据按家族给出，型号别名与 [1m] 剥除保持可用。
//
// 运行：bun test ./catalog.mjs（或在包目录 bun test）
// 全部经真实仓内 index.mjs 的 plugin.provider.models() / fetch 入口，边界替身见 testkit.mjs。

import { test } from "node:test"
import { tokenFile } from "../account.mjs"
import { DUE_FOR_RENEWAL } from "../usage.mjs"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  BASE_MODEL_ROWS, CATALOG_TTL_MS, MESSAGES_URL, baseBody, createBridgeKit, modelsOutput, readSse, sleep, tick,
} from "./testkit.mjs"

const FAST_BUDGET_MS = 750 // 计划给的调度容差；补丁内部等待预算是 500ms，远低于 Magpie 的 2s。
// 会话报出 agy 向本客户端开放的型号之前，只列 Gemini。
const FALLBACK_IDS = ["gemini-4-argon", "gemini-3.8-flash"]
const OFFERED_ALL = [
  ["gemini-4-argon-high", "Gemini 4 Argon (High)"], ["gemini-4-argon-low", "Gemini 4 Argon (Low)"],
  ["claude-sonnet-5-5-high", "Claude Sonnet 5.5 (High)"], ["claude-sonnet-5-5-low", "Claude Sonnet 5.5 (Low)"],
  ["gpt-oss-120b-medium", "GPT-OSS 120B (Medium)"],
]
const NOT_YET_OFFERED = ["claude-opus-5-5", "claude-sonnet-5-5", "gpt-oss-120b", "gpt-oss-120b-medium", "mystery-model"]
const DYNAMIC_ROWS = [...BASE_MODEL_ROWS, ["gemini-9-test-high", "Gemini 9 Test (High)"], ["gemini-9-test-low", "Gemini 9 Test (Low)"], ["mystery-model", "Mystery Model"]]
const DYNAMIC_OK = { stdout: modelsOutput(DYNAMIC_ROWS) }

async function withKit(options, fn) {
  const kit = await createBridgeKit(options)
  try {
    return await fn(kit)
  } finally {
    await kit.dispose()
  }
}

// agy -p /usage as the fake agy answers it: the quota of the account that
// run's agy reads, the kept home's token file under that home (accountEnv
// sets SSH_CONNECTION there), else agy's keyring (options.storedSignIn).
// asked gets each read's account; refuse(email) makes agy say its sign-in
// no longer works.
function usageThroughAgy(options, { asked, left = () => 0.9, refuse = () => false }) {
  const readBy = (opts) => {
    const home = opts?.env?.SSH_CONNECTION ? opts.env.HOME : null
    if (home) {
      try { return JSON.parse(fs.readFileSync(tokenFile(home), "utf8")).id_token_email } catch { return null }
    }
    return JSON.parse(Buffer.from(String(options.storedSignIn).trim().replace(/^go-keyring-base64:/, ""), "base64").toString()).id_token_email
  }
  return (_file, args, opts) => {
    if (args[0] === "--version") return { code: 0, stdout: "1.5.12\n" }
    if (args[0] !== "-p") return 1
    const email = readBy(opts)
    asked.push(email)
    if (refuse(email)) return { code: 1, stdout: "Error: oauth2: \"invalid_grant\" \"Token has been expired or revoked.\"\n" }
    return { code: 0, stdout: JSON.stringify({ status: "SUCCESS", command: { name: "usage", data: { groups: [{
      name: "Gemini Models", description: "Models within this group: Gemini 4 Argon",
      buckets: [{ id: "w", name: "Weekly Limit Remaining", window: "weekly", reset_time: "2026-11-22T00:00:00Z", remaining_fraction: left(email) }],
    }] } } }) }
  }
}

// the plugin asks Google nothing itself for usage: only agy does
function noFetch() {
  const fetched = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => { fetched.push(String(url)); throw new Error("no network in tests") }
  return { fetched, restore: () => { globalThis.fetch = realFetch } }
}

async function timed(fn) {
  const started = performance.now()
  const value = await fn()
  return { value, ms: performance.now() - started }
}

function ids(models) {
  return Object.keys(models).sort()
}

function assertFallbackPresent(models) {
  for (const id of FALLBACK_IDS) assert.ok(models[id], `目录缺少 ${id}`)
  for (const id of NOT_YET_OFFERED) assert.equal(models[id], undefined, `没有会话开放就列出了 ${id}`)
}

// 后台刷新结束（假子进程已关）且模块自己的定时器都已清掉。
async function settle(kit) {
  for (let i = 0; i < 20 && kit.children.size; i++) await sleep(10)
  await tick()
  await tick()
}

test("没有 agy 时直接给静态目录，不起子进程", async () => {
  await withKit({ agyPath: null }, async (kit) => {
    const { value, ms } = await timed(() => kit.models())
    assertFallbackPresent(value)
    assert.equal(kit.modelsSpawns.length, 0)
    assert.ok(ms < FAST_BUDGET_MS, `耗时 ${ms}ms`)
  })
})

// JZGiVvkSOA75376 on X: a signed-out agy opens Google's sign-in in the browser
// whenever it runs (on Windows through ShellExecuteW, past any BROWSER shim).
test("agy 没存登录时不在后台跑 agy models、不起探测会话，请求答需要重新登录", async () => {
  await withKit({ platform: "darwin", storedSignIn: "missing", modelsBehavior: DYNAMIC_OK }, async (kit) => {
    assertFallbackPresent(await kit.models())
    const warming = kit.plugin.provider.warming?.()
    if (warming) await warming
    await settle(kit)
    assert.equal(kit.modelsSpawns.length, 0, "没登录也跑了 agy models")
    assert.equal(kit.acpSpawns.length, 0, "没登录也起了探测会话")
    assert.ok(kit.execFiles.some(c => c.file === "/usr/bin/security" && c.args.includes("antigravity")))
    const response = await kit.request(baseBody())
    assert.equal(response.status, 401)
    assert.equal(response.headers.get("X-Magpie-Sign-In"), "expired")
    assert.match(await response.text(), /isn't signed in/)
    assert.equal(kit.acpSpawns.length, 0, "没登录也为请求起了 agy")
  })
  // 存着能续期的登录（access token 过期也一样）：照常列目录
  const value = "go-keyring-base64:" + Buffer.from(JSON.stringify({ token: { access_token: "a", refresh_token: "r", expiry: "2020-01-01T00:00:00Z" } })).toString("base64")
  await withKit({ platform: "darwin", storedSignIn: value + "\n", modelsBehavior: DYNAMIC_OK }, async (kit) => {
    await kit.models()
    const warming = kit.plugin.provider.warming?.()
    if (warming) await warming
    await settle(kit)
    assert.ok(kit.modelsSpawns.length >= 1, "有登录却没跑 agy models")
  })
})

// ownsh1p on X: two accounts in the local agy CLI, and the usage overview
// showed the first one's balance on both cards. Both were saved as agy's
// own (no home of their own: Switch to another Google account before
// 0.1.67, or a sign-in in a terminal), and agy's keyring holds one of
// them, so each read, and each request, was that one's.
test("an account of agy's own that agy no longer holds shows no other account's usage, nor sends as it", async () => {
  const keyring = email => "go-keyring-base64:" + Buffer.from(JSON.stringify({
    token: { access_token: "ya29." + email, refresh_token: "1//r", expiry: "0001-01-01T00:00:00Z" },
    auth_method: "consumer", id_token_email: email,
  })).toString("base64") + "\n"
  const asked = []
  const options = { platform: "darwin", storedSignIn: keyring("b@example.com"), modelsBehavior: DYNAMIC_OK }
  options.onSpawn = usageThroughAgy(options, { asked, left: email => email === "a@example.com" ? 0.9 : 0.25 })
  const net = noFetch()
  try {
    await withKit(options, async (kit) => {
      const a = { type: "oauth", key: "agy", metadata: { email: "a@example.com" } }
      const b = { type: "oauth", key: "agy", metadata: { email: "B@example.com" } }
      const ua = await kit.plugin.auth.usage(async () => a, {})
      assert.deepEqual(ua.windows, [], JSON.stringify(ua))
      assert.equal(ua.signIn, "expired")
      assert.match(ua.error, /signed in to another Google account now, not to a@example\.com/)
      assert.match(ua.error, /Add another Google account/)
      assert.deepEqual(asked, [], "a's card was read with b's sign-in")
      const ub = await kit.plugin.auth.usage(async () => b, {})
      assert.equal(ub.error, undefined, JSON.stringify(ub))
      assert.equal(ub.windows.find(w => !w.model)?.used, 75)
      assert.ok(asked.length > 0 && asked.every(h => h === "b@example.com"), JSON.stringify(asked))

      // a's requests would go out as b
      const la = await kit.plugin.auth.loader(async () => a)
      const refused = await la.fetch(MESSAGES_URL, { method: "POST", body: JSON.stringify(baseBody()) })
      assert.equal(refused.status, 401)
      assert.equal(refused.headers.get("X-Magpie-Sign-In"), "expired")
      assert.match(await refused.text(), /not to a@example\.com/)
      assert.equal(kit.acpSpawns.length, 0, "a's request ran agy")
      const lb = await kit.plugin.auth.loader(async () => b)
      const served = await lb.fetch(MESSAGES_URL, { method: "POST", body: JSON.stringify(baseBody()) })
      assert.notEqual(served.status, 401)
      await served.text()

      // agy holds a again (signed in to it in a terminal): a's card reads
      // a's quota, and says its sign-in works again
      options.storedSignIn = keyring("a@example.com")
      kit.clock.advance(60_000)
      asked.length = 0
      const again = await kit.plugin.auth.usage(async () => a, {})
      assert.equal(again.error, undefined, JSON.stringify(again))
      assert.equal(again.signIn, "renewed")
      assert.equal(again.windows.find(w => !w.model)?.used, 10)
      assert.ok(asked.length > 0 && asked.every(h => h === "a@example.com"), JSON.stringify(asked))
      // b was kept while agy held it: its card reads b's own quota now
      asked.length = 0
      const bNow = await kit.plugin.auth.usage(async () => b, {})
      assert.equal(bNow.error, undefined, JSON.stringify(bNow))
      assert.equal(bNow.windows.find(w => !w.model)?.used, 75)
      assert.ok(asked.length > 0 && asked.every(h => h === "b@example.com"), JSON.stringify(asked))
      assert.deepEqual(net.fetched, [], "usage asked Google itself")
      await settle(kit)
    })
  } finally {
    net.restore()
  }
})

// ownsh1p on X again (为什么不能两个都显示额度呢): an account of agy's own
// that agy held once keeps its own sign-in, so when agy holds another its
// card reads its own quota, and its requests run agy with its own sign-in,
// never the held one's. A kept sign-in Google no longer takes says to sign
// in again. agy's keyring is never written.
test("an account of agy's own that agy held once reads its own usage, and sends as itself, once agy holds another", async () => {
  const signIn = (email, expiry = "0001-01-01T00:00:00Z") => ({
    token: { access_token: "ya29." + email, refresh_token: "1//" + email, expiry },
    auth_method: "consumer", id_token_email: email,
  })
  const keyring = email => "go-keyring-base64:" + Buffer.from(JSON.stringify(signIn(email))).toString("base64") + "\n"
  const asked = []
  let refused = false
  const options = { platform: "darwin", storedSignIn: keyring("a@example.com"), modelsBehavior: DYNAMIC_OK }
  options.onSpawn = usageThroughAgy(options, {
    asked, left: email => email === "a@example.com" ? 0.9 : 0.25, refuse: email => refused && email === "a@example.com",
  })
  const net = noFetch()
  try {
    await withKit(options, async (kit) => {
      const a = { type: "oauth", key: "agy", metadata: { email: "A@example.com" } }
      const b = { type: "oauth", key: "agy", metadata: { email: "b@example.com" } }
      // agy holds a: a's card reads the keyring, and a is kept
      const first = await kit.plugin.auth.usage(async () => a, {})
      assert.equal(first.error, undefined, JSON.stringify(first))
      const ids = fs.readdirSync(path.join(kit.env.XDG_STATE_HOME, "magpie-agy-bridge", "accounts"))
      assert.equal(ids.length, 1)
      assert.match(ids[0], /^own[0-9a-f]{24}$/)
      const keptFile = path.join(kit.env.XDG_STATE_HOME, "magpie-agy-bridge", "accounts", ids[0], ".gemini", "antigravity-cli", "antigravity-oauth-token")
      assert.deepEqual(JSON.parse(fs.readFileSync(keptFile, "utf8")), signIn("a@example.com"))
      assert.equal(fs.statSync(keptFile).mode & 0o777, 0o600)

      // a sign-in in a terminal: agy holds b now
      options.storedSignIn = keyring("b@example.com")
      kit.clock.advance(60_000)
      asked.length = 0
      const ua = await kit.plugin.auth.usage(async () => a, {})
      assert.equal(ua.error, undefined, JSON.stringify(ua))
      assert.notEqual(ua.signIn, "expired")
      assert.equal(ua.windows.find(w => !w.model)?.used, 10)
      assert.ok(asked.length > 0 && asked.every(h => h === "a@example.com"), asked.join())
      asked.length = 0
      const ub = await kit.plugin.auth.usage(async () => b, {})
      assert.equal(ub.windows.find(w => !w.model)?.used, 75)
      assert.ok(asked.length > 0 && asked.every(h => h === "b@example.com"), asked.join())

      // a's request runs agy in a's kept home, b's in agy's own
      const la = await kit.plugin.auth.loader(async () => a)
      const served = await la.fetch(MESSAGES_URL, { method: "POST", body: JSON.stringify(baseBody()) })
      assert.notEqual(served.status, 401, await served.clone().text())
      await served.text()
      assert.ok(kit.acpSpawns.length > 0)
      assert.ok(kit.acpSpawns.every(s => s.env.HOME === path.dirname(path.dirname(path.dirname(keptFile)))), "a's request ran outside its kept home")
      const before = kit.acpSpawns.length
      const lb = await kit.plugin.auth.loader(async () => b)
      const servedB = await lb.fetch(MESSAGES_URL, { method: "POST", body: JSON.stringify(baseBody()) })
      await servedB.text()
      assert.ok(kit.acpSpawns.slice(before).every(s => s.env.HOME !== kit.acpSpawns[0].env.HOME), "b's request ran in a's kept home")

      // a's kept access token has ended: agy isn't run for usage (it renews
      // the token on a's next chat), and nobody asks Google
      fs.writeFileSync(keptFile, JSON.stringify(signIn("a@example.com", "2020-01-01T00:00:00Z")))
      kit.clock.advance(60_000)
      asked.length = 0
      const due = await kit.plugin.auth.usage(async () => a, {})
      assert.deepEqual(due.windows, [])
      assert.equal(due.error, DUE_FOR_RENEWAL)
      assert.notEqual(due.signIn, "expired")
      assert.deepEqual(asked, [])

      // agy says Google no longer takes a's kept sign-in: a's card says to sign in again
      fs.writeFileSync(keptFile, JSON.stringify(signIn("a@example.com", "2099-01-01T00:00:00Z")))
      refused = true
      kit.clock.advance(60_000)
      asked.length = 0
      const gone = await kit.plugin.auth.usage(async () => a, {})
      assert.deepEqual(gone.windows, [])
      assert.equal(gone.signIn, "expired")
      assert.match(gone.error, /not to A@example\.com/)
      assert.deepEqual(asked, ["a@example.com"])
      // agy's keyring was only read
      assert.ok(kit.execFiles.every(c => c.file !== "/usr/bin/security" || c.args[0] === "find-generic-password"))
      assert.deepEqual(net.fetched, [], "usage asked Google itself")
      await settle(kit)
    })
  } finally {
    net.restore()
  }
})

// mayne_wong on X: magpie's gateway run as a LaunchDaemon searches only
// System.keychain, so agy's sign-in in the login keychain reads as none
// there (44) while the window reads it. An account of agy's own the window
// kept runs in its kept home there; one it never kept is told why, not to
// sign in again (which the window answered with "already signed in").
test("out of the login keychain's reach (a LaunchDaemon), an account of agy's own runs with the sign-in the window kept", async () => {
  const signIn = (email) => ({
    token: { access_token: "ya29." + email, refresh_token: "1//" + email, expiry: "0001-01-01T00:00:00Z" },
    auth_method: "consumer", id_token_email: email,
  })
  const asked = []
  const options = {
    platform: "darwin", modelsBehavior: DYNAMIC_OK,
    storedSignIn: "go-keyring-base64:" + Buffer.from(JSON.stringify(signIn("a@example.com"))).toString("base64") + "\n",
  }
  options.onSpawn = usageThroughAgy(options, { asked })
  const net = noFetch()
  try {
    await withKit(options, async (kit) => {
      const a = { type: "oauth", key: "agy", metadata: { email: "a@example.com" } }
      const b = { type: "oauth", key: "agy", metadata: { email: "b@example.com" } }
      // the window, in the login session: a is read from the keyring, and kept
      const first = await kit.plugin.auth.usage(async () => a, {})
      assert.equal(first.error, undefined, JSON.stringify(first))
      const accounts = path.join(kit.env.XDG_STATE_HOME, "magpie-agy-bridge", "accounts")
      const keptHome = path.join(accounts, fs.readdirSync(accounts)[0])

      // the gateway, as a LaunchDaemon: the login keychain is there, but not searched
      fs.mkdirSync(path.join(kit.env.HOME, "Library", "Keychains"), { recursive: true })
      fs.writeFileSync(path.join(kit.env.HOME, "Library", "Keychains", "login.keychain-db"), "")
      options.storedSignIn = "missing"
      options.keychains = '    "/Library/Keychains/System.keychain"\n'
      kit.clock.advance(60_000)
      asked.length = 0
      const ua = await kit.plugin.auth.usage(async () => a, {})
      assert.equal(ua.error, undefined, JSON.stringify(ua))
      assert.equal(ua.windows.find(w => !w.model)?.used, 10)
      assert.ok(asked.length > 0 && asked.every(h => h === "a@example.com"), asked.join())
      const la = await kit.plugin.auth.loader(async () => a)
      const served = await la.fetch(MESSAGES_URL, { method: "POST", body: JSON.stringify(baseBody()) })
      assert.notEqual(served.status, 401, await served.clone().text())
      await served.text()
      assert.ok(kit.acpSpawns.length > 0)
      assert.ok(kit.acpSpawns.every(s => s.env.HOME === keptHome), "a's request ran outside its kept home")

      // b was never kept: told why, not to sign in again
      const before = kit.acpSpawns.length
      const lb = await kit.plugin.auth.loader(async () => b)
      const refused = await lb.fetch(MESSAGES_URL, { method: "POST", body: JSON.stringify(baseBody()) })
      assert.equal(refused.status, 401)
      const why = await refused.text()
      assert.match(why, /LaunchDaemon/)
      assert.match(why, /magpie daemon install/)
      assert.doesNotMatch(why, /sign in again in magpie/)
      assert.equal(kit.acpSpawns.length, before, "agy was run where it can't read its sign-in")
      const ub = await kit.plugin.auth.usage(async () => b, {})
      assert.equal(ub.signIn, "expired")
      assert.match(ub.error, /LaunchDaemon/)
      assert.doesNotMatch(ub.error, /Sign in again/)
      // the keychain was only read
      assert.ok(kit.execFiles.every(c => c.file !== "/usr/bin/security" || ["find-generic-password", "list-keychains"].includes(c.args[0])))
      assert.deepEqual(net.fetched, [], "usage asked Google itself")
      await settle(kit)
    })
  } finally {
    net.restore()
  }
})

// The first request after a start, before anything read agy's keyring,
// isn't sent as the account agy holds either.
test("an account of agy's own: the first request after a start waits for the keyring read", async () => {
  const keyring = "go-keyring-base64:" + Buffer.from(JSON.stringify({
    token: { access_token: "ya29.b", refresh_token: "1//b", expiry: "0001-01-01T00:00:00Z" },
    auth_method: "consumer", id_token_email: "b@example.com",
  })).toString("base64") + "\n"
  await withKit({ platform: "darwin", storedSignIn: keyring, modelsBehavior: DYNAMIC_OK }, async (kit) => {
    const la = await kit.plugin.auth.loader(async () => ({ type: "oauth", key: "agy", metadata: { email: "a@example.com" } }))
    const refused = await la.fetch(MESSAGES_URL, { method: "POST", body: JSON.stringify(baseBody()) })
    assert.equal(refused.status, 401)
    assert.match(await refused.text(), /not to a@example\.com/)
    assert.equal(kit.acpSpawns.length, 0, "a's first request ran agy as b")
    await settle(kit)
  })
})

// plugins#1599 (RainintoWine, Windows, agy 1.5.18): two accounts of agy's
// own, each kept (own<hash> holds its own sign-in), and agy's keyring held
// a banned account's token with no id_token_email in it. Whose it was
// couldn't be told, so it was taken for each account's own: both cards
// showed one quota to the minute, and every request went out as the banned
// account (403 ToS) whichever account magpie switched to.
const KEPT = (env, email) => path.join(env.XDG_STATE_HOME, "magpie-agy-bridge", "accounts",
  "own" + createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 24))
const signInOf = (email, extra = {}) => ({
  token: { access_token: "ya29." + email, refresh_token: "1//" + email, expiry: "2099-01-01T00:00:00Z", token_type: "Bearer" },
  auth_method: "consumer", id_token_email: email, ...extra,
})
function writeSignIn(home, value) {
  fs.mkdirSync(path.dirname(tokenFile(home)), { recursive: true })
  fs.writeFileSync(tokenFile(home), JSON.stringify(value), { mode: 0o600 })
}
// agy 1.5.18's /usage, as the account the run's agy reads: a home's token
// file (accountEnv), else the keyring, which is banned@'s
function usageByAccount(asked) {
  return (_file, args, opts) => {
    if (args[0] === "--version") return { code: 0, stdout: "1.5.18\n" }
    if (args[0] !== "-p") return 1
    const home = opts?.env?.SSH_CONNECTION ? opts.env.HOME : null
    const email = home ? JSON.parse(fs.readFileSync(tokenFile(home), "utf8")).id_token_email : "banned@example.com"
    asked.push(email)
    const left = { "a@example.com": 0.9, "b@example.com": 0.25 }[email] ?? 0.5
    return { code: 0, stdout: JSON.stringify({ status: "SUCCESS", command: { name: "usage", data: { groups: [{
      name: "Gemini Models", description: "Models within this group: Gemini 4 Argon",
      buckets: [{ id: "w", name: "Weekly Limit Remaining", window: "weekly", reset_time: "2026-11-22T00:00:00Z", remaining_fraction: left }],
    }] } } }) }
  }
}
// Windows Credential Manager's gemini:antigravity as the plugin's
// PowerShell reads it
const windowsKeyring = value => "OK " + Buffer.from(JSON.stringify(value)).toString("base64") + "\r\n"
const UNNAMED = [["id_token_email empty", { id_token_email: "" }], ["id_token_email missing", { id_token_email: undefined }]]

for (const [shape, unnamed] of UNNAMED) {
  test(`#1599 agy's sign-in names no account (${shape}): each account of agy's own runs with its own kept sign-in`, async () => {
    const asked = []
    const options = {
      platform: "win32", modelsBehavior: DYNAMIC_OK, onSpawn: usageByAccount(asked),
      storedSignIn: windowsKeyring(signInOf("banned@example.com", unnamed)),
    }
    const net = noFetch()
    try {
      await withKit(options, async (kit) => {
        writeSignIn(KEPT(kit.env, "a@example.com"), signInOf("a@example.com"))
        writeSignIn(KEPT(kit.env, "b@example.com"), signInOf("b@example.com"))
        const bannedHome = path.join(kit.env.XDG_STATE_HOME, "magpie-agy-bridge", "accounts", "915399657c1c4d17")
        writeSignIn(bannedHome, signInOf("banned@example.com"))
        const a = { type: "oauth", key: "agy", metadata: { email: "a@example.com" } }
        const b = { type: "oauth", key: "agy", metadata: { email: "b@example.com" } }

        const ua = await kit.plugin.auth.usage(async () => a, {})
        assert.equal(ua.error, undefined, JSON.stringify(ua))
        assert.equal(ua.windows.find(w => !w.model)?.used, 10)
        assert.ok(asked.length > 0 && asked.every(e => e === "a@example.com"), `a's card was read as ${asked.join()}`)
        asked.length = 0
        const ub = await kit.plugin.auth.usage(async () => b, {})
        assert.equal(ub.error, undefined, JSON.stringify(ub))
        assert.equal(ub.windows.find(w => !w.model)?.used, 75)
        assert.ok(asked.length > 0 && asked.every(e => e === "b@example.com"), `b's card was read as ${asked.join()}`)

        for (const [account, email] of [[a, "a@example.com"], [b, "b@example.com"]]) {
          const before = kit.acpSpawns.length
          const loaded = await kit.plugin.auth.loader(async () => account)
          const served = await loaded.fetch(MESSAGES_URL, { method: "POST", body: JSON.stringify(baseBody()) })
          assert.notEqual(served.status, 401, await served.clone().text())
          await served.text()
          const ran = kit.acpSpawns.slice(before)
          assert.ok(ran.length > 0)
          assert.ok(ran.every(s => s.env.HOME === KEPT(kit.env, email) && s.env.SSH_CONNECTION), `${email}'s request ran outside its kept home`)
        }
        // agy's keyring was only read
        assert.ok(kit.execFiles.every(c => c.file === "powershell.exe"), kit.execFiles.map(c => c.file).join())
        assert.deepEqual(net.fetched, [], "the plugin asked Google itself")
        await settle(kit)
      })
    } finally {
      net.restore()
    }
  })
}

// The same keyring, and one account of agy's own was never kept: its
// usage, requests, models and search are refused with why, never run as
// the keyring's. One saved without its email is refused too. A lone
// account of agy's own runs as agy's sign-in, as it always did: it is the
// only account that sign-in can be.
test("#1599 agy's sign-in names no account: an account of agy's own with nothing kept is refused beside another", async () => {
  const asked = []
  const options = {
    platform: "darwin", modelsBehavior: DYNAMIC_OK, onSpawn: usageByAccount(asked),
    storedSignIn: "go-keyring-base64:" + Buffer.from(JSON.stringify(signInOf("banned@example.com", { id_token_email: undefined }))).toString("base64") + "\n",
  }
  const net = noFetch()
  try {
    await withKit(options, async (kit) => {
      writeSignIn(KEPT(kit.env, "b@example.com"), signInOf("b@example.com"))
      const a = { type: "oauth", key: "agy", metadata: { email: "a@example.com" } }
      const unnamed = { type: "oauth", key: "agy" }
      for (const account of [a, unnamed]) {
        const who = account.metadata?.email ?? "this account"
        const u = await kit.plugin.auth.usage(async () => account, {})
        assert.deepEqual(u.windows, [], JSON.stringify(u))
        assert.equal(u.signIn, "expired")
        assert.match(u.error, /doesn't say which Google account it is/)
        assert.ok(u.error.includes(`Sign ${who} in again with "Add another Google account"`), u.error)
        const loaded = await kit.plugin.auth.loader(async () => account)
        const refused = await loaded.fetch(MESSAGES_URL, { method: "POST", body: JSON.stringify(baseBody()) })
        assert.equal(refused.status, 401)
        assert.equal(refused.headers.get("X-Magpie-Sign-In"), "expired")
        assert.match(await refused.text(), /doesn't say which Google account it is/)
        const listed = await kit.plugin.provider.models(undefined, { auth: account }).then(() => null, e => e)
        assert.match(listed?.message ?? "", /doesn't say which Google account it is/)
        const searched = await kit.plugin.search.agy.execute({ query: "magpie" }, { getAuth: async () => account }).then(() => null, e => e)
        assert.equal(searched?.statusCode ?? searched?.status, 401, String(searched))
      }
      assert.deepEqual(asked, [], "a refused account was read as the keyring's")
      assert.equal(kit.acpSpawns.length, 0, "a refused account ran agy")
      assert.equal(kit.modelsSpawns.length, 0, "a refused account listed the keyring's models")
      // no account named at all (OpenCode's catalog): agy's own list, as before
      assert.ok(Object.keys(await kit.models()).length > 0)
      assert.deepEqual(net.fetched, [])
      await settle(kit)
    })
    // a lone account of agy's own: agy's sign-in, as before
    asked.length = 0
    await withKit(options, async (kit) => {
      const a = { type: "oauth", key: "agy", metadata: { email: "a@example.com" } }
      const u = await kit.plugin.auth.usage(async () => a, {})
      assert.equal(u.error, undefined, JSON.stringify(u))
      assert.ok(asked.length > 0 && asked.every(e => e === "banned@example.com"), asked.join())
      const loaded = await kit.plugin.auth.loader(async () => a)
      const served = await loaded.fetch(MESSAGES_URL, { method: "POST", body: JSON.stringify(baseBody()) })
      assert.notEqual(served.status, 401, await served.clone().text())
      await served.text()
      assert.ok(kit.acpSpawns.length > 0 && kit.acpSpawns.every(s => !s.env.SSH_CONNECTION))
      await settle(kit)
    })
  } finally {
    net.restore()
  }
})

// How two accounts came to share agy's keyring: "Sign in with Google" saved
// whichever account agy held as agy's own, a second time too. Beside
// another account of agy's own, the account signed in gets a home of its
// own, with a copy of agy's sign-in, and runs there.
test("#1599 signed in beside another account of agy's own, an account gets a home of its own", async () => {
  const held = signInOf("b@example.com")
  const options = {
    platform: "darwin", modelsBehavior: DYNAMIC_OK,
    storedSignIn: "go-keyring-base64:" + Buffer.from(JSON.stringify(held)).toString("base64") + "\n",
  }
  const net = noFetch()
  try {
    await withKit(options, async (kit) => {
      // a is an account of agy's own magpie has
      await kit.plugin.auth.loader(async () => ({ type: "oauth", key: "agy", metadata: { email: "a@example.com" } }))
      const started = await kit.plugin.auth.methods[0].authorize()
      assert.equal(started.method, "auto")
      const done = await started.callback()
      assert.equal(done.type, "success", JSON.stringify(done))
      assert.match(done.key, /^agy:[0-9a-f]{16}$/)
      const id = done.key.slice(4)
      assert.deepEqual(done.metadata, { email: "b@example.com", agyHome: id })
      const home = path.join(kit.env.XDG_STATE_HOME, "magpie-agy-bridge", "accounts", id)
      assert.deepEqual(JSON.parse(fs.readFileSync(tokenFile(home), "utf8")), held)
      if (process.platform !== "win32") assert.equal(fs.statSync(tokenFile(home)).mode & 0o777, 0o600)
      // b's requests run there
      const before = kit.acpSpawns.length
      const loaded = await kit.plugin.auth.loader(async () => done)
      const served = await loaded.fetch(MESSAGES_URL, { method: "POST", body: JSON.stringify(baseBody()) })
      assert.notEqual(served.status, 401, await served.clone().text())
      await served.text()
      assert.ok(kit.acpSpawns.slice(before).every(s => s.env.HOME === home && s.env.SSH_CONNECTION))
      assert.ok(kit.execFiles.every(c => c.file !== "/usr/bin/security" || c.args[0] === "find-generic-password"))
      await warmed(kit)
    })
  } finally {
    net.restore()
  }
})

test("首次 agy models 卡死时 750ms 内返回非空静态目录", async () => {
  await withKit({ modelsBehavior: { hang: true } }, async (kit) => {
    const { value, ms } = await timed(() => kit.models())
    assert.ok(ms < FAST_BUDGET_MS, `首次目录耗时 ${Math.round(ms)}ms，超过 ${FAST_BUDGET_MS}ms`)
    assertFallbackPresent(value)
    assert.equal(kit.modelsSpawns.length, 1)
    assert.equal(kit.timers.refed().length, 0, "agy models 卡死期间不应有挂住 Node 退出的模块定时器")
    await kit.finishChildren()
    assert.equal(kit.timers.refed().length, 0, "子进程结束后不应残留挂住退出的定时器")
    // 探测一起就在 warming() 里：等它跑完再数，不靠固定时长。
    const warming = kit.plugin.provider.warming?.()
    if (warming) await warming
    await settle(kit)
    assert.equal(kit.acpSpawns.length, 0, "agy models 没答出来时不应起探测会话")
  })
})

test("首次快速成功时直接拿到动态目录", async () => {
  await withKit({ modelsBehavior: DYNAMIC_OK }, async (kit) => {
    const models = await kit.models()
    assert.ok(models["gemini-9-test"], "动态独有家族未出现在目录")
    assert.deepEqual(models["gemini-9-test"].variants && Object.keys(models["gemini-9-test"].variants).sort(), ["high", "low"])
    assert.equal(models["mystery-model"], undefined, "没有会话开放的非 Gemini 型号不应列出")
  })
})

test("会话开放的型号才列出：不等请求，探测会话就列出 Claude、GPT-OSS 和 agy models 没列的型号", async () => {
  await withKit({ modelsBehavior: DYNAMIC_OK, offeredModels: [
    ["gemini-4-argon-high", "Gemini 4 Argon (High)"], ["gemini-4-argon-low", "Gemini 4 Argon (Low)"],
    ["claude-opus-5-5-high", "Claude Opus 5.5 (High)"], ["claude-opus-5-5-low", "Claude Opus 5.5 (Low)"],
    ["gpt-oss-120b-medium", "GPT-OSS 120B (Medium)"], ["offered-only", "Offered Only"],
  ] }, async (kit) => {
    await kit.models()
    await settle(kit)
    const after = await kit.models()
    assert.deepEqual(Object.keys(after["claude-opus-5-5"]?.variants ?? {}).sort(), ["high", "low"])
    assert.deepEqual(JSON.parse(JSON.stringify(after["claude-opus-5-5"].limit)), { context: 1000000, output: 64000 })
    assert.deepEqual(JSON.parse(JSON.stringify(after["gpt-oss-120b"]?.limit ?? null)), { context: 131072, output: 32768 })
    assert.ok(after["offered-only"], "会话开放而 agy models 没列的型号应列出")
    assert.equal(after["claude-sonnet-5-5"], undefined, "agy models 列出但会话没开放的型号不应列出")
    assert.equal(after["gemini-3.8-flash"], undefined, "会话没开放的 Gemini 也不应列出")
    assert.equal(after["mystery-model"], undefined)
    assert.ok(after["gemini-4-argon"])
    // 探测只开会话、不发 prompt，用插件自己的名字，进程跑完就关。
    assert.equal(kit.acpLog.filter(entry => entry.method === "session/prompt").length, 0, "探测不应发 prompt")
    assert.equal(kit.acpLog.filter(entry => entry.method === "session/new").length, 1)
    assert.equal(kit.acpLog.find(entry => entry.method === "initialize")?.params?.clientInfo?.name, "opencode-agy-cli-auth")
    assert.deepEqual(kit.acpSpawns.map(spawn => spawn.args), [["acp"]])
    assert.equal(kit.children.size, 0, "探测的 agy acp 应已退出")
    // 已知开放什么之后不再探测。
    kit.clock.advance(CATALOG_TTL_MS)
    await kit.models()
    await settle(kit)
    assert.equal(kit.acpSpawns.length, 1)
  })
})

test("探测会话失败（agy 要求登录）时只列 Gemini，限流后再试，成功即列出", async () => {
  await withKit({ modelsBehavior: DYNAMIC_OK, sessionNewError: { code: -32000, message: "Authentication required" }, offeredModels: [
    ["gemini-4-argon-high", "Gemini 4 Argon (High)"], ["claude-opus-5-5-high", "Claude Opus 5.5 (High)"], ["claude-opus-5-5-low", "Claude Opus 5.5 (Low)"],
  ] }, async (kit) => {
    await kit.models()
    await settle(kit)
    const failed = await kit.models()
    assert.equal(failed["claude-opus-5-5"], undefined)
    assert.ok(failed["gemini-4-argon"])
    assert.equal(kit.children.size, 0, "失败的探测也应关掉 agy acp")
    assert.equal(kit.acpSpawns.length, 1, "一分钟内不再探测")
    kit.sessionNewError = null
    kit.clock.advance(60_000)
    await kit.models()
    // 新鲜目录不等探测：等它起来并跑完。
    for (let i = 0; i < 200 && kit.acpSpawns.length < 2; i++) await sleep(5)
    await settle(kit)
    assert.equal(kit.acpSpawns.length, 2)
    const listed = await kit.models()
    assert.deepEqual(Object.keys(listed["claude-opus-5-5"]?.variants ?? {}).sort(), ["high", "low"])
  })
})

test("会话后来开放的型号变了，目录随之更新", async () => {
  await withKit({ modelsBehavior: DYNAMIC_OK, offeredModels: [["gemini-4-argon-high", "Gemini 4 Argon (High)"], ["gemini-4-argon-low", "Gemini 4 Argon (Low)"]] }, async (kit) => {
    await kit.models()
    await settle(kit)
    assert.equal((await kit.models())["claude-opus-5-5"], undefined)
    kit.offeredModels = [["gemini-4-argon-high", "Gemini 4 Argon (High)"], ["claude-opus-5-5-high", "Claude Opus 5.5 (High)"], ["claude-opus-5-5-low", "Claude Opus 5.5 (Low)"]]
    kit.defaultPrompt = async (agent) => {
      await agent.text("ok")
      return { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 1 } }
    }
    const parsed = await readSse(await kit.request(baseBody({ model: "agy-cli/gemini-4-argon", tools: [], messages: [{ role: "user", content: "hi" }] })))
    assert.equal(parsed.error, null, JSON.stringify(parsed.error))
    assert.ok((await kit.models())["claude-opus-5-5"])
  })
})

test("图片模型不进聊天目录：buildModelCatalog 排除 gemini-3.1-flash-image", async () => {
  await withKit({}, async (kit) => {
    const build = kit.module.__agyTestBuildModelCatalog
    const catalog = build([
      { id: "gemini-3.1-flash-image", name: "Gemini 3.1 Flash Image" },
      { id: "gemini-3.1-flash-image-high", name: "Gemini 3.1 Flash Image (High)", effort: "high" },
      { id: "gemini-3.1-flash-image-low", name: "Gemini 3.1 Flash Image (Low)", effort: "low" },
      { id: "gemini-4-argon-high", name: "Gemini 4 Argon (High)", effort: "high" },
      { id: "gemini-4-argon-low", name: "Gemini 4 Argon (Low)", effort: "low" },
    ])
    assert.equal(catalog.models.find(model => model.id === "gemini-3.1-flash-image"), undefined, "图片模型进了聊天目录")
    assert.equal(catalog.rawIds.has("gemini-3.1-flash-image"), false, "图片模型进了路由目录")
    assert.equal(catalog.routes.has("gemini-3.1-flash-image"), false, "图片模型进了路由")
    assert.ok(catalog.models.find(model => model.id === "gemini-4-argon"), "正常型号被误删")
  })
})

// #1064（hiee3）：真实登录的 agy 上 `agy models` 约 4.4s、agy acp 开会话约 3s，都远过 500ms 的快速等待。
// 这里各模拟 1.5s：第一次 models() 只能给静态目录，但列表一到就该起探测，
// 后台跑完后的第一次 models() 就要有 Claude 和 GPT-OSS，不该要第三次。
const SLOW_MS = 1_500
const OFFERED_CLAUDE = [
  ["gemini-4-argon-high", "Gemini 4 Argon (High)"], ["gemini-4-argon-low", "Gemini 4 Argon (Low)"],
  ["claude-opus-5-5-high", "Claude Opus 5.5 (High)"], ["claude-opus-5-5-low", "Claude Opus 5.5 (Low)"],
  ["claude-sonnet-5-5-high", "Claude Sonnet 5.5 (High)"], ["claude-sonnet-5-5-low", "Claude Sonnet 5.5 (Low)"],
  ["gpt-oss-120b-medium", "GPT-OSS 120B (Medium)"],
]
const SLOW_AGY = { modelsBehavior: { stdout: modelsOutput(BASE_MODEL_ROWS), delayMs: SLOW_MS }, sessionNewDelayMs: SLOW_MS, offeredModels: OFFERED_CLAUDE }

// 等后台的列表与探测都结束：等状态（没有在跑的假子进程，且插件说没有在热身），不等固定时长。
async function warmed(kit) {
  const warming = kit.plugin.provider.warming?.()
  if (warming) await warming
  for (let i = 0; i < 1000 && kit.children.size; i++) await sleep(10)
  await settle(kit)
}

function assertClaudeListed(models, label) {
  for (const id of ["claude-opus-5-5", "claude-sonnet-5-5", "gpt-oss-120b"]) assert.ok(models[id], `${label}：没有 ${id}，只有 ${ids(models).join(", ")}`)
}

test("#1064 慢 agy：第一次 models() 给静态目录，后台热身后的第一次就列出 Claude 和 GPT-OSS", async () => {
  await withKit(SLOW_AGY, async (kit) => {
    const { value: first, ms } = await timed(() => kit.models())
    assert.ok(ms < FAST_BUDGET_MS, `首次目录耗时 ${Math.round(ms)}ms`)
    assertFallbackPresent(first)
    await warmed(kit)
    assert.equal(kit.acpSpawns.length, 1, "列表一到就该起一次探测会话")
    const { value: after, ms: warmMs } = await timed(() => kit.models())
    assert.ok(warmMs < 100, `热身后的目录耗时 ${Math.round(warmMs)}ms`)
    assertClaudeListed(after, "热身后的第一次 models()")
    assert.equal(kit.modelsSpawns.length, 1)
    assert.equal(kit.acpSpawns.length, 1)
    assert.equal(kit.plugin.provider.warming(), null, "热身完了不该还说在热身")
  })
})

// #1086（yinbing-666）：重启后在 agy 再次回答前，也该列出上次的完整目录，而不是只有 Gemini。
// 重启后 agy 回答了也要再探测一次保存的开放型号（shenggxhz），多一次 1.5s 的慢会话，所以给 15s。
test("#1086 重启后第一次 models() 就给上次 agy 列出并开放的目录，坏文件和别的 agy 仍给静态目录", { timeout: 15_000 }, async () => {
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), "agy-catalog-saved-"))
  try {
    const agy = path.join(shared, process.platform === "win32" ? "agy.exe" : "agy")
    fs.writeFileSync(agy, "#!/bin/sh\nexit 99\n", { mode: 0o755 })
    const env = { XDG_STATE_HOME: path.join(shared, "state") }
    await withKit({ ...SLOW_AGY, agyPath: agy, env }, async (kit) => {
      assertFallbackPresent(await kit.models())
      await warmed(kit)
      assertClaudeListed(await kit.models(), "第一次运行")
    })
    const file = path.join(shared, "state", "magpie-agy-bridge", "models.json")
    const saved = fs.readFileSync(file, "utf8")
    assert.match(saved, /claude-sonnet-5-5-high/)

    // 重启：agy 还是慢，第一次 models() 就该有 Claude；探测等 agy models 回答后才起。
    await withKit({ ...SLOW_AGY, agyPath: agy, env }, async (kit) => {
      const { value: first, ms } = await timed(() => kit.models())
      assert.ok(ms < FAST_BUDGET_MS, `重启后首次目录耗时 ${Math.round(ms)}ms`)
      assertClaudeListed(first, "重启后第一次")
      assert.equal(kit.acpSpawns.length, 0, "agy models 回答前不该起探测会话")
      assert.equal(kit.modelsSpawns.length, 1, "保存的目录也要再问一次 agy")
      await warmed(kit)
      assert.equal(kit.acpSpawns.length, 1, "agy 回答后，保存的开放型号也要再探测一次")
    })

    // 另一个 agy 可执行文件不用这份目录。
    await withKit({ ...SLOW_AGY, env }, async (kit) => {
      assertFallbackPresent(await kit.models())
      await warmed(kit)
    })

    // 半截文件：当作不知道，给静态目录。
    fs.writeFileSync(file, saved.slice(0, Math.floor(saved.length / 2)))
    await withKit({ ...SLOW_AGY, agyPath: agy, env }, async (kit) => {
      assertFallbackPresent(await kit.models())
      await warmed(kit)
    })
  } finally {
    fs.rmSync(shared, { recursive: true, force: true })
  }
})

test("#1064 慢 agy：已登录时 authorize 读到的列表和探测就是目录，紧接着的 models() 不再是静态目录", async () => {
  await withKit(SLOW_AGY, async (kit) => {
    const { value: started, ms } = await timed(() => kit.plugin.auth.methods[0].authorize())
    assert.equal(started.method, "auto")
    assert.ok(ms < SLOW_MS * 2 + 3_000, `登录检查耗时 ${Math.round(ms)}ms`)
    assert.equal((await started.callback()).type, "success")
    const { value: listed, ms: listMs } = await timed(() => kit.models())
    assert.ok(listMs < 100, `登录后的目录耗时 ${Math.round(listMs)}ms`)
    assertClaudeListed(listed, "登录后的第一次 models()")
    assert.equal(kit.modelsSpawns.length, 1, "登录检查读过的列表不该再读一遍")
    assert.equal(kit.acpSpawns.length, 1)
  })
})

test("#1064 登录检查不为探测等太久：会话一直不答时最多多等几秒", async () => {
  // 会话 60s 才答：authorize 只等探测约 3s，不该等到会话答（#1089：上界不留 1s 那么窄的余量）。
  // 下界是计时器，只会晚到不会早到，负载下也不会误报。
  const SESSION_MS = 60_000
  await withKit({ ...SLOW_AGY, sessionNewDelayMs: SESSION_MS }, async (kit) => {
    const { value: started, ms } = await timed(() => kit.plugin.auth.methods[0].authorize())
    assert.equal(started.method, "auto")
    assert.equal(kit.acpSpawns.length, 1, "登录检查该起探测会话")
    assert.ok(ms < SESSION_MS / 2, `登录检查等了会话（${Math.round(ms)}ms）`)
    assert.ok(ms >= SLOW_MS + 2_500, `登录检查没等探测（${Math.round(ms)}ms）`)
    const models = await kit.models()
    assert.ok(models["gemini-4-argon"])
    assert.equal(models["claude-opus-5-5"], undefined, "探测没答前不该列出 Claude")
  })
})

test("#1064 agyPath 变了，旧 agy 开放的型号不再列出，新 agy 重新探测", async () => {
  await withKit({ modelsBehavior: DYNAMIC_OK, offeredModels: OFFERED_CLAUDE }, async (kit) => {
    await kit.models()
    await warmed(kit)
    assertClaudeListed(await kit.models(), "agy-a")
    kit.env.AGY_PATH = kit.makeFakeAgy("agy-b")
    kit.offeredModels = [["gemini-4-argon-high", "Gemini 4 Argon (High)"], ["gemini-4-argon-low", "Gemini 4 Argon (Low)"]]
    const switched = await kit.models()
    assert.deepEqual(ids(switched).filter(id => /^(?:claude|gpt)-/.test(id)), [], "换了 agy 还在列旧 agy 开放的型号")
    await warmed(kit)
    assert.equal(kit.acpSpawns.length, 2, "新 agy 应重新探测")
    assert.equal(kit.acpSpawns.at(-1).file, kit.env.AGY_PATH)
    const after = await kit.models()
    assert.equal(after["claude-opus-5-5"], undefined)
    assert.ok(after["gemini-4-argon"])
  })
})

test("握手报出的 agy 版本低于 1.4.12 时拒绝会话并说明原因", async () => {
  await withKit({ agentVersion: "1.4.11" }, async (kit) => {
    kit.defaultPrompt = async (agent) => {
      await agent.text("ok")
      return { stopReason: "end_turn" }
    }
    const response = await kit.request(baseBody({ model: "agy-cli/gemini-4-argon", tools: [], messages: [{ role: "user", content: "hi" }] }))
    const text = response.status === 200 ? JSON.stringify((await readSse(response)).error) : await response.text()
    assert.match(text, /agy 1\.4\.11 is older than 1\.4\.12/)
    assert.equal(kit.acpLog.filter(entry => entry.method === "session/new").length, 0, "旧版本不应开会话")
  })
})

test("新鲜缓存不再等待也不再 spawn", async () => {
  await withKit({ modelsBehavior: DYNAMIC_OK }, async (kit) => {
    await kit.models()
    await settle(kit)
    kit.modelsBehavior = { hang: true }
    const { value, ms } = await timed(() => kit.models())
    assert.ok(ms < 100, `热缓存耗时 ${Math.round(ms)}ms`)
    assert.ok(value["gemini-9-test"])
    assert.equal(kit.modelsSpawns.length, 1)
  })
})

test("TTL 边界：差 1ms 不刷新，到点后台刷新且过期期间仍 750ms 内返回旧动态目录", async () => {
  await withKit({ modelsBehavior: DYNAMIC_OK }, async (kit) => {
    await kit.models()
    await settle(kit)
    assert.equal(kit.modelsSpawns.length, 1)
    kit.modelsBehavior = { hang: true }
    kit.clock.advance(CATALOG_TTL_MS - 1)
    await kit.models()
    assert.equal(kit.modelsSpawns.length, 1, "TTL 未到就重新 spawn 了")
    kit.clock.advance(1)
    const { value, ms } = await timed(() => kit.models())
    assert.equal(kit.modelsSpawns.length, 2, "TTL 到点没有刷新")
    assert.ok(ms < FAST_BUDGET_MS, `过期目录耗时 ${Math.round(ms)}ms`)
    assert.ok(value["gemini-9-test"], "过期刷新卡住时丢了上次的动态目录")
  })
})

test("50 个并发 models() 只 spawn 一次且结果一致", async () => {
  await withKit({ modelsBehavior: { ...DYNAMIC_OK, delayMs: 120 } }, async (kit) => {
    const { value: results, ms } = await timed(() => Promise.all(Array.from({ length: 50 }, () => kit.models())))
    assert.equal(kit.modelsSpawns.length, 1)
    assert.ok(ms < FAST_BUDGET_MS, `并发耗时 ${Math.round(ms)}ms`)
    const first = JSON.stringify(results[0])
    for (const item of results) assert.equal(JSON.stringify(item), first)
    assert.ok(results[0]["gemini-9-test"])
  })
})

test("失败、超时、空输出、不可解析输出都保留动态独有型号，成功后恢复更新", async () => {
  await withKit({ modelsBehavior: DYNAMIC_OK }, async (kit) => {
    assert.ok((await kit.models())["gemini-9-test"])
    await settle(kit)
    const failures = [
      ["退出码非零", { code: 1, stdout: "" }],
      ["被超时杀掉", { killed: true }],
      ["卡死", { hang: true }],
      ["spawn error 事件", { error: true }],
      ["spawn 同步抛错", { throwSync: true }],
      ["空输出", { code: 0, stdout: "" }],
      ["不可解析输出", { code: 0, stdout: "garbage\n\n   \n" }],
    ]
    for (const [label, behavior] of failures) {
      kit.modelsBehavior = behavior
      kit.clock.advance(CATALOG_TTL_MS)
      const before = kit.modelsSpawns.length
      const { value, ms } = await timed(() => kit.models())
      assert.equal(kit.modelsSpawns.length, before + 1, `${label}：没有发起刷新`)
      assert.ok(ms < FAST_BUDGET_MS, `${label}：耗时 ${Math.round(ms)}ms`)
      assert.ok(value["gemini-9-test"], `${label}：动态独有型号被静态表冲掉`)
      await kit.finishChildren()
      await settle(kit)
    }
    kit.modelsBehavior = { stdout: modelsOutput([...BASE_MODEL_ROWS, ["gemini-10-new-high", "G10 (High)"], ["gemini-10-new-low", "G10 (Low)"]]) }
    kit.clock.advance(CATALOG_TTL_MS)
    const recovered = await kit.models()
    assert.ok(recovered["gemini-10-new"], "恢复成功后没有换成新目录")
    assert.equal(recovered["gemini-9-test"], undefined, "成功刷新应整体替换为新目录")
  })
})

test("失败后的立即重试被限流，不形成请求风暴；隔一段时间后仍会再试", async () => {
  await withKit({ modelsBehavior: { code: 1, stdout: "" } }, async (kit) => {
    await kit.models()
    await settle(kit)
    for (let i = 0; i < 20; i++) await kit.models()
    await settle(kit)
    assert.ok(kit.modelsSpawns.length <= 2, `20 次立即重试起了 ${kit.modelsSpawns.length} 个 agy models`)
    const before = kit.modelsSpawns.length
    kit.clock.advance(CATALOG_TTL_MS)
    kit.modelsBehavior = DYNAMIC_OK
    const models = await kit.models()
    assert.equal(kit.modelsSpawns.length, before + 1, "间隔足够后没有再次尝试")
    assert.ok(models["gemini-9-test"])
  })
})

test("agyPath 变化后不复用旧可执行文件的动态目录", async () => {
  await withKit({ modelsBehavior: { stdout: modelsOutput([...BASE_MODEL_ROWS, ["gemini-only-on-a", "Gemini Only On A"]]) } }, async (kit) => {
    assert.ok((await kit.models())["gemini-only-on-a"])
    await settle(kit)
    kit.env.AGY_PATH = kit.makeFakeAgy("agy-b")
    kit.modelsBehavior = { hang: true }
    const { value, ms } = await timed(() => kit.models())
    assert.ok(ms < FAST_BUDGET_MS)
    assert.equal(value["gemini-only-on-a"], undefined, "换了 agy 仍在用旧 agy 的动态型号")
    assertFallbackPresent(value)
    assert.equal(kit.modelsSpawns.at(-1).file, kit.env.AGY_PATH)
  })
})

test("Gemini 4 Carbon（Ultra）：会话开放就列出，limit 是 Antigravity 型号表给的 1M/262144", async () => {
  const rows = [...BASE_MODEL_ROWS, ["gemini-4-carbon-high", "Gemini 4 Carbon (High)"], ["gemini-4-carbon-low", "Gemini 4 Carbon (Low)"]]
  await withKit({ modelsBehavior: { stdout: modelsOutput(rows) }, offeredModels: [
    ["gemini-4-carbon-high", "Gemini 4 Carbon (High)"], ["gemini-4-carbon-low", "Gemini 4 Carbon (Low)"],
    ["gemini-4-argon-high", "Gemini 4 Argon (High)"], ["gemini-4-argon-low", "Gemini 4 Argon (Low)"],
  ] }, async (kit) => {
    await kit.models()
    await settle(kit)
    const after = await kit.models()
    assert.ok(after["gemini-4-carbon"], "Carbon 应列出")
    assert.deepEqual(JSON.parse(JSON.stringify(after["gemini-4-carbon"].limit)), { context: 1048576, output: 262144 })
  })
})

// @jiangnan_ (X, agy 1.5.9): Orchestrator through the bridge is its planner
// alone, since the Hydrogen handoff needs agy's own tools (tools: []).
const ORCH_ROWS = [
  ["gemini-4-carbon-high", "Gemini 4 Carbon (High)"], ["gemini-4-carbon-medium", "Gemini 4 Carbon (Medium)"], ["gemini-4-carbon-low", "Gemini 4 Carbon (Low)"],
  ["gemini-4-argon-high", "Gemini 4 Argon (High)"], ["gemini-4-argon-low", "Gemini 4 Argon (Low)"],
  ["gemini-4-hydrogen-high", "Gemini 4 Hydrogen (High)"], ["gemini-4-hydrogen-xhigh", "Gemini 4 Hydrogen (XHigh)"],
  ["gemini-4-hydrogen-medium", "Gemini 4 Hydrogen (Medium)"], ["gemini-4-hydrogen-low", "Gemini 4 Hydrogen (Low)"],
  ["gemini-pro-orchestrator", "Orchestrator (Carbon)"], ["gemini-pro-orchestrator-g1-pro", "Orchestrator (Argon)"],
  ["claude-sonnet-4-6", "Claude Sonnet 4.6 (Thinking)"], ["claude-opus-4-6-thinking", "Claude Opus 4.6 (Thinking)"],
]

test("Orchestrator 不列出，点名它的请求得 400 并指向它实际会跑的型号；Hydrogen 等有 limit", async () => {
  await withKit({ modelsBehavior: { stdout: modelsOutput(ORCH_ROWS) }, offeredModels: ORCH_ROWS }, async (kit) => {
    await kit.models()
    await settle(kit)
    const models = await kit.models()
    for (const id of ["gemini-pro-orchestrator", "gemini-pro-orchestrator-g1-pro"]) assert.equal(models[id], undefined, `列出了 ${id}`)
    for (const model of Object.values(models)) assert.doesNotMatch(String(model.name), /Orchestrator/i)
    const plain = (value) => JSON.parse(JSON.stringify(value))
    assert.deepEqual(plain(models["gemini-4-hydrogen"].limit), { context: 1048576, output: 65536 })
    assert.deepEqual(Object.keys(models["gemini-4-hydrogen"].variants ?? {}).sort(), ["high", "low", "medium", "xhigh"])
    assert.deepEqual(plain(models["gemini-4-carbon"].limit), { context: 1048576, output: 262144 })
    assert.deepEqual(plain(models["claude-sonnet-4-6"].limit), { context: 250000, output: 64000 })
    assert.deepEqual(plain(models["claude-opus-4-6-thinking"].limit), { context: 250000, output: 64000 })
    const spawned = kit.children.size
    for (const [requested, planner] of [["agy-cli/gemini-pro-orchestrator", "gemini-4-carbon"], ["gemini-pro-orchestrator-g1-pro", "gemini-4-argon"]]) {
      const response = await kit.request(baseBody({ model: requested, tools: [], messages: [{ role: "user", content: "hi" }] }))
      assert.equal(response.status, 400)
      const body = await response.json()
      assert.match(body.error.message, new RegExp(`Choose ${planner}`))
    }
    assert.equal(kit.children.size, spawned, "被拒的 Orchestrator 请求起了 agy")
  })
})

// plugins#1542: on an account without Claude 5.5, the sonnet family alias
// served claude-sonnet-5-5 as claude-sonnet-4-6 with a 200, while another
// signed-in account lists 5.5. That account is asked, not a stand-in.
test("a family alias doesn't stand in for a model another signed-in account lists", async () => {
  await withKit({ modelsBehavior: { stdout: modelsOutput(ORCH_ROWS) }, offeredModels: ORCH_ROWS }, async (kit) => {
    await kit.models()
    await settle(kit)
    await kit.models()
    const ask = async (label) => {
      const response = await kit.request(baseBody({ model: "agy-cli/claude-sonnet-5-5", messages: [{ role: "user", content: label }] }))
      return { status: response.status, text: await response.text() }
    }
    const file = path.join(kit.env.XDG_STATE_HOME, "magpie-agy-bridge", "models.json")
    const data = JSON.parse(fs.readFileSync(file, "utf8"))
    const [own] = Object.keys(data.byAgy)
    const other = {
      at: Date.now(),
      list: [{ id: "claude-sonnet-5-5-high", name: "Claude Sonnet 5.5 (High)", effort: "high" }, { id: "claude-sonnet-5-5-low", name: "Claude Sonnet 5.5 (Low)", effort: "low" }],
    }
    // an account removed since: its entry stays, its home is gone
    data.byAgy[`${own}#abcdef0123456789`] = other
    fs.writeFileSync(file, JSON.stringify(data))
    const gone = await ask("removed account")
    assert.equal(gone.status, 200, gone.text)

    fs.mkdirSync(path.join(kit.env.XDG_STATE_HOME, "magpie-agy-bridge", "accounts", "abcdef0123456789"), { recursive: true })
    const spawned = kit.children.size
    const listed = await ask("another account")
    assert.equal(listed.status, 400, listed.text)
    assert.match(JSON.parse(listed.text).error.message, /claude-sonnet-5-5 is unavailable to this agy account; another signed-in agy account lists it/)
    assert.equal(kit.children.size, spawned, "no agy was started for it")

    const plain = await kit.request(baseBody({ model: "agy-cli/claude-sonnet-4-6", messages: [{ role: "user", content: "own model" }] }))
    assert.equal(plain.status, 200)
  })
})

test("各家族 limit 正确，未知动态型号不猜成 1M", async () => {
  const expected = {
    "gemini-4-argon": { context: 1048576, output: 65536 },
    "gemini-3.8-flash": { context: 1048576, output: 65536 },
  }
  for (const [label, options] of [["静态目录", { agyPath: null }], ["动态目录", { modelsBehavior: DYNAMIC_OK }]]) {
    await withKit(options, async (kit) => {
      const models = await kit.models()
      for (const [id, limit] of Object.entries(expected)) {
        assert.deepEqual(JSON.parse(JSON.stringify(models[id]?.limit ?? null)), limit, `${label} ${id} 的 limit 不对`)
      }
      if (models["mystery-model"]) {
        const context = models["mystery-model"].limit?.context
        assert.ok(!(context >= 1_000_000), `未知型号被猜成 ${context}`)
      }
      if (models["gemini-9-test"]) {
        const context = models["gemini-9-test"].limit?.context
        assert.ok(!(context >= 1_000_000), `未证实家族被猜成 ${context}`)
      }
    })
  }
})

test("gpt-oss-120b 裸名映射到 medium，请求型号尾部 [1m] 被剥除", async () => {
  const cases = [
    ["agy-cli/gpt-oss-120b", "gpt-oss-120b-medium", "gpt-oss-120b"],
    ["agy-cli/gpt-oss-120b[1m]", "gpt-oss-120b-medium", "gpt-oss-120b"],
    ["agy-cli/gpt-oss-120b-medium", "gpt-oss-120b-medium", "gpt-oss-120b-medium"],
    ["agy-cli/gemini-4-argon[1m]", "gemini-4-argon-high", "gemini-4-argon"],
    ["agy-cli/claude-sonnet-5-5[1M]", "claude-sonnet-5-5-high", "claude-sonnet-5-5"],
  ]
  for (const [requested, agyModel, echoed] of cases) {
    await withKit({ agyPath: undefined, offeredModels: OFFERED_ALL }, async (kit) => {
      kit.defaultPrompt = async (agent) => {
        await agent.text("ok")
        return { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 1 } }
      }
      const parsed = await readSse(await kit.request(baseBody({ model: requested, tools: [], messages: [{ role: "user", content: `hi ${requested}` }] })))
      assert.equal(parsed.error, null, JSON.stringify(parsed.error))
      assert.deepEqual([...kit.setModels], [agyModel], `${requested} 实际选到 ${kit.setModels}`)
      assert.equal(parsed.model, echoed)
      assert.ok(!kit.setModels.some((item) => /\[1m\]/i.test(item)))
    })
  }
})

test("后台刷新抛异常不产生 unhandledRejection，模块定时器随结果一起清掉", async () => {
  const rejections = []
  const onRejection = (reason) => rejections.push(reason)
  process.on("unhandledRejection", onRejection)
  try {
    for (const behavior of [{ brokenChild: true }, { throwSync: true }, { error: true }, { code: 2 }]) {
      await withKit({ modelsBehavior: behavior }, async (kit) => {
        const models = await kit.models()
        assertFallbackPresent(models)
        await settle(kit)
        await sleep(20)
        assert.equal(kit.timers.refed().length, 0, `${JSON.stringify(behavior)} 残留定时器`)
      })
    }
    await sleep(50)
    assert.deepEqual(rejections.map(String), [])
  } finally {
    process.off("unhandledRejection", onRejection)
  }
})

test("慢刷新与失败刷新都不会挂住 Node 退出（独立子进程实测）", () => {
  // 探针不调用 dispose：只靠事件循环自然排空退出；临时目录在 exit 钩子里同步清掉。
  const probe = `
    import fs from "node:fs"
    const tk = await import(${JSON.stringify(new URL("./testkit.mjs", import.meta.url).href)})
    process.on("unhandledRejection", (reason) => { console.error("UNHANDLED", reason); process.exitCode = 3 })
    const slow = await tk.createBridgeKit({ modelsBehavior: { stdout: tk.modelsOutput(tk.BASE_MODEL_ROWS), delayMs: 900 } })
    const failing = await tk.createBridgeKit({ modelsBehavior: { error: true } })
    process.on("exit", () => { for (const kit of [slow, failing]) fs.rmSync(kit.tmp, { recursive: true, force: true }) })
    const started = performance.now()
    const a = await slow.models()
    const b = await failing.models()
    const elapsed = performance.now() - started
    console.log(JSON.stringify({ elapsed, a: Object.keys(a).length, b: Object.keys(b).length }))
  `
  const started = Date.now()
  const result = spawnSync(process.execPath, ["--experimental-vm-modules", "--no-warnings", "--input-type=module", "-e", probe], {
    encoding: "utf8",
    timeout: 20_000,
  })
  const wall = Date.now() - started
  assert.equal(result.error, undefined, String(result.error))
  assert.equal(result.status, 0, `探针退出码 ${result.status}\nstdout:${result.stdout}\nstderr:${result.stderr}`)
  const report = JSON.parse(result.stdout.trim().split("\n").at(-1))
  assert.ok(report.elapsed < 2 * FAST_BUDGET_MS, `两次 models() 共耗时 ${Math.round(report.elapsed)}ms`)
  assert.ok(report.a > 0 && report.b > 0)
  assert.ok(wall < 8_000, `子进程 ${wall}ms 才退出，疑似被定时器挂住`)
})

// Archivemylife on X: picks saved in magpie were gone on the next open. A
// cold host served the static list (or Gemini alone, before agy acp said
// what it offers) as if it were the account's, and magpie set aside every
// pick it didn't name. Such a list says it fell back, so magpie keeps the
// one it had; the account's own list doesn't.
const FELL_BACK = Symbol.for("magpie.fellBack")

test("静态目录与探测前只有 Gemini 的目录都标为 fell back，账号自己的目录不标", async () => {
  await withKit({ agyPath: null }, async (kit) => {
    assert.equal((await kit.models())[FELL_BACK], true, "没有 agy 的静态目录没标 fell back")
  })
  await withKit({ platform: "darwin", storedSignIn: "missing", modelsBehavior: DYNAMIC_OK }, async (kit) => {
    assert.equal((await kit.models())[FELL_BACK], true, "没登录的静态目录没标 fell back")
    await warmed(kit)
  })
  await withKit(SLOW_AGY, async (kit) => {
    const first = await kit.models()
    assertFallbackPresent(first)
    assert.equal(first[FELL_BACK], true, "冷启动的静态目录没标 fell back")
    await warmed(kit)
    const listed = await kit.models()
    assertClaudeListed(listed, "热身后的 models()")
    assert.equal(listed[FELL_BACK], undefined, "账号自己的目录标成了 fell back")
  })
})

test("agy models 答了、探测还没答时只有 Gemini 的目录标 fell back", async () => {
  await withKit({ modelsBehavior: DYNAMIC_OK, sessionNewDelayMs: SLOW_MS, offeredModels: OFFERED_CLAUDE }, async (kit) => {
    const first = await kit.models()
    assert.ok(!Object.keys(first).some(id => id.startsWith("claude-")), Object.keys(first).join(","))
    assert.equal(first[FELL_BACK], true, "探测前只有 Gemini 的目录没标 fell back")
    await warmed(kit)
    const listed = await kit.models()
    assertClaudeListed(listed, "探测后的 models()")
    assert.equal(listed[FELL_BACK], undefined)
  })
})

test("已登录时登录结果用 agy 存的 Google 账号命名，而不是一个 API key", async () => {
  const value = "go-keyring-base64:" + Buffer.from(JSON.stringify({ token: { access_token: "a", refresh_token: "r", expiry: "2020-01-01T00:00:00Z" }, id_token_email: "second@example.com" })).toString("base64")
  await withKit({ platform: "darwin", storedSignIn: value + "\n", modelsBehavior: DYNAMIC_OK }, async (kit) => {
    const started = await kit.plugin.auth.methods[0].authorize()
    assert.equal(started.method, "auto")
    const done = await started.callback()
    assert.equal(done.type, "success")
    assert.equal(done.key, "agy")
    assert.deepEqual(done.metadata, { email: "second@example.com" })
    await warmed(kit)
  })
})

// agy 1.5.9 when Google answers 403 #3501 at its eligibility check (run
// against a fake Code Assist, 11-16): every command, `agy models` included,
// ends with this and exit 1. Three people on X got a fallback list, "model …
// is unavailable to this agy account" and "not eligible" from the plugin.
const REFUSED_3501 = "Error: Eligibility check failed: PERMISSION_DENIED (code 403): You do not have a valid license of this product. Please contact your administrator to request a license. If you are not an enterprise user and believe you are receiving this message as an error, please try using the latest version and logging in again. (#3501). Please log out (/logout) and log back in (/login).\n"
const REFUSED_LISTING = { code: 1, stderr: "I1116 10:34:03.760516     315 http_helpers.go:876] Failed to make code assist backend request\n" + REFUSED_3501 }

test("#3501 Google 拒了账号：models() 说出原因，不给静态目录冒充账号的型号", async () => {
  await withKit({ modelsBehavior: REFUSED_LISTING }, async (kit) => {
    await kit.models().catch(() => {})
    await warmed(kit)
    const error = await kit.models().then(() => null, e => e)
    assert.ok(error, "Google 拒了账号，models() 仍给了一份列表")
    assert.match(error.message, /#3501/)
    assert.match(error.message, /valid license/)
    assert.match(error.message, /\/logout.*\/login/)
    assert.match(error.message, /AGY_ADC_AUTH/)
    // agy 又能列出了（重新登录、换了地区）：恢复正常目录
    kit.modelsBehavior = DYNAMIC_OK
    kit.clock.advance(CATALOG_TTL_MS)
    await kit.models().catch(() => {})
    await warmed(kit)
    assert.ok((await kit.models())["gemini-9-test"], "agy 能列出后仍报拒绝")
  })
})

test("#3501 别的失败（网络、超时、未知输出）仍给静态目录，不说成拒绝", async () => {
  await withKit({ modelsBehavior: { code: 1, stderr: "Error: Eligibility check failed: EOF\n" } }, async (kit) => {
    await kit.models()
    await warmed(kit)
    assert.ok((await kit.models())["gemini-4-argon"])
  })
})

test("#3501 请求：会话一个型号都不开放时答 403 和 Google 的原因，不说型号不可用", async () => {
  for (const stream of [true, false]) {
    await withKit({ modelsBehavior: REFUSED_LISTING, setModelError: { code: -32603, message: "Unknown model ID: gemini-4-argon-high" } }, async (kit) => {
      const response = await kit.request(baseBody({ stream, model: "agy-cli/gemini-4-argon", tools: [], messages: [{ role: "user", content: "hi" }] }))
      assert.equal(response.status, 403, `stream=${stream}`)
      const body = await response.json()
      assert.equal(body.error.type, "permission_error")
      assert.match(body.error.message, /#3501/)
      assert.doesNotMatch(body.error.message, /unavailable to this agy account/)
      await settle(kit)
    })
  }
  // 账号没被拒，型号真的不可用：仍是 400
  await withKit({ modelsBehavior: DYNAMIC_OK, setModelError: { code: -32603, message: "Unknown model ID: gemini-4-argon-high" } }, async (kit) => {
    const response = await kit.request(baseBody({ model: "agy-cli/gemini-4-argon", tools: [], messages: [{ role: "user", content: "hi" }] }))
    assert.equal(response.status, 400)
    assert.match((await response.json()).error.message, /unavailable to this agy account/)
    await settle(kit)
  })
})

// plugins#1602 (cyclonevox: agy 1.5.18, Google AI Pro, region SG):
// loadCodeAssist names standard-tier current, g1-pro-tier paid, and
// free-tier ineligible (UNSUPPORTED_LOCATION). `agy models` refuses on
// that entry while agy acp serves the account and names its tier; magpie
// said "Google refuses this account" and listed nothing.
const REFUSED_REGION = { code: 1, stderr: "error: Eligibility check failed: Your current account is not eligible for Gemini Code Assist for individuals because it is not currently available in your location.\n" }
const PRO_TIER = { name: "Gemini Code Assist in Google One AI Pro", id: "g1-pro-tier", upgradeUri: "" }
const OFFERED_PRO = [["gemini-4-argon-high", "Gemini 4 Argon (High)"], ["gemini-4-argon-low", "Gemini 4 Argon (Low)"], ["claude-opus-5-5-high", "Claude Opus 5.5 (High)"]]

test("#1602 agy models 在资格检查拒绝、agy acp 却给出档位时，用 agy acp 开放的型号，不说账号被拒", async () => {
  await withKit({ modelsBehavior: REFUSED_REGION, offeredModels: OFFERED_PRO, sessionTier: PRO_TIER }, async (kit) => {
    await kit.models().catch(() => {})
    await warmed(kit)
    const listed = await kit.models()
    assert.ok(listed["gemini-4-argon"], `got ${ids(listed).join(", ")}`)
    assert.ok(listed["claude-opus-5-5-high"], `got ${ids(listed).join(", ")}`)
  })
  // the sign-in check takes the account too
  await withKit({ modelsBehavior: REFUSED_REGION, offeredModels: OFFERED_PRO, sessionTier: PRO_TIER }, async (kit) => {
    const started = await kit.plugin.auth.methods[0].authorize()
    assert.equal(started.method, "auto")
    assert.equal((await started.callback()).type, "success")
    assert.ok((await kit.models())["gemini-4-argon"])
    await warmed(kit)
  })
  // a turn whose model agy won't set is the model's, not a refusal
  await withKit({ modelsBehavior: REFUSED_REGION, offeredModels: OFFERED_PRO, sessionTier: PRO_TIER, setModelError: { code: -32603, message: "Unknown model ID: gemini-4-argon-high" } }, async (kit) => {
    const response = await kit.request(baseBody({ model: "agy-cli/gemini-4-argon", tools: [], messages: [{ role: "user", content: "hi" }] }))
    assert.equal(response.status, 400)
    assert.match((await response.json()).error.message, /unavailable to this agy account/)
    await settle(kit)
  })
})

test("#1602 agy acp 不给档位（真不合格）或一个型号都不开放时，仍说账号被拒", async () => {
  for (const options of [{ offeredModels: OFFERED_PRO }, { offeredModels: null, sessionTier: PRO_TIER }]) {
    await withKit({ modelsBehavior: REFUSED_REGION, ...options }, async (kit) => {
      await kit.models().catch(() => {})
      await warmed(kit)
      const error = await kit.models().then(() => null, e => e)
      assert.ok(error, "真不合格的账号给了一份列表")
      assert.match(error.message, /Google refuses this account for Antigravity/)
    })
  }
  // the sign-in check doesn't take it for signed in either: authorize goes
  // on to Google's sign-in
  await withKit({ modelsBehavior: REFUSED_REGION, offeredModels: OFFERED_PRO }, async (kit) => {
    const started = await kit.plugin.auth.methods[0].authorize()
    assert.notEqual(started.method, "auto")
  })
})

// plugins#1218 (shenggxhz on X): settings.json's "modelProvider": "gemini"
// (an AI Studio key) made a bare `agy models` fail without GEMINI_API_KEY in
// magpie's environment, and the old catalog stayed. agy 1.5.9's own help
// lines; the fake answers like that agy: bare, the API-key error; with
// --settings '{"modelProvider":""}', the Google sign-in's list.
const AGY_159_TOP_HELP = [
  "Usage of agy:",
  "  --add-dir                       Add a directory to the workspace (repeatable) (default [])",
  "  --sandbox                       Run in a sandbox with terminal restrictions enabled",
  "  --settings                      Settings for this session only, never saved: a JSON object of settings.json keys, inline or as a file path",
  "",
  "Available subcommands:",
  "  models          List available models",
  "",
].join("\n")
const GEMINI_PROVIDER_ERROR = 'modelProvider is set to "gemini" in settings.json, but the GEMINI_API_KEY environment variable is not set'
function geminiSettingsAgy() {
  return ({ args }) => {
    const i = args.indexOf("--settings")
    const provider = i >= 0 ? JSON.parse(args[i + 1]).modelProvider : "gemini"
    return provider === "gemini" ? { stderr: GEMINI_PROVIDER_ERROR + "\n", code: 1 } : DYNAMIC_OK
  }
}

test("#1218 agy models runs with modelProvider cleared when agy takes --settings, so a gemini settings.json doesn't keep a stale list", async () => {
  await withKit({ topHelp: AGY_159_TOP_HELP, modelsBehavior: geminiSettingsAgy() }, async (kit) => {
    await kit.models()
    await warmed(kit)
    const listed = await kit.models()
    assert.ok(listed["gemini-9-test"], `agy's own list should be read, got ${ids(listed).join(", ")}`)
    assert.ok(kit.modelsSpawns.length >= 1)
    for (const spawn of kit.modelsSpawns) assert.deepEqual(spawn.args, ["--settings", '{"modelProvider":""}', "models"])
    assert.equal(kit.topHelpSpawns.length, 1, "agy --help is asked once per binary")
  })
})

test("#1218 an agy whose help doesn't list --settings still runs a bare agy models", async () => {
  await withKit({ modelsBehavior: DYNAMIC_OK }, async (kit) => {
    await kit.models()
    await warmed(kit)
    assert.ok((await kit.models())["gemini-9-test"])
    for (const spawn of kit.modelsSpawns) assert.deepEqual(spawn.args, ["models"])
  })
})

// #1229: two accounts on different plans. agy offers one Claude and the
// other Gemini only; each account's models() lists its own, and neither
// account's session changes what the other lists.
test("#1229 每个账号列自己开放的型号，互不覆盖", async () => {
  const otherAuth = { type: "oauth", metadata: { agyHome: "otheracct1" } }
  await withKit({
    modelsBehavior: DYNAMIC_OK,
    offeredModels: (home) => /otheracct1$/.test(home) ? OFFERED_ALL.filter(([id]) => id.startsWith("gemini-")) : OFFERED_CLAUDE,
  }, async (kit) => {
    // the other account is signed in in its own home, as agy writes it
    const token = path.join(kit.env.XDG_STATE_HOME, "magpie-agy-bridge", "accounts", "otheracct1", ".gemini", "antigravity-cli", "antigravity-oauth-token")
    fs.mkdirSync(path.dirname(token), { recursive: true })
    fs.writeFileSync(token, JSON.stringify({ token: { access_token: "test-access", refresh_token: "test-refresh", expiry: "0001-01-01T00:00:00Z" } }))
    const own = () => kit.plugin.provider.models()
    const other = () => kit.plugin.provider.models(undefined, { auth: otherAuth })
    await own()
    await warmed(kit)
    assertClaudeListed(await own(), "默认账号")
    await other()
    await warmed(kit)
    const otherList = await other()
    assert.ok(otherList["gemini-4-argon"])
    assert.deepEqual(ids(otherList).filter(id => /^(?:claude|gpt)-/.test(id)), [], "另一个账号列出了它没开放的型号")
    // the other account's probe didn't change the first account's list
    assertClaudeListed(await own(), "另一个账号探测之后的默认账号")
    assert.ok(kit.acpSpawns.some(spawn => /otheracct1$/.test(spawn.env?.HOME ?? "")), "另一个账号该在自己的 HOME 里探测")
  })
})

// shenggxhz (X, 11-17): moved from a Pro account to Ultra, and the agy
// provider still listed no Gemini 4. What agy acp offered the Pro account
// was saved in models.json and believed until a request opened a session,
// so Ultra's fresh `agy models` (Carbon in it) was filtered down to the Pro
// account's offer. A saved offer is asked again once agy answers, and a
// listing that changes asks again too.
const PRO_ROWS = [
  ["gemini-3.8-flash-high", "Gemini 3.8 Flash (High)"], ["gemini-3.8-flash-low", "Gemini 3.8 Flash (Low)"],
  ["claude-sonnet-4-6", "Claude Sonnet 4.6"], ["gpt-oss-120b-medium", "GPT-OSS 120B (Medium)"],
]
const PRO_OFFERED = [["gemini-3.8-flash", "Gemini 3.8 Flash"], ["claude-sonnet-4-6", "Claude Sonnet 4.6"], ["gpt-oss-120b-medium", "GPT-OSS 120B (Medium)"]]
const ULTRA_ROWS = [["gemini-4-carbon-high", "Gemini 4 Carbon (High)"], ["gemini-4-carbon-low", "Gemini 4 Carbon (Low)"], ...PRO_ROWS]
const ULTRA_OFFERED = [["gemini-4-carbon-high", "Gemini 4 Carbon (High)"], ["gemini-4-carbon-low", "Gemini 4 Carbon (Low)"], ...PRO_OFFERED]

test("shenggxhz 换到 Ultra 账号后重启：保存的旧开放型号不挡住 Gemini 4，agy 回答后重新探测", async () => {
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), "agy-catalog-ultra-"))
  try {
    const agy = path.join(shared, process.platform === "win32" ? "agy.exe" : "agy")
    fs.writeFileSync(agy, "#!/bin/sh\nexit 99\n", { mode: 0o755 })
    const env = { XDG_STATE_HOME: path.join(shared, "state") }
    await withKit({ agyPath: agy, env, modelsBehavior: { stdout: modelsOutput(PRO_ROWS) }, offeredModels: PRO_OFFERED }, async (kit) => {
      await kit.models()
      await warmed(kit)
      const pro = await kit.models()
      assert.ok(pro["claude-sonnet-4-6"])
      assert.equal(pro["gemini-4-carbon"], undefined)
    })
    await withKit({ agyPath: agy, env, modelsBehavior: { stdout: modelsOutput(ULTRA_ROWS) }, offeredModels: ULTRA_OFFERED }, async (kit) => {
      await kit.models()
      await warmed(kit)
      const ultra = await kit.models()
      assert.ok(ultra["gemini-4-carbon"], `Ultra 的 Gemini 4 Carbon 没列出：${ids(ultra).join(", ")}`)
      assert.equal(kit.acpSpawns.length, 1, "保存的开放型号要在这次运行里再问一次 agy acp")
    })
  } finally {
    fs.rmSync(shared, { recursive: true, force: true })
  }
})

test("shenggxhz 运行中换了账号：agy models 列表变了就重新探测开放型号", async () => {
  await withKit({ modelsBehavior: { stdout: modelsOutput(PRO_ROWS) }, offeredModels: PRO_OFFERED }, async (kit) => {
    await kit.models()
    await warmed(kit)
    assert.equal((await kit.models())["gemini-4-carbon"], undefined)
    assert.equal(kit.acpSpawns.length, 1)
    kit.modelsBehavior = { stdout: modelsOutput(ULTRA_ROWS) }
    kit.offeredModels = ULTRA_OFFERED
    kit.clock.advance(CATALOG_TTL_MS)
    await kit.models()
    await warmed(kit)
    const after = await kit.models()
    assert.ok(after["gemini-4-carbon"], `换账号后 Gemini 4 Carbon 没列出：${ids(after).join(", ")}`)
    assert.equal(kit.acpSpawns.length, 2, "列表变了该再探测一次")
    // 列表没变时不再探测
    kit.clock.advance(CATALOG_TTL_MS)
    await kit.models()
    await warmed(kit)
    assert.equal(kit.acpSpawns.length, 2, "列表没变不该再起探测会话")
  })
})

// canlee886 on X: magpie wired Antigravity's app to itself
// (~/.gemini/config/config.json's gateway), and agy reads that file too: an
// agy on ~/.gemini lists and offers magpie's own models, and a turn on one
// would go back into magpie. The provider lists the Google account's.
const APP_GATEWAY_ACP_HELP = "Usage of acp:\n  --gemini-dir\n    \tPath where Gemini files are stored (default .gemini)\n"
const MAGPIE_ROWS = [["rg/gpt-6-astra", "GPT-6 Astra · routing group"], ["rg/gpt-6-astra:low", "GPT-6 Astra · routing group (Low)"], ["gemini-4-argon-high", "Gemini 4 Argon (High)"]]
const ACCOUNT_OFFERED = [
  ["gemini-3.8-flash", "Gemini 3.8 Flash"],
  ["gemini-3.8-flash-high", "Gemini 3.8 Flash (High)"], ["gemini-3.8-flash-low", "Gemini 3.8 Flash (Low)"],
  ["claude-opus-4-6-thinking", "Claude Opus 4.6 (Thinking)"],
]
function appGatewayKit(extra = {}) {
  const onOwnFolder = (args) => args.includes("--gemini-dir")
  return {
    acpHelp: APP_GATEWAY_ACP_HELP,
    topHelp: AGY_159_TOP_HELP,
    // `agy models` has no --gemini-dir: it always reads the app's gateway
    modelsBehavior: { stdout: modelsOutput(MAGPIE_ROWS) },
    offeredModels: (_home, args) => onOwnFolder(args) ? ACCOUNT_OFFERED : MAGPIE_ROWS,
    ...extra,
  }
}
function wireAppGateway(home, body = { gateway: { enabled: true, url: "http://127.0.0.1:3425", apiKey: "mk", wireProtocol: "openai" } }) {
  fs.mkdirSync(path.join(home, ".gemini", "config"), { recursive: true })
  fs.writeFileSync(path.join(home, ".gemini", "config", "config.json"), typeof body === "string" ? body : JSON.stringify(body))
}
function assertAccountListed(listed) {
  const all = ids(listed)
  assert.ok(!all.some(id => id.startsWith("rg/")), `magpie's own models were listed: ${all.join(", ")}`)
  assert.ok(listed["gemini-3.8-flash"], `the account's models should be listed, got ${all.join(", ")}`)
  assert.deepEqual(Object.keys(listed["gemini-3.8-flash"].variants ?? {}).sort(), ["high", "low"])
  assert.ok(listed["claude-opus-4-6-thinking"], `got ${all.join(", ")}`)
}

test("canlee886 Antigravity 的 app 接到 magpie 时，目录列 Google 账号的型号，不列 magpie 自己的", async () => {
  await withKit(appGatewayKit(), async (kit) => {
    wireAppGateway(kit.home)
    await kit.models()
    await warmed(kit)
    assertAccountListed(await kit.models())
    assert.ok(kit.acpSpawns.length >= 1)
    for (const spawn of kit.acpSpawns) assert.ok(spawn.args.includes("--gemini-dir"), `agy acp ran on ~/.gemini: ${spawn.args.join(" ")}`)
  })
})

test("canlee886 app 接到 magpie 时，登录检查和它读到的目录都来自账号的会话", async () => {
  await withKit(appGatewayKit(), async (kit) => {
    wireAppGateway(kit.home)
    const started = await kit.plugin.auth.methods[0].authorize()
    assert.equal((await started.callback()).type, "success")
    assertAccountListed(await kit.models())
    assert.equal(kit.modelsSpawns.length, 0, "agy models lists the app's gateway, not the account")
  })
})

test("canlee886 app 接到 magpie、agy 没登录 Google 时，登录检查不因 gateway 的列表说已登录", async () => {
  await withKit(appGatewayKit({ sessionNewError: { code: -32000, message: "Authentication required" } }), async (kit) => {
    wireAppGateway(kit.home)
    const started = await kit.plugin.auth.methods[0].authorize()
    // signed in, authorize ends at once ("auto"); here it starts Google's sign-in
    assert.notEqual(started.method, "auto", "the gateway's listing was taken for a Google sign-in")
  })
})

test("canlee886 app 的 gateway 关着、读不成 JSON 时各按关、开处理", async () => {
  await withKit(appGatewayKit({ offeredModels: ACCOUNT_OFFERED, modelsBehavior: { stdout: modelsOutput(ACCOUNT_OFFERED.slice(1)) } }), async (kit) => {
    wireAppGateway(kit.home, { gateway: { enabled: false, url: "http://127.0.0.1:3425" } })
    assert.equal(kit.module.appGatewayOn(kit.home), false)
    await kit.models()
    await warmed(kit)
    assert.ok(kit.modelsSpawns.length >= 1, "a gateway turned off leaves agy models as it was")
    wireAppGateway(kit.home, "{not json")
    assert.equal(kit.module.appGatewayOn(kit.home), true)
    fs.rmSync(path.join(kit.home, ".gemini", "config", "config.json"))
    assert.equal(kit.module.appGatewayOn(kit.home), false)
  })
})

// plugins#1591 (I-am-c, Windows, agy 1.5.18): with the app wired to magpie,
// agy -p /usage on ~/.gemini reads the app's gateway, which asks Google
// nothing and lists no quota ({"groups": []}), so the card said "agy
// returned no enabled, measured quota buckets". The read goes to the folder
// a turn's agy acp gets, which has no gateway.
test("#1591 app 接到 magpie 时，额度读的是 Google 账号的，不是 gateway 的空列表", async () => {
  const keyring = "go-keyring-base64:" + Buffer.from(JSON.stringify({
    token: { access_token: "ya29.a", refresh_token: "1//r", expiry: "0001-01-01T00:00:00Z" },
    auth_method: "consumer", id_token_email: "a@example.com",
  })).toString("base64") + "\n"
  const reads = []
  const onSpawn = (_file, args) => {
    if (args[0] === "--version") return { code: 0, stdout: "1.5.18\n" }
    if (!args.includes("/usage")) return 1
    reads.push(args)
    // agy on a gateway answers SUCCESS with no groups (agy 1.5.18)
    const groups = args.includes("--gemini_dir") ? [{
      name: "Gemini Models", description: "Models within this group: Gemini 4 Argon",
      buckets: [{ id: "w", name: "Weekly Limit Remaining", window: "weekly", reset_time: "2026-11-22T00:00:00Z", remaining_fraction: 0.75 }],
    }] : []
    return { code: 0, stdout: JSON.stringify({ status: "SUCCESS", command: { name: "usage", data: { groups } } }) }
  }
  const net = noFetch()
  try {
    await withKit(appGatewayKit({ platform: "darwin", storedSignIn: keyring, onSpawn }), async (kit) => {
      wireAppGateway(kit.home)
      const usage = await kit.plugin.auth.usage(async () => ({ type: "oauth", key: "agy", metadata: { email: "a@example.com" } }), {})
      assert.equal(usage.error, undefined, JSON.stringify(usage))
      assert.equal(usage.windows.find(w => !w.model)?.used, 25)
      const own = path.join(kit.env.XDG_STATE_HOME, "magpie-agy-bridge", "agy-home")
      assert.deepEqual(reads.at(-1).slice(0, 4), ["--gemini_dir", own, "-p", "/usage"])
      assert.deepEqual(net.fetched, [], "usage asked Google itself")
      await settle(kit)
    })
  } finally {
    net.restore()
  }
})

// The provider is named as the plugin's row is, not by its id (agy-cli), on
// magpie's Providers row; a name the user gave it stays.
test("config names the provider, keeping the user's own name", async () => {
  await withKit({ agyPath: null }, async (kit) => {
    const cfg = {}
    await kit.plugin.config(cfg)
    assert.equal(cfg.provider["agy-cli"].name, "Antigravity (local agy CLI)")
    const registry = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "../../../registry.json"), "utf8"))
    const row = registry.plugins.find((p) => p.providers?.includes("agy-cli"))
    assert.equal(cfg.provider["agy-cli"].name, row.name)
    assert.equal(cfg.provider["agy-cli"].npm, kit.plugin.provider.npm)
    const own = { provider: { "agy-cli": { name: "My agy", npm: "x", options: { x: 1 } } } }
    await kit.plugin.config(own)
    assert.deepEqual(own.provider["agy-cli"], { name: "My agy", npm: "x", options: { x: 1 } })
  })
})
