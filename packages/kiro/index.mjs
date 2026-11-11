// Kiro's subscriptions (kiro.dev) as an OpenCode provider plugin.
//
// An account is signed in the way the Kiro IDE signs in: Kiro's sign-in
// page (app.kiro.dev) offers Google, GitHub, AWS Builder ID and IAM
// Identity Center, and sends the browser back to one of the ports the IDE
// listens on. Google and GitHub come back with a code Kiro's auth service
// trades for tokens; Builder ID and Identity Center come back with where to
// sign in at AWS, which is then done with a client registered for it.
// kiro-cli's or the IDE's own sign-in can be used instead: it is read where
// they keep it each time, refreshed by kiro-cli first, and a token
// refreshed here is written back, so they go on with it. A Kiro API key
// (ksk_…) signs in too.
//
// Kiro has no API OpenCode speaks: the models are declared on Anthropic's
// Messages, and the fetch here sends each request whole to Kiro's own API
// (runtime.<region>.kiro.dev/generateAssistantResponse, the one kiro-cli
// talks to) as a conversation, and turns the AWS event stream it answers
// with back into Messages' events. An account Kiro has put on its
// CreateResponse experiment is asked as the Kiro IDE asks it then
// (/v1/responses, answered with server-sent events; see createResponse).
import { createServer } from "node:http"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import { readFile, rename, writeFile } from "node:fs/promises"
import { homedir, hostname, platform, release } from "node:os"
import { delimiter, join } from "node:path"

const ID = "kiro"

// WORDS are the sign-in's words in magpie's other languages, beside the
// English each method, question and choice has (magpie's labels, messages
// and hints; OpenCode ignores them). Product names stay as written.
const WORDS = {
  browser: { zh: "Kiro 登录（Google、GitHub、AWS Builder ID、IAM Identity Center）", "zh-TW": "Kiro 登入（Google、GitHub、AWS Builder ID、IAM Identity Center）", ja: "Kiro にサインイン（Google、GitHub、AWS Builder ID、IAM Identity Center）", de: "Kiro-Anmeldung (Google, GitHub, AWS Builder ID, IAM Identity Center)" },
  choose: { zh: "选择登录方式", "zh-TW": "選擇登入方式", ja: "サインイン方法を選択", de: "Anmeldemethode wählen" },
  enterprise: { zh: "IAM Identity Center（组织 Start URL）", "zh-TW": "IAM Identity Center（組織 Start URL）", ja: "IAM Identity Center（組織の Start URL）", de: "IAM Identity Center (Start-URL der Organisation)" },
  enterpriseHint: { zh: "用组织的 AWS Start URL 登录", "zh-TW": "用組織的 AWS Start URL 登入", ja: "組織の AWS Start URL でサインイン", de: "Mit der AWS-Start-URL Ihrer Organisation anmelden" },
  builderidHint: { zh: "直接打开 AWS 登录；在远程服务器上只需粘贴一次回调地址", "zh-TW": "直接開啟 AWS 登入；在遠端伺服器上只需貼上一次回呼網址", ja: "AWS のサインインを直接開きます。リモートサーバーではコールバックを 1 回貼り付けるだけです", de: "Öffnet die AWS-Anmeldung direkt; auf einem entfernten Server wird ein Callback einmal eingefügt" },
  portal: { zh: "Kiro 登录页", "zh-TW": "Kiro 登入頁", ja: "Kiro のサインインページ", de: "Kiro-Anmeldeseite" },
  portalHint: { zh: "Google、GitHub、IAM Identity Center 或 Kiro 的其他登录方式", "zh-TW": "Google、GitHub、IAM Identity Center 或 Kiro 的其他登入方式", ja: "Google、GitHub、IAM Identity Center など Kiro のサインイン方法", de: "Google, GitHub, IAM Identity Center oder andere Kiro-Anmeldemethoden" },
  startUrl: { zh: "组织 Start URL", "zh-TW": "組織 Start URL", ja: "組織の Start URL", de: "Start-URL der Organisation" },
  region: { zh: "AWS 区域（留空为 us-east-1）", "zh-TW": "AWS 區域（留空為 us-east-1）", ja: "AWS リージョン（空欄なら us-east-1）", de: "AWS-Region (leer: us-east-1)" },
  own: { zh: "Kiro CLI 或 Kiro IDE 已登录的账号", "zh-TW": "Kiro CLI 或 Kiro IDE 已登入的帳號", ja: "Kiro CLI または Kiro IDE のサインイン", de: "Anmeldung von Kiro CLI oder Kiro IDE" },
  key: { zh: "Kiro API Key（ksk_…）", "zh-TW": "Kiro API Key（ksk_…）", ja: "Kiro API キー（ksk_…）", de: "Kiro-API-Schlüssel (ksk_…)" },
}
const MESSAGES = "@ai-sdk/anthropic"
const BASE = "https://runtime.us-east-1.kiro.dev" // what OpenCode is given; the fetch sends each request to the account's region

const PORTAL = "https://app.kiro.dev"
const AUTH_SERVICE = "https://prod.us-east-1.auth.desktop.kiro.dev"
const oidc = (region) => `https://oidc.${region}.amazonaws.com`
const runtime = (region) => `https://runtime.${region}.kiro.dev`
const management = (region) => `https://management.${region}.kiro.dev`
const refreshURL = (region) => `https://prod.${region}.auth.desktop.kiro.dev/refreshToken`
// the ports Kiro's sign-in page sends the browser back to, the IDE's
const CALLBACK_PORTS = [3128, 4649, 6588, 8008, 9091, 49153, 50153, 51153, 52153, 53153]
// what the IDE asks AWS for
const SCOPES = ["codewhisperer:completions", "codewhisperer:analysis", "codewhisperer:conversations",
  "codewhisperer:transformations", "codewhisperer:taskassist"]
// how the IDE names itself to Kiro's auth service, and when refreshing
// MACHINE_ID stands where the IDE puts its machine id (node-machine-id's
// sha256): one per install, the same on every call.
const MACHINE_ID = createHash("sha256").update("magpie:" + hostname()).digest("hex")
const IDE_UA = "KiroIDE-1.1.70-" + MACHINE_ID
const DESKTOP_UA = "Kiro-Desktop/0.2.13 (darwin; arm64)"
const SIGN_IN_TIMEOUT = 10 * 60 * 1000
// A Builder ID sign-in has no profile of its own, and Kiro won't list one
// for it (List-Available-Profiles is a 403, "AWS Builder ID is not supported
// for this operation"); the Kiro IDE and kiro-cli name this service profile
// for it instead, so its models, usage and chat are asked with it too.
const BUILDER_ID_START = "https://view.awsapps.com/start"
const BUILDER_ID_PROFILE = "arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX"
const isBuilderID = (provider) => String(provider ?? "").toLowerCase() === "builderid"
// uidOf is what tells two Kiro accounts of one email apart: the way it was
// signed in to. Kiro keeps a Google and a GitHub sign-in of one email (or
// Builder ID's, or Identity Center's) as different accounts, and magpie
// keeps a sign-in of an email already signed in as that account unless
// both have a uid and the two differ (#309). "" when it isn't known.
const uidOf = (loginProvider) => String(loginProvider ?? "").trim().toLowerCase()
// nameOf is what an account is called: its email and the way it was signed
// in to, as Kiro's sign-in page names it, so two accounts of one email read
// apart (#309; magpie names a plugin's account by its accountId). A way not
// known, kiro-cli's or the Kiro IDE's sign-in among them, leaves the email
// as it is, and magpie tells two such apart by their slot.
const WAYS = { google: "Google", github: "GitHub", builderid: "Builder ID", enterprise: "IAM Identity Center", internal: "Internal" }
const nameOf = (email, loginProvider) => (WAYS[uidOf(loginProvider)] ? `${email} (${WAYS[uidOf(loginProvider)]})` : email)
// a bare email: what an account was called before nameOf
const bareEmail = (id) => typeof id === "string" && /^[^\s()]+@[^\s()]+$/.test(id)

const env = (k) => process.env[k] ?? ""
const home = () => env("HOME") || homedir()

// ---- where Kiro's own apps keep their sign-in -----------------------------------

function cliDB() {
  if (process.platform === "win32") return join(env("APPDATA") || join(home(), "AppData", "Roaming"), "kiro-cli", "data.sqlite3")
  if (process.platform === "darwin") return join(home(), "Library", "Application Support", "kiro-cli", "data.sqlite3")
  return join(home(), ".local", "share", "kiro-cli", "data.sqlite3")
}
const ideDir = () => join(home(), ".aws", "sso", "cache")

// kiroExecutable finds kiro-cli, which refreshes its own sign-in.
function kiroExecutable() {
  for (const d of env("PATH").split(delimiter)) {
    const p = join(d, process.platform === "win32" ? "kiro-cli.exe" : "kiro-cli")
    if (d && isFile(p)) return p
  }
  for (const p of [join(home(), ".local", "bin", "kiro-cli"), "/Applications/Kiro CLI.app/Contents/MacOS/kiro-cli",
    "/usr/local/bin/kiro-cli", "/opt/homebrew/bin/kiro-cli"])
    if (isFile(p)) return p
  return ""
}
function isFile(p) {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

// openDB opens kiro-cli's SQLite database, with Bun's driver or Node's.
async function openDB(path, readonly) {
  try {
    const { Database } = await import("bun:sqlite")
    return new Database(path, readonly ? { readonly: true } : { readwrite: true })
  } catch (e) {
    if (typeof Bun !== "undefined") throw e
  }
  const { DatabaseSync } = await import("node:sqlite")
  return new DatabaseSync(path, { readOnly: readonly })
}

const time = (s) => {
  const t = Date.parse(s ?? "")
  return Number.isFinite(t) ? t : 0
}

// readCLI reads kiro-cli's sign-in: with Google or GitHub, with AWS (Builder
// ID, IAM Identity Center), or with a company's own identity provider.
async function readCLI() {
  const path = cliDB()
  if (!existsSync(path)) return null
  let db
  try {
    db = await openDB(path, true)
    const get = (key) => {
      const row = db.prepare("SELECT value FROM auth_kv WHERE key = ?").get(key)
      if (!row?.value) return null
      try {
        return JSON.parse(row.value)
      } catch {
        return null
      }
    }
    for (const kind of ["social", "odic", "external-idp"]) {
      const key = `kirocli:${kind}:token`
      const m = get(key)
      if (!m?.access_token) continue
      const c = { access: m.access_token, refresh: m.refresh_token ?? "", expires: time(m.expires_at), region: m.region || "us-east-1",
        profile: m.profile_arn ?? "", dbKey: key }
      if (kind === "social") c.method = "social"
      else if (kind === "odic") {
        c.method = "idc"
        // as kiro-cli tells them apart: Builder ID's start URL, or none
        c.builderID = !m.start_url || m.start_url === BUILDER_ID_START
        const reg = get("kirocli:odic:device-registration")
        if (reg) [c.clientId, c.clientSecret] = [reg.client_id ?? "", reg.client_secret ?? ""]
      } else {
        c.method = "external-idp"
        c.clientId = m.client_id ?? ""
        c.tokenURL = m.token_endpoint || (m.issuer_url ? m.issuer_url.replace(/\/$/, "") + "/v1/token" : "")
      }
      return c
    }
  } catch {
  } finally {
    db?.close()
  }
  return null
}

// readIDE reads the Kiro IDE's sign-in.
async function readIDE() {
  const path = join(ideDir(), "kiro-auth-token.json")
  let t
  try {
    t = JSON.parse(await readFile(path, "utf8"))
  } catch {
    return null
  }
  if (!t?.accessToken) return null
  const c = { access: t.accessToken, refresh: t.refreshToken ?? "", expires: time(t.expiresAt), region: t.region || "us-east-1",
    profile: t.profileArn ?? "", method: "idc", idePath: path, builderID: isBuilderID(t.provider) }
  if (t.clientIdHash) {
    try {
      const reg = JSON.parse(await readFile(join(ideDir(), t.clientIdHash + ".json"), "utf8"))
      ;[c.clientId, c.clientSecret] = [reg.clientId ?? "", reg.clientSecret ?? ""]
    } catch {}
  }
  if (String(t.authMethod).toLowerCase() === "social" || !c.clientId) c.method = "social"
  return c
}

// saveBack writes a refreshed token back where it was read from, so
// kiro-cli or the IDE goes on with it (a refresh may replace the refresh
// token).
async function saveBack(c) {
  const expires = new Date(c.expires).toISOString()
  if (c.dbKey) {
    let db
    try {
      db = await openDB(cliDB(), false)
      db.exec("PRAGMA busy_timeout = 3000")
      const row = db.prepare("SELECT value FROM auth_kv WHERE key = ?").get(c.dbKey)
      if (!row?.value) return
      const m = JSON.parse(row.value)
      Object.assign(m, { access_token: c.access, refresh_token: c.refresh, expires_at: expires })
      if (c.profile && c.method === "social") m.profile_arn = c.profile
      db.prepare("UPDATE auth_kv SET value = ? WHERE key = ?").run(JSON.stringify(m), c.dbKey)
    } catch {
    } finally {
      db?.close()
    }
  } else if (c.idePath) {
    try {
      const m = JSON.parse(await readFile(c.idePath, "utf8"))
      Object.assign(m, { accessToken: c.access, refreshToken: c.refresh, expiresAt: expires })
      await writeFile(c.idePath + ".magpie-tmp", JSON.stringify(m, null, 2), { mode: 0o600 })
      await rename(c.idePath + ".magpie-tmp", c.idePath)
    } catch {}
  }
}

// ---- tokens --------------------------------------------------------------------

// EXPIRED is the built-in's words for a sign-in Kiro refused, or one with
// nothing to refresh it.
const EXPIRED = "Kiro's sign-in has expired; sign in again"
const EXPIRED_CLI = EXPIRED + " with `kiro-cli login` or the Kiro IDE"

// gone is an error saying the sign-in itself is gone — refused, or never
// there. The built-in marked no Kiro account lapsed, not even then, nor
// cleared one: every answer says the account is kept. The usage read says
// expired for it, and renewed for a clean read (auth.usage).
const gone = (msg) => Object.assign(new Error(msg), { gone: true })
const EARLY_MS = 2 * 60 * 1000 // a token this close to its end is refreshed before a request
const LEAD_MS = 10 * 60 * 1000 // and this close, magpie renews it ahead of time (auth.refresh)
const fresh = (c, early = EARLY_MS) => c.method === "apikey" || !c.expires || c.expires - Date.now() > early

async function post(url, contentType, body, headers = {}) {
  let res
  try {
    res = await fetch(url, { method: "POST", headers: { "Content-Type": contentType, Accept: "application/json", ...headers }, body,
      signal: AbortSignal.timeout(30_000) })
  } catch (e) {
    throw new Error("refreshing Kiro's sign-in: " + e.message)
  }
  const text = await res.text()
  if (!res.ok) {
    if ([400, 401, 403].includes(res.status)) throw gone(EXPIRED_CLI)
    throw new Error(`refreshing Kiro's sign-in: ${res.status} ${STATUS_TEXT[res.status] ?? ""}`.trimEnd()) // Go's res.Status
  }
  return JSON.parse(text)
}

// refresh refreshes a sign-in's token the way its owner would: kiro-cli's
// by kiro-cli first.
async function refresh(c) {
  if (c.dbKey) {
    const bin = kiroExecutable()
    if (bin) {
      await new Promise((r) => execFile(bin, ["debug", "refresh-auth-token"], { timeout: 20_000 }, () => r()))
      const n = await readCLI()
      if (n && n.dbKey === c.dbKey && n.access !== c.access && fresh(n)) return n
    }
  }
  if (!c.refresh) throw gone(EXPIRED_CLI)
  let out
  switch (c.method) {
    case "social": {
      const r = await post(refreshURL(c.region), "application/json", JSON.stringify({ refreshToken: c.refresh }), { "User-Agent": DESKTOP_UA })
      out = { access: r.accessToken, refresh: r.refreshToken, expiresIn: r.expiresIn }
      if (r.profileArn) c.profile = r.profileArn
      break
    }
    case "idc": {
      const r = await post(oidc(c.region) + "/token", "application/json",
        JSON.stringify({ clientId: c.clientId, clientSecret: c.clientSecret, refreshToken: c.refresh, grantType: "refresh_token" }))
      out = { access: r.accessToken, refresh: r.refreshToken, expiresIn: r.expiresIn }
      break
    }
    case "external-idp": {
      if (!c.tokenURL) throw gone(EXPIRED + " with `kiro-cli login`")
      const form = new URLSearchParams({ grant_type: "refresh_token", client_id: c.clientId ?? "", refresh_token: c.refresh })
      const r = await post(c.tokenURL, "application/x-www-form-urlencoded", form.toString())
      out = { access: r.access_token, refresh: r.refresh_token, expiresIn: r.expires_in }
      break
    }
    default:
      throw gone("Kiro's sign-in has expired")
  }
  if (!out.access) throw gone(EXPIRED_CLI)
  const n = { ...c, access: out.access, expires: Date.now() + (out.expiresIn > 0 ? out.expiresIn : 3600) * 1000 }
  if (out.refresh) n.refresh = out.refresh
  await saveBack(n)
  return n
}

// headers say who is calling: the token, and what kind it is.
function authHeaders(a) {
  const h = { Authorization: `Bearer ${a.token}` }
  if (a.tokenType) h.tokentype = a.tokenType
  return h
}
const tokenType = (c) => (c.method === "apikey" ? "API_KEY" : c.method === "external-idp" ? "EXTERNAL_IDP" : "")

// region is where the account's API is: the region its profile is in, else
// the nearer of Kiro's two to where it signed in.
function regionOf(profile, signedIn) {
  const parts = String(profile ?? "").split(":")
  if (parts.length > 4 && parts[3]) return parts[3]
  return String(signedIn ?? "").startsWith("eu-") ? "eu-central-1" : "us-east-1"
}

// STATUS_TEXT is Go's http.StatusText for the answers Kiro gives.
const STATUS_TEXT = { 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 408: "Request Timeout",
  409: "Conflict", 413: "Request Entity Too Large", 429: "Too Many Requests", 500: "Internal Server Error", 502: "Bad Gateway",
  503: "Service Unavailable", 504: "Gateway Timeout" }

class KiroError extends Error {
  constructor(status, body) {
    let msg = ""
    try {
      msg = JSON.parse(body)?.message ?? ""
    } catch {}
    super(msg ? `Kiro: ${msg} (${status})` : `Kiro: ${STATUS_TEXT[status] ?? ""}`)
    this.status = status
    this.body = String(body ?? "")
  }
}

// managementCall calls Kiro's management API: GET with a query, or POST
// with a JSON body.
async function managementCall(region, a, method, query, body) {
  let url = `${management(region)}/${method}`
  if (!body && query) url += "?" + new URLSearchParams(query)
  const res = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: { ...authHeaders(a), Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  })
  const text = await res.text()
  if (!res.ok) throw new KiroError(res.status, text)
  return JSON.parse(text)
}

// controlCall is one of Kiro's management operations as kiro-cli sends it
// for an API key: AWS JSON 1.0, the operation named in X-Amz-Target, POSTed
// to the endpoint's root (with ?origin=KIRO_CLI where kiro-cli adds it).
async function controlCall(region, a, target, body, query) {
  const res = await fetch(management(region) + "/" + (query ? "?" + new URLSearchParams(query) : ""), {
    method: "POST",
    headers: { ...authHeaders(a), "Content-Type": "application/x-amz-json-1.0", "X-Amz-Target": target,
      "x-amzn-codewhisperer-optout": "false" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  })
  const text = await res.text()
  if (!res.ok) throw new KiroError(res.status, text)
  return JSON.parse(text)
}

// KEY_REGIONS are where kiro-cli asks GetProfile for an API key's profile,
// in its order (the GovCloud and ISO ones after them aren't Kiro's
// subscriptions).
const KEY_REGIONS = ["us-east-1", "eu-central-1"]

// keyProfile is an API key's profile, as kiro-cli finds it: GetProfile in
// each region until one answers with a profile. kiro-cli goes on without
// one when every region turns it down (a key from an account with no
// CodeWhisperer profile answers 400), and so does this: "" then, and the
// key's calls are made in us-east-1 without a profile, as kiro-cli makes
// them (Hollowhere, on magpie's Discord: a key kiro-cli 2.33.1 served
// failed every request here with "Kiro didn't take the API key: 400").
async function keyProfile(c) {
  for (const region of KEY_REGIONS) {
    try {
      const arn = (await controlCall(region, { token: c.access, tokenType: "API_KEY" }, "AmazonCodeWhispererService.GetProfile", {}))
        ?.profile?.arn
      if (arn) return arn
    } catch {}
  }
  return ""
}

// profileOf finds the profile a sign-in that doesn't name one uses:
// Builder ID's, or the first Kiro lists in either of its regions.
async function profileOf(c) {
  if (c.builderID) return BUILDER_ID_PROFILE
  let last
  for (const region of ["us-east-1", "eu-central-1"]) {
    try {
      const out = await managementCall(region, { token: c.access, tokenType: tokenType(c) }, "List-Available-Profiles", null, {})
      const arn = (out?.profiles ?? []).find((p) => p?.arn)?.arn
      if (arn) return arn
    } catch (e) {
      // a Builder ID sign-in the token didn't say was one
      if (c.method === "idc" && e?.status === 403 && e.body.includes("Builder ID")) return BUILDER_ID_PROFILE
      last = e
    }
  }
  throw last ?? new Error("Kiro has no profile for this sign-in")
}

// ---- an Identity Center account's credit regions ----------------------------------
//
// An Identity Center account has a profile, and a month's credits, in each
// of Kiro's regions its organization enabled for it: each region's credits
// are its own, with its own overage cap. A request goes to one region; once
// that region's credits are used up the account goes on in the other, and
// only with every enabled region used up is it used up for magpie.
const CREDIT_REGIONS = ["us-east-1", "eu-central-1"]
const twoRegions = (c) => c.method === "idc" && !c.builderID
// magpie's switches for the provider (auth.options), one for each credit
// region: with one on, an Identity Center account uses that region alone.
// They are read at each request, so a change needs no restart. A request is
// never sent to the other region: this one not enabled for the account, or
// used up, is a 429 for magpie to go on to another account. Both off is the
// default, the regions in turn; both on says nothing, and is the default too.
const onlyOption = (region) => region + "-only"
const onlyRegion = (magpie) => {
  try {
    const on = CREDIT_REGIONS.filter((r) => magpie?.option?.(ID, onlyOption(r)) === true)
    return on.length === 1 ? on[0] : ""
  } catch {
    return ""
  }
}
const SPENT_MS = 60 * 60 * 1000 // a region Kiro said is used up, with no reset known, rests this long
const PROBE_MS = 10 * 60 * 1000 // a region with no profile is asked for one again at most this often
const REMIND_SHARE = 80 // the share at which a region not enabled is pointed out

// regionKey names an account for its credit regions: kiro-cli's or the
// IDE's by where it is read, one signed in here by its client and name,
// which outlive its tokens
const regionKey = (auth) => (auth?.source ? "source:" + auth.source : "own:" + (auth?.clientId ?? "") + ":" + (auth?.accountId ?? ""))
const sameProfiles = (a, b) => {
  const ka = Object.keys(a ?? {}), kb = Object.keys(b ?? {})
  return ka.length === kb.length && ka.every((k) => a[k] === b?.[k])
}
const firstProfile = (profiles) => CREDIT_REGIONS.map((r) => profiles?.[r]).find(Boolean) ?? Object.values(profiles ?? {})[0] ?? ""

// profilesOf is every profile Kiro lists for a sign-in, by its region.
async function profilesOf(c) {
  const found = {}
  let last
  for (const region of CREDIT_REGIONS) {
    try {
      const out = await managementCall(region, { token: c.access, tokenType: tokenType(c) }, "List-Available-Profiles", null, {})
      for (const p of out?.profiles ?? []) if (p?.arn) found[regionOf(p.arn, region)] ??= p.arn
    } catch (e) {
      // a Builder ID sign-in the token didn't say was one
      if (c.method === "idc" && e?.status === 403 && e.body.includes("Builder ID")) return { [regionOf(BUILDER_ID_PROFILE)]: BUILDER_ID_PROFILE }
      last = e
    }
  }
  if (!Object.keys(found).length) throw last ?? new Error("Kiro has no profile for this sign-in")
  return found
}

// usedUpSaid is whether Kiro's words say the credits are used up, rather
// than that it is asked too fast.
const usedUpSaid = (msg) => /MONTHLY_REQUEST_COUNT|USAGE_LIMIT/.test(String(msg ?? ""))

// usageLimits is Get-Usage-Limits: the plan, the account's email, credits.
function usageLimits(a, email) {
  // an API key's, as kiro-cli asks for it: no profile, no email asked
  if (a.tokenType === "API_KEY") return controlCall(a.region, a, "AmazonCodeWhispererService.GetUsageLimits", { origin: "KIRO_CLI" }, { origin: "KIRO_CLI" })
  return managementCall(a.region, a, "Get-Usage-Limits",
    { origin: "KIRO_CLI", profileArn: a.profile, resourceType: "CREDIT", isEmailRequired: String(email) })
}

// planName is the subscription's name as Kiro gives it ("KIRO FREE"), said
// "Kiro Free".
const planName = (title) =>
  String(title ?? "").toLowerCase().split(/\s+/).filter(Boolean).map((w) => (w === "kiro" ? "Kiro" : w[0].toUpperCase() + w.slice(1))).join(" ")

// goG is Go's %g of x: an exponent from a million up.
function goG(x) {
  const [m, e] = x.toExponential().split("e")
  const exp = Number(e)
  if (exp < -4 || exp >= 6) return `${m}e${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`
  return String(x)
}

// usageOf is the allowance Get-Usage-Limits tells, as magpie's built-in
// said it: the account's email, the credits of each allowance, the month's and a free trial's
// while it runs. Each window carries its count (amount, limit, unit), so
// magpie can say what is left of it when the user shows what is left
// (#408): display alone is the vendor's text, which magpie can't turn
// round.
//
// Bonus credits (each allowance's bonuses: a first upgrade's trial credits,
// a promotion's) are a window each while ACTIVE and not expired, after the
// month's: their count, and when they lapse (runsOutAt), as they don't
// reset. They are shown only (aside). Kiro spends the plan's credits
// first, then these, so a month used up while a bonus has credits left
// is set aside too, and the account isn't taken for spent.
//
// With overage on, Kiro goes on past the plan's credits, billed as post-paid
// credits, until those reach the overage cap. The cap counts the overage
// alone, not the plan's credits with it: it is the profile's "maximum
// allowed overage" quota (in USD, $0.04 a credit; $400 is 10000 credits).
// So with overage on the month is two windows, as the Kiro IDE shows it:
// the plan's credits (12589.24 used of a 10000 plan is "10000 / 10000"),
// shown only, as using them up doesn't stop the account, and the overage
// (2589.24 / 37500), which does (wizcheu on X). With overage off the cap Kiro
// still sends means nothing, and the plan's credits are the month.
const count = (used, limit) => used.toFixed(2).replace(/0+$/, "").replace(/\.$/, "") + " / " + goG(limit)
const num = (x) => (typeof x === "number" && Number.isFinite(x) ? x : 0)
const overageOn = (l) =>
  String(l?.overageConfiguration?.overageStatus ?? "").toUpperCase() === "ENABLED" || l?.overageConfiguration?.overageEnabled === true

// readUsage is usageOf with the month's windows named: plan, the plan's
// credits, and stop, the window that stops the account (the overage's
// with overage on, else plan itself).
function readUsage(l, now = Date.now()) {
  const at = (secs) => (secs > 0 ? new Date(Math.trunc(secs) * 1000).toISOString() : undefined)
  const overage = overageOn(l)
  const windows = []
  let plan, stop
  for (const u of l?.usageBreakdownList ?? []) {
    const t = u?.freeTrialInfo
    if (t && String(t.freeTrialStatus ?? "").toUpperCase() === "ACTIVE" && num(t.usageLimitWithPrecision) > 0) {
      const used = num(t.currentUsageWithPrecision), limit = num(t.usageLimitWithPrecision)
      windows.push({ name: "Free trial", used: (100 * used) / limit, resetsAt: at(num(t.freeTrialExpiry)), display: count(used, limit),
        amount: used, limit, unit: "credits" })
    }
    const bonuses = []
    for (const b of Array.isArray(u?.bonuses) ? u.bonuses : []) {
      const used = num(b?.currentUsage), limit = num(b?.usageLimit), expires = num(b?.expiresAt)
      if (String(b?.status ?? "").toUpperCase() !== "ACTIVE" || limit <= 0 || (expires > 0 && expires * 1000 <= now)) continue
      const left = Math.max(0, limit - used)
      bonuses.push({ name: b?.displayName || "Bonus credits", used: (100 * used) / limit, display: count(used, limit),
        amount: used, limit, unit: "credits", ...(expires > 0 && left > 0 ? { runsOutAt: at(expires), runsOut: left } : {}), aside: true })
    }
    const used = num(u?.currentUsageWithPrecision), limit = num(u?.usageLimitWithPrecision)
    const cap = overage ? num(u?.overageCapWithPrecision) || num(u?.overageCap) : 0
    const reset = at(num(u?.nextDateReset) || num(l?.nextDateReset))
    const month = { resetsAt: reset, unit: "credits", span: 30 * 24 * 3600 }
    const name = u?.displayNamePlural || u?.displayName || "Credits"
    const left = bonuses.some((b) => b.amount < b.limit)
    if (cap > 0) {
      // what Kiro says of the overage, else what is past the plan
      const said = typeof u?.currentOveragesWithPrecision === "number" ? u.currentOveragesWithPrecision : u?.currentOverages
      const over = typeof said === "number" && Number.isFinite(said) ? said : Math.max(0, used - limit)
      const inPlan = Math.min(used, limit)
      plan = limit > 0 ? { name, used: (100 * inPlan) / limit, display: count(inPlan, limit), amount: inPlan, limit, ...month, aside: true } : undefined
      stop = { name: "Overage", used: (100 * over) / cap, display: count(over, cap), amount: over, limit: cap, ...month,
        ...(over >= cap && left ? { aside: true } : {}) }
      windows.push(...(plan ? [plan] : []), stop)
      plan ??= stop
    } else if (limit > 0) {
      plan = stop = { name, used: (100 * used) / limit, display: count(used, limit), amount: used, limit, ...month,
        ...(used >= limit && left ? { aside: true } : {}) }
      windows.push(plan)
    }
    windows.push(...bonuses)
  }
  const email = l?.userInfo?.email
  const usage = { plan: planName(l?.subscriptionInfo?.subscriptionTitle), ...(typeof email === "string" && email ? { user: email } : {}), windows }
  return { usage, plan, stop }
}

const usageOf = (l, now = Date.now()) => readUsage(l, now).usage

// regionsUsage is an Identity Center account's credits from each region's
// read (reads: { region, l } read, { region, error } not, { region,
// missing } with no profile, not enabled): each region's month shown only,
// and their sum the window magpie weighs the account by, used up only when
// every region read is. With overage on, the plans' sum comes first, shown
// only, then the overages' sum weighs the account. A free trial or bonus
// credits are the first read region's. regions says, of each region read,
// whether it is used up and when it resets. Regions read come first, then
// those that couldn't be read, then those not enabled: a card that shows
// only the first few windows then shows the credits an account has.
function regionsUsage(reads, now = Date.now(), only = "") {
  const shown = []
  const failed = []
  const off = []
  const regions = []
  const missing = []
  let amount = 0, limit = 0, inPlan = 0, ofPlan = 0, resets = 0, first, monthName, anyOver = false, allOver = true
  for (const r of reads) {
    const name = `Credits (${r.region})`
    if (r.error) {
      failed.push({ name, display: "couldn't be read", aside: true })
      continue
    }
    if (!r.l) {
      missing.push(r.region)
      off.push({ name, display: "not enabled", aside: true })
      continue
    }
    const { usage: u, plan, stop } = readUsage(r.l, now)
    first ??= u
    if (!stop) continue
    const over = stop !== plan
    // an account set to one region counts that region alone, the other
    // shown only: its credits are not the account's to spend
    const counted = !only || r.region === only
    if (counted) {
      anyOver ||= over
      allOver &&= over
    }
    monthName ??= plan.name
    if (!counted) {
      shown.push({ ...plan, name: `${plan.name} (${r.region})`, aside: true })
      if (over) shown.push({ ...stop, name: `${stop.name} (${r.region})`, aside: true })
      regions.push({ region: r.region, full: stop.amount >= stop.limit, resetsAt: Date.parse(stop.resetsAt ?? "") > 0 ? Date.parse(stop.resetsAt) : 0 })
      continue
    }
    amount += stop.amount
    limit += stop.limit
    inPlan += plan.amount
    ofPlan += plan.limit
    const at = Date.parse(stop.resetsAt ?? "")
    if (at > 0 && (!resets || at < resets)) resets = at
    shown.push({ ...plan, name: `${plan.name} (${r.region})`, aside: true })
    if (over) shown.push({ ...stop, name: `${stop.name} (${r.region})`, aside: true })
    regions.push({ region: r.region, full: stop.amount >= stop.limit, resetsAt: at > 0 ? at : 0 })
  }
  const windows = []
  const resetsAt = resets ? { resetsAt: new Date(resets).toISOString() } : {}
  if (limit > 0) {
    if (anyOver && ofPlan > 0)
      windows.push({ name: monthName, used: (100 * inPlan) / ofPlan, ...resetsAt, display: count(inPlan, ofPlan), amount: inPlan, limit: ofPlan,
        unit: "credits", span: 30 * 24 * 3600, aside: true })
    let display = count(amount, limit)
    if (missing.length && (100 * amount) / limit >= REMIND_SHARE) display += ` · ${missing.join(", ")} not enabled: ask your admin to enable it`
    windows.push({ name: allOver ? "Overage" : monthName, used: (100 * amount) / limit, ...resetsAt,
      display, amount, limit, unit: "credits", span: 30 * 24 * 3600 })
  }
  windows.push(...shown, ...failed, ...off, ...(first?.windows ?? []).filter((w) => !w.span))
  const { windows: _w, ...who } = first ?? {}
  return { usage: { ...who, windows }, regions, missing }
}

// ---- the account, as the plugin holds it -------------------------------------------

// credOf is the sign-in a stored auth names: a key, one signed in here, or
// kiro-cli's or the IDE's, read where they keep it now.
async function credOf(auth) {
  if (auth?.type === "api" && auth.key) return { access: auth.key, method: "apikey", region: "us-east-1" }
  if (auth?.type !== "oauth") return null
  if (auth.source === "kiro-cli") return readCLI()
  if (auth.source === "kiro-ide") return readIDE()
  if (auth.source === "kiro") return (await readCLI()) ?? (await readIDE())
  if (!auth.access) return null
  return { access: auth.access, refresh: auth.refresh ?? "", expires: auth.expires ?? 0, method: auth.method || "social",
    region: auth.region || "us-east-1", profile: auth.profileArn ?? "", clientId: auth.clientId ?? "", clientSecret: auth.clientSecret ?? "",
    builderID: isBuilderID(auth.loginProvider), own: true,
    ...(auth.profiles && typeof auth.profiles === "object" && !Array.isArray(auth.profiles) ? { profiles: { ...auth.profiles } } : {}) }
}

// Account holds the credentials in use, refreshing them when near their
// end or when Kiro turned one down; one refresh at a time, as a refresh
// may replace the refresh token.
//
// after is what each refresh gave, by the access token it replaced: a
// sign-in read with that token (its save failed, or magpie hasn't yet
// saved what auth.refresh gave) goes on with the newer one rather than
// spending the replaced refresh token again.
function account(client, magpie) {
  let held = null // { id, c }
  const after = new Map()
  const newest = (c) => {
    for (let i = 0; i < 16 && after.has(c.access); i++) c = { ...after.get(c.access) }
    return c
  }
  const renewed = (c, n) => {
    after.set(c.access, n)
    if (after.size > 16) after.delete(after.keys().next().value)
    return n
  }
  let lock = Promise.resolve()
  const locked = (fn) => {
    const run = lock.then(fn, fn)
    lock = run.catch(() => {})
    return run
  }
  // an account signed in here before its uid was kept is given it, so a
  // sign-in with another way to the same email no longer replaces it
  const uidSaved = new Set()
  const uidField = (auth) => (!auth?.uid && uidOf(auth?.loginProvider) ? { uid: uidOf(auth.loginProvider) } : {})
  // and one called by its bare email is given its name, the way it was
  // signed in to with it
  const nameField = (auth) =>
    bareEmail(auth?.accountId) && nameOf(auth.accountId, auth.loginProvider) !== auth.accountId
      ? { accountId: nameOf(auth.accountId, auth.loginProvider) } : {}
  const idFields = (auth) => ({ ...uidField(auth), ...nameField(auth) })
  const save = async (auth, c) => {
    if (!c.own || !client?.auth?.set) return
    const { type: _t, ...rest } = auth
    await client.auth.set({ path: { id: ID }, body: { ...rest, type: "oauth", access: c.access, refresh: c.refresh, expires: c.expires,
      profileArn: c.profile, region: c.region, ...(c.profiles ? { profiles: c.profiles } : {}), ...idFields(auth) } }).catch(() => {})
  }
  // each account's credit regions (twoRegions), by regionKey: their
  // profiles, when they were last asked for, and the regions used up till
  // when. One plugin serves every account, so this is kept by account.
  const regionStates = new Map()
  const stateOf = (key) => {
    let st = regionStates.get(key)
    if (!st) regionStates.set(key, (st = { profiles: {}, probed: 0, spent: {}, builderID: false }))
    return st
  }
  const creds = (auth, stale = false) =>
    locked(async () => {
      const id = auth?.type === "api" ? "key:" + auth.key : "oauth:" + (auth?.source ?? "own")
      // what its owner holds now: it may have refreshed it, signed out, or
      // signed in to another account since
      let read = await credOf(auth)
      if (!read) {
        held = null
        throw gone(
          auth?.source
            ? "Kiro isn't signed in; add the Kiro subscription in magpie, sign in with `kiro-cli login` or the Kiro IDE, or save a Kiro API key on the provider"
            : "this Kiro account's sign-in is gone; add it again in magpie",
        )
      }
      read = newest(read)
      let c = held?.id === id ? held.c : null
      let saved = false
      if (!c || read.access !== c.access || !fresh(c) || stale) {
        if (!read.profile && c && read.access === c.access) read.profile = c.profile
        if (stale && c && read.access !== c.access && fresh(read)) stale = false // the owner refreshed it already
        c = read
        if (!fresh(c) || stale) {
          if (c.method === "apikey") throw gone("Kiro turned down the API key saved on the provider")
          c = renewed(c, await refresh(c))
          await save(auth, c)
          saved = true
        }
      }
      const key = regionKey(auth)
      const st = stateOf(key)
      if (twoRegions(c) && !st.builderID) {
        c.profiles = { ...st.profiles, ...c.profiles }
        if (c.profile) c.profiles[regionOf(c.profile, c.region)] ??= c.profile
        if (CREDIT_REGIONS.some((r) => !c.profiles[r]) && Date.now() - st.probed > PROBE_MS) {
          st.probed = Date.now()
          try {
            const found = await profilesOf(c)
            if (Object.values(found).includes(BUILDER_ID_PROFILE)) {
              st.builderID = true
              c.profile ||= BUILDER_ID_PROFILE
            } else c.profiles = { ...c.profiles, ...found }
          } catch {}
        }
        st.profiles = c.profiles
        if (st.builderID) delete c.profiles
        if (!c.profile) c.profile = firstProfile(c.profiles)
        if (!saved && c.own && c.profile && (st.builderID ? !auth?.profileArn : !sameProfiles(c.profiles, auth?.profiles))) {
          await save(auth, c)
          saved = true
        }
      }
      if (c.method === "apikey") {
        if (!c.asked) {
          c.profile = await keyProfile(c)
          c.asked = true
        }
      } else if (!c.profile) {
        c.profile = await profileOf(c)
        if (!auth?.profileArn && !saved) {
          await save(auth, c)
          saved = true
        }
      }
      // once per token: a save that didn't take isn't tried on every request
      if (!saved && c.own && Object.keys(idFields(auth)).length && !uidSaved.has(c.access)) {
        uidSaved.add(c.access)
        await save(auth, c)
      }
      held = { id, c }
      // kiro-cli names no profile in an API key's calls, even one GetProfile
      // found; the profile only says the key's region
      const profile = c.method === "apikey" ? "" : c.profile
      const a = { token: c.access, tokenType: tokenType(c), idc: c.method === "idc", profile, region: regionOf(c.profile, c.region) }
      if (!twoRegions(c) || st.builderID || !c.profiles) return a
      // the first enabled region with credits left, in CREDIT_REGIONS' order
      const now = Date.now()
      const only = onlyRegion(magpie)
      const open = CREDIT_REGIONS.filter((r) => c.profiles[r] && (!only || r === only))
      const pick = open.find((r) => !(st.spent[r] > now))
      if (pick) Object.assign(a, { region: pick, profile: c.profiles[pick] })
      // pinned to a region this account lacks, or has used up: no region to
      // send to, which ask() answers as every region used up
      else if (only) return { ...a, region: only, profile: "", key, profiles: { ...c.profiles }, open, pinned: only }
      return { ...a, key, profiles: { ...c.profiles }, open }
    })
  // spend marks a region of an account used up till until (0: SPENT_MS from
  // now), or, with until -1, as having credits again
  creds.spend = (key, region, until = 0) => {
    const st = stateOf(key)
    if (until < 0) delete st.spent[region]
    else st.spent[region] = until > Date.now() ? until : Date.now() + SPENT_MS
  }
  // renew is auth.refresh's: a sign-in kept here (not kiro-cli's or the
  // IDE's, which their owners keep) renewed under the same lock as the
  // requests' refresh, so the two never spend one refresh token. It saves
  // nothing — magpie saves what it gives — and gives only what changed.
  creds.renew = (auth) =>
    locked(async () => {
      const read = await credOf(auth)
      if (!read?.own || !read.refresh) return undefined
      let c = newest(read)
      // renewed here already (a request's refresh, or this hook's whose
      // result magpie hasn't saved yet), the store not yet saying so
      if (c.access === read.access || !fresh(c, LEAD_MS)) c = renewed(c, await refresh(c))
      held = { id: "oauth:own", c }
      const out = { access: c.access, expires: c.expires }
      if (c.refresh !== auth.refresh) out.refresh = c.refresh
      if (c.profile && c.profile !== auth.profileArn) out.profileArn = c.profile
      return { ...out, ...idFields(auth) }
    })
  return creds
}

// ---- models ----------------------------------------------------------------------

const windows = new Map() // a model's context, as Kiro last listed it
const natives = new Map() // a model's effort levels sent as fields, as Kiro last listed them (nativeOf)

// nativeOf is what a model's additionalModelRequestFieldsSchema in Kiro's
// list offers, read as Kiro IDE reads it: the effort levels in the enum of
// output_config's (or reasoning's) effort, and whether thinking.type may be
// "adaptive". A model offering both is sent the caller's effort in
// additionalModelRequestFields, as the IDE sends it; any other keeps the
// <max_thinking_length> budget (#538).
function nativeOf(s) {
  if (!s || typeof s !== "object" || Array.isArray(s)) return undefined
  const types = s.properties?.thinking?.properties?.type?.enum
  if (!Array.isArray(types) || !types.includes("adaptive")) return undefined
  for (const path of ["output_config", "reasoning"]) {
    const levels = s.properties?.[path]?.properties?.effort?.enum
    if (Array.isArray(levels) && levels.length) return { path, levels }
  }
  return undefined
}

const thinks = (id) => /claude/i.test(id) || id === "auto"
// the levels a thinking model offers, as the built-in thinks them (xhigh as
// long as max: #120)
const BUDGETS = { low: 10000, medium: 20000, high: 30000, xhigh: 50000, max: 50000 }

function configModel(m) {
  return {
    name: m.name,
    limit: { context: m.context ?? 0, output: m.output ?? 0 },
    ...(m.images ? { attachment: true, modalities: { input: ["text", "image"], output: ["text"] } } : {}),
    ...(thinks(m.id)
      ? { reasoning: true, variants: Object.fromEntries(Object.entries(BUDGETS).map(([k, b]) => [k, { thinking: { type: "enabled", budgetTokens: b } }])) }
      : {}),
    tool_call: true,
    // magpie's own: the credit multiplier Kiro lists for the model
    ...(m.rate ? { rate: m.rate } : {}),
  }
}

function runtimeModel(m) {
  const input = { text: true, image: !!m.images, audio: false, video: false, pdf: false }
  return {
    id: m.id,
    providerID: ID,
    name: m.name ?? m.id,
    api: { id: m.id, url: BASE, npm: MESSAGES },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: m.context ?? 0, output: m.output ?? 0 },
    capabilities: {
      temperature: true,
      reasoning: thinks(m.id),
      attachment: !!m.images,
      toolcall: true,
      input,
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
    // magpie's own: the credit multiplier Kiro lists for the model
    ...(m.rate ? { rate: m.rate } : {}),
    variants: thinks(m.id) ? Object.fromEntries(Object.entries(BUDGETS).map(([k, b]) => [k, { thinking: { type: "enabled", budgetTokens: b } }])) : {},
  }
}

// Kiro's own list is asked for once signed in; until then, Auto, which
// picks a model for each request.
const MODELS = [{ id: "auto", name: "Auto" }]

// keyModels is an API key's list, asked as kiro-cli asks it: Kiro's
// control plane's ListAvailableModels, with no profile, each page.
async function keyModels(a) {
  const out = { models: [] }
  let next
  for (let i = 0; i < 20; i++) {
    const page = await controlCall(a.region, a, "KiroControlPlaneBearerService.ListAvailableModels",
      { origin: "KIRO_CLI", ...(next ? { nextToken: next } : {}) }, { origin: "KIRO_CLI" })
    out.models.push(...(page?.models ?? []))
    out.defaultModel ??= page?.defaultModel
    next = page?.nextToken
    if (!next) break
  }
  return out
}

// rateOf is the credits a model's request costs as a multiple, as Kiro's
// list says it (rateMultiplier with rateUnit "Credit": on 11-09 a Free
// account's list had auto 1, claude-sonnet-4.5 1.3, claude-haiku-4.5 0.4,
// glm-5 0.5, deepseek-3.2 and minimax-m2.5 0.25, minimax-m2.1 0.15 and
// qwen3-coder-next 0.05, which kiro-cli 2.x reads as its rate_multiplier).
// Nothing is the rate when Kiro gives none, or gives it in another unit.
// It is only shown: what a request cost is the meteringEvent's credits,
// which Kiro has already multiplied (the same prompt metered 0.00535 on
// claude-haiku-4.5 and 0.01739 on claude-sonnet-4.5, 0.4 to 1.3).
function rateOf(m) {
  const n = m?.rateMultiplier
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return undefined
  return String(m.rateUnit ?? "").toLowerCase() === "credit" ? n : undefined
}

// listModels is List-Available-Models, the default first.
async function listModels(a) {
  const out = a.tokenType === "API_KEY" ? await keyModels(a) : await managementCall(a.region, a, "List-Available-Models", { origin: "KIRO_CLI", profileArn: a.profile })
  const list = []
  for (const m of out?.models ?? []) {
    if (!m?.modelId) continue
    let name = m.modelName
    if (!name || name === m.modelId) name = m.modelId === "auto" ? "Auto" : m.modelId
    const rate = rateOf(m)
    const model = { id: m.modelId, name, context: m.tokenLimits?.maxInputTokens ?? 0, output: m.tokenLimits?.maxOutputTokens ?? 0,
      images: (m.supportedInputTypes ?? []).some((t) => String(t).toUpperCase() === "IMAGE"), ...(rate ? { rate } : {}) }
    if (m.modelId === out?.defaultModel?.modelId) list.unshift(model)
    else list.push(model)
  }
  if (!list.length) throw new Error("Kiro listed no models")
  for (const m of list) windows.set(m.id, m.context)
  for (const m of out?.models ?? []) if (m?.modelId) natives.set(m.modelId, nativeOf(m.additionalModelRequestFieldsSchema))
  return list
}

// ---- the request: Messages → a Kiro conversation ---------------------------------------

const PROCEED = "Please proceed with the task." // Kiro takes no empty message
const NO_RESULT = "Tool use was interrupted and did not produce a result."
const RESULT_LIMIT = 250000 // a tool's output is cut at this, as Kiro's own agent cuts it
const TOOL_ID = /^[a-zA-Z0-9_.:-]{1,64}$/

// toolID is a tool call's id as Kiro takes one: another vendor's becomes
// one of Kiro's own, the same each time.
const toolID = (id) => (TOOL_ID.test(id ?? "") ? id : "t_" + createHash("sha256").update(String(id ?? "")).digest("base64url").slice(0, 32))

// Kiro answers a tool named past 64 characters, or outside these, "Invalid
// tool use format." and won't raise the limit (kirodotdev/Kiro#7684), while
// MCP tools in Claude Code are named mcp__plugin_<plugin>_<server>__<tool>
// (yetone/magpie#1393).
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/

// toolName is a tool's name as Kiro takes one: another is its head with a
// hash of the whole name, the same each time, so the conversation's later
// turns name it the same way. toolNames maps each such name back.
const toolName = (name) => {
  const n = String(name ?? "")
  if (TOOL_NAME.test(n)) return n
  const hash = createHash("sha256").update(n).digest("hex").slice(0, 12)
  return n.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64 - 1 - hash.length) + "_" + hash
}

// toolNames is the name the caller knows for each tool a request names
// that Kiro is sent under another name.
function toolNames(req) {
  const names = new Map()
  const add = (n) => {
    if (typeof n !== "string" || !n) return
    const k = toolName(n)
    if (k !== n) names.set(k, n)
  }
  for (const t of req.tools ?? []) add(t?.name)
  for (const m of req.messages ?? []) if (Array.isArray(m.content)) for (const p of m.content) if (p?.type === "tool_use") add(p.name)
  return names
}

function imageFormat(mediaType) {
  const t = String(mediaType ?? "").toLowerCase()
  const f = t.replace(/^image\//, "")
  if (f === "jpg") return "jpeg"
  if (!f || f === t) return "png"
  return f
}

// addImage puts an Anthropic image block in images as Kiro takes it: the
// bytes inline. One named only by a URL has no bytes to send and is left out.
function addImage(images, p) {
  if (p.source?.type === "base64" && p.source.data) images.push({ format: imageFormat(p.source.media_type), source: { bytes: p.source.data } })
}

// ---- images over Kiro's size limit ---------------------------------------------------
//
// Kiro turns away an image whose Base64 is over 5 MiB, counted on the
// encoded string, not the file (magpie-community/plugins#428):
//   messages.130.content.2.image.source.base64: image exceeds 5 MB maximum:
//   5561904 bytes > 5242880 bytes (IMAGE_SIZE_EXCEEDED)
// 5561904 is that image's Base64 length (4,171,428 bytes decoded), so the
// largest file that fits is 3,932,160 bytes. kiro-cli's own gate is 10 MB of
// raw file (MAX_IMAGE_SIZE, aws/amazon-q-developer-cli chat/consts.rs), which
// lets such an image in and then every later turn fails on it
// (kirodotdev/Kiro#11497). The image stays in history, so each turn would
// fail the same way: an image over the limit is made smaller on the request
// being sent, and one that can't be is replaced by a note.
const IMAGE_LIMIT = 5 * 1024 * 1024 // Base64 characters
const IMAGE_EDGE = 2000 // a shrunk image's long edge: Kiro's web app's limit (kirodotdev/Kiro#8884), above what Claude looks at
const IMAGE_MIN_EDGE = 256
const IMAGE_MAX_PIXELS = 50_000_000 // a decoded image is ~4 bytes a pixel: a 200MB ceiling, and a header claiming more is refused unread
const IMAGE_MAX_INPUT = 64 * 1024 * 1024 // Base64 characters looked at all
const IMAGE_DEADLINE = 30_000 // ms one image may take
const fitted = new Map() // sha256 of the Base64 → Promise of { format, bytes } or { note }, newest last
const FITTED_KEEP = 4

const mib = (n) => (n / (1024 * 1024)).toFixed(1) + " MB"

// shrink tries, in order, the image's own kind at Claude's size, then a
// lossy kind (WebP keeps transparency, JPEG stays JPEG) smaller each time,
// until the Base64 fits.
async function shrink(b64) {
  const I = globalThis.Bun?.Image
  if (typeof I !== "function") return { note: "this plugin host can't resize images" }
  const started = Date.now()
  const raw = Buffer.from(b64, "base64")
  let meta
  try {
    meta = await new I(raw, { maxPixels: IMAGE_MAX_PIXELS }).metadata()
  } catch (e) {
    return { note: e?.code === "ERR_IMAGE_TOO_MANY_PIXELS" ? "it has too many pixels to resize" : "it couldn't be read as an image" }
  }
  const long = Math.max(meta.width, meta.height)
  const jpeg = meta.format === "jpeg"
  const own = jpeg ? { format: "jpeg", opts: { quality: 85 } } : meta.format === "webp" ? { format: "webp", opts: { quality: 85 } } : { format: "png", opts: { compressionLevel: 9 } }
  const lossy = (quality) => (jpeg ? { format: "jpeg", opts: { quality } } : { format: "webp", opts: { quality } })
  const tries = [{ edge: Math.min(long, IMAGE_EDGE), ...own }, { edge: Math.min(long, IMAGE_EDGE), ...lossy(80) }]
  for (let edge = Math.min(long, IMAGE_EDGE) * 0.7; edge >= IMAGE_MIN_EDGE; edge *= 0.7) tries.push({ edge: Math.round(edge), ...lossy(75) })
  for (const t of tries) {
    if (Date.now() - started > IMAGE_DEADLINE) return { note: "resizing it took too long" }
    let out
    try {
      let img = new I(raw, { maxPixels: IMAGE_MAX_PIXELS })
      if (t.edge < long) img = img.resize(t.edge, t.edge, { fit: "inside", withoutEnlargement: true })
      out = await img[t.format](t.opts).toBase64()
    } catch (e) {
      if (e?.code === "ERR_IMAGE_FORMAT_UNSUPPORTED") continue
      return { note: "it couldn't be resized" }
    }
    if (out.length <= IMAGE_LIMIT) return { format: t.format, bytes: out }
  }
  return { note: "it couldn't be made small enough" }
}

function fitOne(b64) {
  const key = createHash("sha256").update(b64).digest("hex")
  let p = fitted.get(key)
  if (p) fitted.delete(key) // kept as the newest below
  else p = b64.length > IMAGE_MAX_INPUT ? Promise.resolve({ note: "it is too large to resize" }) : shrink(b64).catch(() => ({ note: "it couldn't be resized" }))
  fitted.set(key, p)
  while (fitted.size > FITTED_KEEP) fitted.delete(fitted.keys().next().value)
  return p
}

// fitImages brings every image left in a built request under Kiro's limit,
// in place: the request is the plugin's own copy, never the caller's. An
// image already under it is sent as it is.
async function fitImages(out) {
  const s = out.conversationState
  const users = [...(s.history ?? []).map((e) => e.userInputMessage), s.currentMessage.userInputMessage].filter(Boolean)
  for (const u of users) {
    if (!u.images?.length) continue
    const kept = []
    const notes = []
    for (const img of u.images) {
      const b64 = img.source?.bytes
      if (typeof b64 !== "string" || b64.length <= IMAGE_LIMIT) {
        kept.push(img)
        continue
      }
      const r = await fitOne(b64)
      if (r.bytes) kept.push({ ...img, format: r.format, source: { ...img.source, bytes: r.bytes } })
      else
        notes.push(
          `[An image (${img.format}, ${mib(b64.length)} as Base64) was left out of this message: Kiro takes at most ${mib(IMAGE_LIMIT)} per image, and ${r.note}.]`,
        )
    }
    if (kept.length) u.images = kept
    else delete u.images
    if (notes.length) u.content = joinNonEmpty(u.content, notes.join("\n"))
  }
  return out
}

const textOf = (c) =>
  typeof c === "string" ? c : Array.isArray(c) ? c.filter((p) => p?.type === "text").map((p) => p.text ?? "").join("\n\n") : ""
const joinNonEmpty = (a, b) => (a && b ? a + "\n\n" + b : a + b)

function documentText(p) {
  const title = p.title ? `${p.title}\n` : ""
  if (p.source?.type === "text") return title + (p.source.data ?? "")
  if (p.source?.type === "content") return title + textOf(p.source.content)
  return `${title}[a ${p.source?.media_type ?? "document"} attachment]`
}

// thinking is whether the model is asked to think aloud, and for how
// long: when the caller asked for it, of a Claude model (or Auto). Only a
// thinking of type enabled or adaptive asks for it, as Anthropic's API
// reads a request: an effort with no thinking (Claude Code's title and
// other side requests, or its main turn with thinking turned off), or with
// thinking disabled, is sent no thinking at any level (#538), as magpie's
// gateway reads it too.
function thinking(req, model) {
  const effort = req.output_config?.effort ?? ""
  const on = req.thinking?.type === "enabled" || req.thinking?.type === "adaptive"
  if (!on || !thinks(String(model).toLowerCase())) return 0
  const budget = { low: 10000, high: 30000, xhigh: 50000, max: 50000 }[effort]
  if (budget) return budget
  if (!effort && req.thinking?.budget_tokens > 0) return req.thinking.budget_tokens
  return 20000
}

// nativeFields is the additionalModelRequestFields a thinking request is
// sent with when Kiro's list says the model takes its effort as a field:
// adaptive thinking at the caller's level, so xhigh and max reach the model
// as two levels rather than one 50000 budget (#538). undefined otherwise.
function nativeFields(req, model) {
  const n = natives.get(model)
  const effort = req.output_config?.effort
  if (!n || typeof effort !== "string" || !n.levels.includes(effort) || !thinking(req, model)) return undefined
  return { thinking: { type: "adaptive" }, [n.path]: { effort } }
}

// formatText is the structured output a request asks for, said in words:
// Anthropic's output_config.format (or the AI SDK's output_format) with a
// JSON schema, "" when it asks for none. A JSON object with no schema
// reaches the plugin already told in the system prompt, as Messages has no
// field for it.
function formatText(req) {
  const f = req.output_config?.format ?? req.output_format
  if (f?.type !== "json_schema" || !f.schema || typeof f.schema !== "object") return ""
  return "Respond with a single JSON value and nothing else, matching this JSON schema:\n" + JSON.stringify(f.schema) + "."
}

// inputSchema is a tool's input schema as Kiro takes it: one whose root
// says type "object". Kiro answers 400 REQUEST_BODY_INVALID to a root with
// properties and no type (Haiku 5.5: the same schema with the type added
// is called), and to {}. A tool's input is always an object, so a root
// that says no type, or object-or-null, is said to be one; the rest of it
// (a union at its root, its properties, $refs, nullable) is sent as given,
// and a root that says another type is left as the caller said it. The
// caller's schema isn't changed: the root is copied.
function inputSchema(s) {
  if (!s || typeof s !== "object" || Array.isArray(s) || !Object.keys(s).length) return { type: "object", properties: {} }
  if (s.type === undefined) return { type: "object", ...s }
  if (Array.isArray(s.type) && s.type.includes("object") && s.type.every((t) => t === "object" || t === "null")) return { ...s, type: "object" }
  return s
}

// buildKiro is the body of a generateAssistantResponse call, as it is
// before its images are fitted (kiroBody).
function buildKiro(req, model, profile, budget, conversation) {
  return JSON.stringify(kiroRequest(req, model, profile, budget, conversation))
}

// kiroBody is the body sent: buildKiro's, with every image it keeps under
// Kiro's size limit.
async function kiroBody(req, model, profile, budget, conversation) {
  return JSON.stringify(await fitImages(kiroRequest(req, model, profile, budget, conversation)))
}

// UNDERSTOOD is the reply Kiro IDE puts in its history where a turn has
// none of its own, before the message being answered
const UNDERSTOOD = "Understood."

// contextFirst is a conversation that ends in system messages (Claude
// Code's environment context, sent after the user's question) with that
// context said first: a turn of its own, answered by Kiro IDE's
// placeholder, before the question, which stays the message being
// answered rather than the head of "question, then context" (#538). The
// instructions' own field isn't used: Kiro refuses it ("systemPrompt field
// is not enabled for this user"). A question carrying tool results, or
// following tool calls, keeps the context in it as before, so no call is
// parted from its result.
function contextFirst(messages) {
  let end = messages.length
  while (end > 0 && messages[end - 1]?.role === "system") end--
  if (end === messages.length) return messages
  let start = end
  while (start > 0 && messages[start - 1]?.role === "user") start--
  const parts = (m) => (typeof m?.content === "string" ? [{ type: "text", text: m.content }] : Array.isArray(m?.content) ? m.content : [])
  const context = messages.slice(end)
  if (start === end || !context.some((m) => parts(m).some((p) => p?.type !== "text" || p.text))) return messages
  const turn = messages.slice(start, end)
  if (turn.some((m) => parts(m).some((p) => p?.type === "tool_result"))) return messages
  if (parts(messages[start - 1]).some((p) => p?.type === "tool_use" || p?.type === "server_tool_use" || p?.type === "web_search_tool_result")) return messages
  return [...messages.slice(0, start), ...context.map((m) => ({ ...m, role: "user" })), { role: "assistant", content: UNDERSTOOD }, ...turn]
}

function kiroRequest(req, model, profile, budget, conversation) {
  const entries = []
  // the messages the caller marked for its prompt cache (cache_control),
  // which go to Kiro as a cachePoint on the message they end up in (#110)
  const marked = new WeakSet()
  const mark = (msg, parts) => {
    if (parts.some((p) => p?.cache_control)) marked.add(msg)
  }
  const user = () => ({ content: "", modelId: model, origin: "AI_EDITOR" })
  const resultsOnly = new WeakSet() // the messages made to carry a reply's web search results
  for (const m of contextFirst(req.messages ?? [])) {
    const parts = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content ?? []
    const texts = []
    if (m.role === "assistant") {
      // a web search's result is in the reply itself (server_tool_use, then
      // web_search_tool_result): to Kiro the reply up to it is a turn of its
      // own, answered by a message carrying the result
      let a = { content: "", toolUses: [] }
      let last = null
      const flush = () => {
        a.content = texts.splice(0).join("\n\n")
        if (!a.content && !a.toolUses.length) return // what only thought
        const prev = entries.at(-1)?.assistantResponseMessage
        if (prev) {
          prev.content = joinNonEmpty(prev.content, a.content)
          prev.toolUses.push(...a.toolUses)
        } else entries.push({ assistantResponseMessage: a })
        last = prev ?? a
        a = { content: "", toolUses: [] }
      }
      for (const p of parts) {
        if (p?.type === "text" && p.text) texts.push(p.text)
        else if (p?.type === "tool_use") {
          const input = p.input && typeof p.input === "object" && !Array.isArray(p.input) ? p.input : {}
          a.toolUses.push({ name: toolName(p.name), toolUseId: toolID(p.id), input })
        } else if (p?.type === "server_tool_use" && p.name === SEARCH_NAME) {
          const input = p.input && typeof p.input === "object" && !Array.isArray(p.input) ? p.input : {}
          a.toolUses.push({ name: SEARCH_NAME, toolUseId: toolID(p.id), input })
        } else if (p?.type === "web_search_tool_result") {
          flush()
          const text = searchedText(p)
          const result = { toolUseId: toolID(p.tool_use_id), status: text === null ? "error" : "success",
            content: [{ text: text ?? searched.get(p.tool_use_id) ?? searchFailedText(p.content?.error_code) }] }
          // parallel searches (both calls, then both results, as
          // Anthropic answers them) are answered in one message
          const prev = entries.at(-1)?.userInputMessage
          if (prev && resultsOnly.has(prev)) prev.userInputMessageContext.toolResults.push(result)
          else {
            const u = { ...user(), images: [], userInputMessageContext: { toolResults: [result] } }
            resultsOnly.add(u)
            entries.push({ userInputMessage: u })
          }
        }
      }
      flush()
      if (last) mark(last, parts)
      continue
    }
    const u = user()
    u.images = []
    const results = []
    for (const p of parts) {
      if (p?.type === "text") {
        if (p.text) texts.push(p.text)
      } else if (p?.type === "document") texts.push(documentText(p))
      else if (p?.type === "image") addImage(u.images, p)
      else if (p?.type === "tool_result") {
        let out = textOf(p.content)
        if (out.length > RESULT_LIMIT) out = out.slice(0, RESULT_LIMIT) + "\n… (cut)"
        results.push({ toolUseId: toolID(p.tool_use_id), status: p.is_error ? "error" : "success", content: [{ text: out || "(no output)" }] })
        // a tool's images (a screenshot, Codex's view_image) go with the
        // message, as Kiro's tool results carry text alone (magpie #369, #1861)
        if (Array.isArray(p.content)) for (const c of p.content) if (c?.type === "image") addImage(u.images, c)
      }
    }
    u.content = texts.join("\n\n")
    if (results.length) u.userInputMessageContext = { toolResults: results }
    const prev = entries.at(-1)?.userInputMessage
    if (prev) {
      prev.content = joinNonEmpty(prev.content, u.content)
      prev.images.push(...u.images)
      if (results.length) (prev.userInputMessageContext ??= { toolResults: [] }).toolResults.push(...results)
    } else entries.push({ userInputMessage: u })
    mark(prev ?? u, parts)
  }
  // the conversation opens with something the user said: tool results with
  // no call before them go, and a reply the caller began with
  while (entries.length) {
    const u = entries[0].userInputMessage
    if (u) {
      if (u.userInputMessageContext && !u.content && !u.images.length) {
        entries.shift()
        continue
      }
      delete u.userInputMessageContext
      break
    }
    entries.shift()
  }
  // and ends with it, the message being answered
  if (!entries.at(-1)?.userInputMessage) entries.push({ userInputMessage: { ...user(), images: [] } })
  // each call is answered in the message after it, and only calls are
  entries.forEach((e, i) => {
    const u = e.userInputMessage
    if (!u) return
    const calls = entries[i - 1]?.assistantResponseMessage?.toolUses ?? []
    const results = u.userInputMessageContext?.toolResults ?? []
    const answered = new Set()
    const kept = []
    for (const r of results)
      if (!answered.has(r.toolUseId) && calls.some((c) => c.toolUseId === r.toolUseId)) {
        answered.add(r.toolUseId)
        kept.push(r)
      }
    for (const c of calls)
      if (!answered.has(c.toolUseId)) {
        answered.add(c.toolUseId)
        kept.push({ toolUseId: c.toolUseId, status: "error", content: [{ text: NO_RESULT }] })
      }
    delete u.userInputMessageContext
    if (kept.length) u.userInputMessageContext = { toolResults: kept }
    if (!u.content && !u.userInputMessageContext) u.content = PROCEED
  })
  // only the latest images are sent again, as Kiro's own agent does
  let latest = -1
  for (let i = entries.length - 1; i >= 0; i--)
    if (entries[i].userInputMessage?.images.length) {
      latest = i
      break
    }
  entries.forEach((e, i) => {
    const u = e.userInputMessage
    if (u && (i !== latest || !u.images.length)) delete u.images
  })
  for (const e of entries) if (e.assistantResponseMessage && !e.assistantResponseMessage.toolUses.length) delete e.assistantResponseMessage.toolUses
  // the instructions go at the head of the first message
  let system = typeof req.system === "string" ? req.system : textOf(req.system)
  // Kiro has no field for the answer's format: it is told in words, at the
  // end of the instructions, as magpie's built-in tells it (inSystem)
  const format = formatText(req)
  if (format) system = system ? system + "\n\n" + format : format
  // a level Kiro takes as a field is sent as one, not also as a budget
  const native = budget ? nativeFields(req, model) : undefined
  if (budget && !native) system = `<thinking_mode>enabled</thinking_mode><max_thinking_length>${budget}</max_thinking_length>` + (system ? "\n" + system : "")
  if (system) entries[0].userInputMessage.content = system + "\n\n" + entries[0].userInputMessage.content
  if (Array.isArray(req.system)) mark(entries[0].userInputMessage, req.system)

  // the caller's tools, and any the conversation used that it no longer
  // offers — Kiro rejects a history naming a tool it wasn't given
  const current = entries.at(-1).userInputMessage
  const tools = []
  const offered = new Set()
  const EMPTY = { type: "object", properties: {} }
  const hosted = hostedSearch(req)
  for (const t of req.tools ?? []) {
    if (hosted && t === hosted.tool) {
      // Kiro's own web search, run here when the model calls it (searching)
      offered.add(SEARCH_NAME)
      tools.push({ toolSpecification: SEARCH_SPEC })
      if (t.cache_control) tools.push({ cachePoint: { type: "default" } })
      continue
    }
    if (!t?.name || (t.type && t.type !== "custom" && !t.input_schema)) continue // server tools Kiro hasn't
    const name = toolName(t.name)
    offered.add(name)
    tools.push({ toolSpecification: { name, description: t.description || t.name, inputSchema: { json: inputSchema(t.input_schema) } } })
    if (t.cache_control) tools.push({ cachePoint: { type: "default" } })
  }
  for (const e of entries)
    for (const c of e.assistantResponseMessage?.toolUses ?? [])
      if (!offered.has(c.name)) {
        offered.add(c.name)
        tools.push({ toolSpecification: { name: c.name, description: "Tool", inputSchema: { json: EMPTY } } })
      }
  if (tools.length) (current.userInputMessageContext ??= {}).tools = tools
  // Kiro's cachePoint is Bedrock's: it caches the prompt up to the point,
  // and a request may hold 4 at most, as Anthropic's cache_control; past
  // that the last ones are kept, the most of the prompt they cover
  const points = []
  for (const t of tools) if (t.cachePoint) points.push(() => tools.splice(tools.indexOf(t), 1))
  for (const e of entries) {
    const msg = e.userInputMessage ?? e.assistantResponseMessage
    if (marked.has(msg)) {
      msg.cachePoint = { type: "default" }
      points.push(() => delete msg.cachePoint)
    }
  }
  for (const drop of points.slice(0, Math.max(0, points.length - 4))) drop()

  const state = { chatTriggerType: "MANUAL", agentTaskType: "vibe", conversationId: conversationID(conversation), currentMessage: { userInputMessage: current } }
  if (entries.length > 1) state.history = entries.slice(0, -1)
  // the agent mode goes as a header (x-amzn-kiro-agent-mode), as the IDE's
  // client binds it, not in the body
  const out = { conversationState: state }
  if (profile) out.profileArn = profile
  if (native) out.additionalModelRequestFields = native
  return out
}

// conversationID is the conversationId of a chat call. The IDE keeps one
// for a whole conversation; the plugin keeps one for the caller's session
// (magpie's X-Magpie-Conversation), the same id on each turn of it, and a
// new one when it can't tell the session.
function conversationID(key) {
  if (!key) return randomUUID()
  const h = createHash("sha256").update("kiro-conversation:" + key).digest("hex")
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${"89ab"[parseInt(h[16], 16) & 3]}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

// the headers that name the caller's session, the first one sent
const SESSION_HEADERS = ["x-magpie-conversation", "x-magpie-session", "x-opencode-session"]
function sessionOf(input, init) {
  const sets = [init?.headers, input instanceof Request ? input.headers : undefined]
  for (const name of SESSION_HEADERS)
    for (const h of sets) {
      if (!h) continue
      const v = h instanceof Headers ? h.get(name)
        : Array.isArray(h) ? h.find(([k]) => k.toLowerCase() === name)?.[1]
        : Object.entries(h).find(([k]) => k.toLowerCase() === name)?.[1]
      if (v) return String(v)
    }
  return ""
}

// What Kiro IDE 1.4.121 (its agent, KAS 0.66.89, on Electron 44's Node
// 24.22.1) sends on a chat call, read from the IDE's own extension.js. Its
// KiroRuntime client (@amzn/kiro-runtime-service-typescript-client 1.0.0)
// is the AWS SDK for JavaScript's: the SDK's user agent, m/N for the
// endpoint the IDE names itself, then the IDE's own "KiroIDE <version>
// <machine id>" with KAS/<version> and acp-client/kiro-ide, spaces made
// "-". Its retry budget is 3 tries, said in amz-sdk-request and
// x-amzn-kiro-attempt, which count up on each (see paced).
const IDE_VERSION = "1.4.121"
const IDE_KAS = "0.66.89"
const IDE_NODE = "24.22.1"
const IDE_APP = `KiroIDE-${IDE_VERSION}-${MACHINE_ID}-KAS/${IDE_KAS} acp-client/kiro-ide`
const sdkPart = (s) => String(s).replace(/[^!$%&'*+\-.^_`|~\w#]/g, "-")
const IDE_SDK_UA = `aws-sdk-js/1.0.0 ua/2.1 os/${sdkPart(platform())}#${sdkPart(release())} lang/js md/nodejs#${IDE_NODE} api/kiroruntime#1.0.0 m/N ${IDE_APP}`

// sdkHeaders are the AWS SDK's headers on a call to Kiro's runtime, as the
// Kiro IDE's client sends them: who is calling, and as which client. The
// IDE names a Builder ID or Identity Center token's kind (SSO_OIDC) too.
function sdkHeaders(a, attempt = 1, invocation = randomUUID()) {
  const h = {
    ...authHeaders(a),
    "amz-sdk-invocation-id": invocation,
    "amz-sdk-request": `attempt=${attempt}; max=${TRIES}`,
    "x-amz-user-agent": `aws-sdk-js/1.0.0 ${IDE_APP}`,
    "User-Agent": IDE_SDK_UA,
    "x-amzn-kiro-client-attribution": "kiro-ide",
  }
  if (!a.tokenType && a.idc) h.tokentype = "SSO_OIDC"
  return h
}

function sendKiro(a, body, signal, attempt = 1, invocation) {
  return fetch(runtime(a.region) + "/generateAssistantResponse", {
    method: "POST",
    headers: { ...sdkHeaders(a, attempt, invocation), "x-amzn-kiro-attempt": `${attempt};max=${TRIES}`, "x-amzn-codewhisperer-optout": "true",
      "x-amzn-kiro-agent-mode": "vibe", "Content-Type": "application/json", Accept: "application/vnd.amazon.eventstream" },
    body,
    signal,
  })
}

// TRIES is the Kiro IDE's tries of one chat call (its QClientRetryStrategy,
// agent 1.1.787, QAf), the first included.
const TRIES = 3
// PACE is the IDE's pause before the nth try after a throttle (its
// throttling backoff: 1s doubling, 20% either way, at most 20s), unless
// Kiro said how long (retryAfterMilliseconds and the like).
const PACE = { base: 1000, jitter: 0.2, max: 20_000 }
const paceOf = (n) => Math.min(PACE.max, PACE.base * 2 ** (n - 1)) * (1 - PACE.jitter + Math.random() * 2 * PACE.jitter)
// THROTTLES are the reasons the IDE takes a 429 for a throttle it waits
// out and tries again (its C1p and ServiceThrottleError): a throttle
// Kiro gives no reason for is one too. A daily, monthly or usage limit
// is not (usedUpSaid), nor is INSUFFICIENT_MODEL_CAPACITY.
const THROTTLES = new Set(["USER_REQUEST_RATE_EXCEEDED", "CREDIT_CONSUMPTION_RATE_EXCEEDED", "SERVICE_REQUEST_RATE_EXCEEDED"])
function throttleSaid(text) {
  let e = {}
  try {
    e = JSON.parse(text) ?? {}
  } catch {}
  if (e.reason) return THROTTLES.has(e.reason)
  return !usedUpSaid(text) && !/INSUFFICIENT_MODEL_CAPACITY/.test(text) && /too many requests|throttl/i.test(text)
}

// timing is how the plugin waits; tests make it instant.
const timing = {
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(aborted())
      const t = setTimeout(() => {
        signal?.removeEventListener("abort", stop)
        resolve()
      }, ms)
      const stop = () => {
        clearTimeout(t)
        reject(aborted())
      }
      signal?.addEventListener("abort", stop, { once: true })
    }),
}

// paced is sendKiro as the Kiro IDE sends a chat call: a 429 throttle is
// waited out and tried again, up to TRIES in all, each try said in
// amz-sdk-request and x-amzn-kiro-attempt under one invocation id. The
// IDE answers its own USER_REQUEST_RATE_EXCEEDED so ("Retrying in N
// seconds"), which is why a burst it rides out reached magpie's agent
// as a 429 (onemezao on Discord). A wait Kiro says is longer than PACE.max
// isn't held here: the 429 goes back with it, for magpie to rest the
// account. The answer of the last try is the answer.
async function paced(a, body, signal) {
  const invocation = randomUUID()
  // the IDE's own choice of API for the account (createResponseFor): its
  // CreateResponse arm is asked at /v1/responses, the rest as ever
  const cr = await createResponseFor(a, signal)
  const sent = cr ? JSON.stringify(responsesBody(JSON.parse(body))) : body
  for (let n = 1; ; n++) {
    const res = cr ? await sendResponses(a, sent, signal, n) : await sendKiro(a, sent, signal, n, invocation)
    if (res.status !== 429 || n >= TRIES) return res
    const text = (await res.text()).slice(0, 1 << 20)
    const again = () => new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers })
    if (!throttleSaid(text)) return again()
    const said = saidWait(res.headers, text)
    if (said > PACE.max) return again()
    await timing.sleep(said ?? paceOf(n), signal)
  }
}

// ---- CreateResponse: the Kiro IDE's other chat API ------------------------------------
//
// Kiro IDE 1.4.121 (agent 1.1.787) asks Kiro one of two ways, by an A/B
// experiment the account is in: generateAssistantResponse (sendKiro), or,
// in the create_response_api arm, CreateResponse: POST /v1/responses on
// the same runtime, an OpenAI Responses-like body built from the same
// conversation (its buildCreateResponseRequest), answered with server-sent
// events (its parseCreateResponseSse). chensihan0709-ui (plugins#848) had a
// Builder ID student account answered 429 USER_REQUEST_RATE_EXCEEDED on
// generateAssistantResponse through the plugin while the IDE, 11s later
// on the same account, was answered on CreateResponse ("api=CreateResponse
// armSource=experiment callPath=main"), and the IDE's own session-title
// call, which stayed on generateAssistantResponse, got the 429 too.

// FEATURE_SALT is what the IDE hashes a feature's name with to find it in
// Kiro's feature configuration (its deriveWireKey: sha256 hex of salt +
// name); CREATE_RESPONSE is the experiment's, and "create_response" the
// value of its arm (selectModelApi). A chat call is the IDE's "main" call
// path, which takes CreateResponse on the experiment alone.
const FEATURE_SALT = "kiro-feature-config-key-salt-3e9b1d7a"
const featureKey = (name) => createHash("sha256").update(FEATURE_SALT + name).digest("hex")
const CREATE_RESPONSE = featureKey("create_response_api")
// the IDE's ExperimentConfigService: a configuration is kept 15 minutes
// for one sign-in (token and profile), asked for again after a minute
// when it couldn't be read, and read within 5s or not at all, which
// leaves the call on generateAssistantResponse (the default)
const FEATURES = { ttl: 15 * 60_000, retry: 60_000, timeout: 5000 }
const features = new Map() // account → { token, profile, until, config, pending }

// createResponseFor is whether the account is asked as the IDE's
// CreateResponse arm.
async function createResponseFor(a, signal) {
  const config = await featuresOf(a, signal)
  return config[CREATE_RESPONSE] === "create_response"
}

async function featuresOf(a, signal) {
  const who = a.key || a.profile || a.token
  let f = features.get(who)
  if (!f || f.token !== a.token || f.profile !== a.profile) {
    f = { token: a.token, profile: a.profile, until: 0, config: {} }
    features.set(who, f)
  }
  if (Date.now() < f.until) return f.config
  f.pending ??= readFeatures(a, signal)
    .then((config) => {
      f.config = config
      f.until = Date.now() + FEATURES.ttl
    })
    .catch(() => {
      // what was read before is kept, as the IDE keeps its last good one
      f.until = Date.now() + FEATURES.retry
    })
    .finally(() => (f.pending = undefined))
  await f.pending
  return f.config
}

// readFeatures is Kiro's GetFeatureConfiguration as the IDE calls it: GET
// /featureConfiguration on the runtime with the origin and the IDE's
// version as the query, the profile as x-amzn-kiro-profile-arn, through
// the same SDK client (one try), answered {configuration: {...}}.
async function readFeatures(a, signal) {
  const q = new URLSearchParams({ origin: "AI_EDITOR", version: IDE_VERSION })
  const headers = { ...sdkHeaders(a, 1), "amz-sdk-request": "attempt=1; max=1", Accept: "application/json" }
  if (a.profile) headers["x-amzn-kiro-profile-arn"] = a.profile
  const timeout = AbortSignal.timeout(FEATURES.timeout)
  const res = await fetch(`${runtime(a.region)}/featureConfiguration?${q}`, {
    headers,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  })
  if (!res.ok) {
    await res.body?.cancel()
    throw new Error(`featureConfiguration ${res.status}`)
  }
  const c = (await res.json())?.configuration
  return c && typeof c === "object" && !Array.isArray(c) ? c : {}
}

// responses are the Responses (Response objects) answered with
// server-sent events: CreateResponse's, read by crMessages
const responses = new WeakSet()

// sendResponses is CreateResponse as the IDE sends it (its
// sendCreateResponseRaw): its own few headers, the plain user agent (its
// userAgent.forHttp(), no AWS SDK's), the profile as x-amzn-kiro-profile,
// and the try as x-amzn-kiro-attempt. A refusal is said back in
// generateAssistantResponse's words (crRefusal), so it is read, retried
// and reported as one of its.
async function sendResponses(a, body, signal, attempt = 1) {
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${a.token}`,
    "x-amzn-kiro-origin": "AI_EDITOR",
    "x-amzn-codewhisperer-optout": "true",
    "User-Agent": IDE_APP,
    "x-amzn-kiro-attempt": `${attempt};max=${TRIES}`,
  }
  if (a.profile) headers["x-amzn-kiro-profile"] = a.profile
  const kind = a.tokenType || (a.idc ? "SSO_OIDC" : "")
  if (kind) headers.TokenType = kind
  const res = await fetch(runtime(a.region) + "/v1/responses", { method: "POST", headers, body, signal })
  if (!res.ok) {
    const text = (await res.text()).slice(0, 1 << 20)
    return new Response(crRefusal(res.status, text), { status: res.status, statusText: res.statusText, headers: res.headers })
  }
  responses.add(res)
  return res
}

// CR_REASONS are the IDE's CreateResponse codes it says in
// generateAssistantResponse's reasons (its normalizeReason).
const CR_REASONS = { context_length_exceeded: "CONTENT_LENGTH_EXCEEDS_THRESHOLD", model_not_found: "INVALID_MODEL_ID",
  invalid_function_parameters: "TOOL_SCHEMA_INVALID", invalid_json: "REQUEST_BODY_INVALID_JSON",
  "kiro:model_requires_user_opt_in": "MODEL_REQUIRES_USER_OPT_IN", server_is_overloaded: "MODEL_TEMPORARILY_UNAVAILABLE",
  rate_limit_exceeded: "USER_REQUEST_RATE_EXCEEDED" }
function crReason(status, code) {
  if (status === 413) return "CONTENT_LENGTH_EXCEEDS_THRESHOLD"
  if (typeof code !== "string" || !code) return undefined
  return CR_REASONS[code] ?? (code.startsWith("kiro:") ? code.slice(5).toUpperCase() : code)
}

// crRefusal is CreateResponse's refusal ({error: {message, type, code}},
// or Kiro's {message, reason}) as generateAssistantResponse says one:
// {message, reason, retryAfterMilliseconds}.
function crRefusal(status, text) {
  let o = {}
  try {
    o = JSON.parse(text) ?? {}
  } catch {}
  if (typeof o !== "object") o = {}
  const e = o.error && typeof o.error === "object" ? o.error : {}
  const message = e.message ?? o.message ?? o.Message ?? (String(text).trim() || `CreateResponse HTTP ${status}`)
  const reason = crReason(status, e.code ?? o.reason)
  const out = { message, ...(reason ? { reason } : {}) }
  if (Number.isFinite(o.retryAfterMilliseconds) && o.retryAfterMilliseconds >= 0) out.retryAfterMilliseconds = o.retryAfterMilliseconds
  return JSON.stringify(out)
}

// responsesBody is a generateAssistantResponse body (kiroRequest's) as
// the IDE's CreateResponse body: the conversation as input items, the
// current message's tools as functions, and what went in the state as
// metadata. The instructions stay at the head of the first message, as
// the IDE sends them without its system_field_injection feature.
function responsesBody(g) {
  const s = g.conversationState
  const current = s.currentMessage?.userInputMessage ?? {}
  const input = []
  for (const e of [...(s.history ?? []), s.currentMessage]) if (e) input.push(...responsesInput(e))
  const tools = []
  for (const t of current.userInputMessageContext?.tools ?? []) {
    const spec = t.toolSpecification
    if (spec?.name) tools.push({ type: "function", name: spec.name, description: spec.description, parameters: spec.inputSchema?.json })
  }
  const metadata = { "kiro:agent_mode": "vibe" }
  if (s.conversationId !== undefined) metadata["kiro:conversation_id"] = s.conversationId
  const out = { model: current.modelId, input, ...(tools.length ? { tools } : {}), stream: true, origin: current.origin ?? "AI_EDITOR" }
  if (g.profileArn !== undefined) out.profileArn = g.profileArn
  out.metadata = metadata
  // its buildReasoningField: the thinking type, the effort and how it is shown
  const f = g.additionalModelRequestFields
  if (f && typeof f === "object") {
    const str = (v) => (typeof v === "string" && v ? v : undefined)
    const type = str(f.thinking?.type)
    const effort = str(f.output_config?.effort) ?? str(f.reasoning?.effort)
    const summary = str(f.thinking?.display)
    if (type || effort || summary)
      out.reasoning = { ...(type ? { type } : {}), ...(effort ? { effort } : {}), ...(summary ? { summary } : {}) }
  }
  return out
}

// responsesInput is one entry of the conversation as the IDE's input
// items (its toResponsesInputMessages): tool results, then what the user
// said (with images, a list of parts); the reply's text, then its calls.
function responsesInput(e) {
  const out = []
  const u = e.userInputMessage
  if (u) {
    for (const r of u.userInputMessageContext?.toolResults ?? [])
      out.push({ type: "function_call_output", call_id: r.toolUseId, output: (r.content ?? []).map((p) => p.text ?? "").join("\n") })
    const images = (u.images ?? []).filter((i) => i.source?.bytes)
      .map((i) => ({ type: "input_image", image_url: `data:image/${String(i.format).toLowerCase()};base64,${i.source.bytes}` }))
    const text = typeof u.content === "string" ? u.content : ""
    if (images.length) out.push({ role: "user", content: [...(text ? [{ type: "input_text", text }] : []), ...images] })
    else if (text) out.push({ role: "user", content: text })
  }
  const m = e.assistantResponseMessage
  if (m) {
    if (typeof m.content === "string" && m.content) out.push({ role: "assistant", content: m.content })
    for (const c of m.toolUses ?? [])
      out.push({ type: "function_call", call_id: c.toolUseId, name: c.name, arguments: typeof c.input === "string" ? c.input : JSON.stringify(c.input ?? {}) })
  }
  return out
}

// CR_STOPS are the IDE's stop reasons for an incomplete response.
const CR_STOPS = { max_output_tokens: "MAX_TOKENS", content_filter: "CONTENT_FILTERED",
  compaction_required_for_model_handoff: "COMPACTION_REQUIRED_FOR_MODEL_HANDOFF" }
// CR_TYPES are the error types the IDE takes for one when a stream's
// error has a code alone
const CR_TYPES = new Set(["invalid_request", "not_found", "too_many_requests", "insufficient_quota", "server_error", "model_error"])

// crFailed is what a CreateResponse stream's error says, in the words of
// generateAssistantResponse's (exception).
function crFailed(err) {
  let type = err?.type
  let code = err?.code
  if (!type && code && CR_TYPES.has(code)) [type, code] = [code, undefined]
  const t = String(type ?? "").toLowerCase()
  const throttled = t === "too_many_requests" || code === "rate_limit_exceeded"
  const reason = crReason(code === "context_length_exceeded" ? 413 : 0, code)
  let msg = err?.message || `CreateResponse stream failed (${type ?? code ?? "unknown"})`
  if (reason) msg += ` (${reason})`
  if (reason === USER_RATE) return userRate(msg)
  if (throttled) return "rate limited: " + msg
  return type ? `${type}: ${msg}` : msg
}

// crMessages reads CreateResponse's server-sent events as the events of
// generateAssistantResponse's stream ({kind, m}, or {failed}), as the IDE
// reads them (its parseCreateResponseSse).
async function* crMessages(body) {
  const open = new Set() // calls started and not stopped
  const argued = new Set() // calls whose arguments came in pieces
  let call
  let refused = false // the refusal came in pieces, said already
  const line = function* (l) {
    if (!l.startsWith("data:")) return
    const d = l.slice(5).trim()
    if (!d || d === "[DONE]") return
    let w
    try {
      w = JSON.parse(d)
    } catch {
      return
    }
    const type = w?.type ?? ""
    if (type === "response.output_text.delta" && typeof w.delta === "string") yield { kind: "assistantResponseEvent", m: { content: w.delta } }
    else if ((type === "response.reasoning_text.delta" || type === "response.reasoning.delta") && typeof w.delta === "string")
      yield { kind: "reasoningContentEvent", m: { text: w.delta } }
    else if (type === "response.output_item.done" && w.item?.type === "reasoning") {
      let env
      try {
        env = JSON.parse(w.item.encrypted_content)
      } catch {}
      const sig = env?.reasoningText?.signature
      if (typeof sig === "string" && sig) yield { kind: "reasoningContentEvent", m: { signature: sig } }
    } else if (type === "response.refusal.delta" && typeof w.delta === "string") {
      // a refusal is said as the reply's text
      refused = true
      yield { kind: "assistantResponseEvent", m: { content: w.delta } }
    } else if (type === "response.refusal.done" && typeof w.refusal === "string") {
      if (!refused) yield { kind: "assistantResponseEvent", m: { content: w.refusal } }
    }
    else if (type === "response.output_item.added" && w.item?.type === "function_call") {
      call = w.item.call_id ?? w.item.id ?? ""
      open.add(call)
      yield { kind: "toolUseEvent", m: { toolUseId: call, name: w.item.name, input: w.item.arguments ?? "" } }
    } else if (type === "response.function_call_arguments.delta" && typeof w.delta === "string") {
      if (call) argued.add(call)
      yield { kind: "toolUseEvent", m: { toolUseId: call, input: w.delta } }
    } else if (type === "response.function_call_arguments.done") {
      if (call && open.has(call)) {
        open.delete(call)
        argued.delete(call)
        call = undefined
      }
    } else if (type === "response.output_item.done" && w.item?.type === "function_call") {
      const id = w.item.call_id ?? w.item.id ?? ""
      if (!open.has(id)) return
      open.delete(id)
      if (!argued.delete(id)) yield { kind: "toolUseEvent", m: { toolUseId: id, input: w.item.arguments ?? "" } }
    } else if (type === "response.completed" || type === "response.incomplete") {
      const r = w.response ?? {}
      const incomplete = type === "response.incomplete" || r.status === "incomplete"
      const stopReason = (incomplete && CR_STOPS[r.incomplete_details?.reason]) || "END_TURN"
      yield { kind: "metadataEvent", m: { stopReason } }
      const pct = r.usage?.["kiro:context_usage_percentage"]
      if (typeof pct === "number" && Number.isFinite(pct)) yield { kind: "contextUsageEvent", m: { contextUsagePercentage: pct } }
      const credits = r.usage?.["kiro:credits"]
      if (typeof credits?.value === "number" && Number.isFinite(credits.value))
        yield { kind: "meteringEvent", m: { usage: credits.value, ...(credits.unit !== undefined ? { unit: credits.unit } : {}) } }
    } else if (type === "error" || type === "response.failed") yield { failed: crFailed(type === "error" ? w.error : w.response?.error) }
  }
  const dec = new TextDecoder()
  let buf = ""
  const reader = body.getReader()
  try {
    for (;;) {
      const { value, done } = await reader.read()
      buf += done ? dec.decode() : dec.decode(value, { stream: true })
      const lines = buf.split("\n")
      buf = done ? "" : lines.pop() ?? ""
      if (buf.length > CR_LINE) throw new Error("a server-sent event over 4 MiB")
      for (const l of lines)
        for (const ev of line(l.replace(/\r$/, ""))) {
          yield ev
          if (ev.failed) return
        }
      if (done) return
    }
  } finally {
    reader.releaseLock?.()
  }
}
// CR_LINE is the longest line the IDE reads of the stream
const CR_LINE = 4 << 20

// tooLongSaid is whether Kiro's words say the conversation is past the
// model's window: its ValidationException "Input is too long." with reason
// CONTENT_LENGTH_EXCEEDS_THRESHOLD, as an HTTP answer or as an exception
// in the event stream, or a reply it stopped with MODEL_CONTEXT_WINDOW_EXCEEDED.
const tooLongSaid = (msg) => /CONTENT_LENGTH_EXCEEDS_THRESHOLD|MODEL_CONTEXT_WINDOW_EXCEEDED|input is too long/i.test(msg)
// TOO_LONG heads a too-long failure in the words magpie's gateway takes
// for one (tooLong): another member with a larger window is asked, no
// account rests, and with none left the agent is told to compact.
const TOO_LONG = "input is too long for the model's context: "

// failure is the status and message for an error Kiro answered with:
// {"message": "...", "reason": "..."}.
function failure(status, body, id) {
  let msg = String(body ?? "").trim()
  try {
    const e = JSON.parse(body)
    if (e?.message) msg = e.message + (e.reason ? ` (${e.reason})` : "")
  } catch {}
  msg ||= STATUS_TEXT[status] ?? ""
  if (tooLongSaid(msg)) return { status: 400, message: TOO_LONG + msg }
  if (msg.includes("INSUFFICIENT_MODEL_CAPACITY")) return { status: 503, message: msg }
  if (msg.includes("MONTHLY_REQUEST_COUNT") || msg.includes("USAGE_LIMIT")) return { status: 429, message: "usage limit reached: " + msg }
  if (msg.includes(USER_RATE)) return { status: 429, message: userRate(msg, id) }
  return { status, message: msg }
}

// USER_RATE is the reason Kiro gives a 429 for one account's requests
// coming too often (the Kiro IDE's ThrottlingException reasons, agent
// 1.1.499: apart from the credit rate, the service's rate and the daily
// and monthly counts). Kiro's own words, "Too many requests, please wait
// before trying again.", say neither whose limit it is nor how long:
// onemezao on Discord had it on every request of one account through pi,
// 42s each, while the Kiro IDE answered on the same account.
const USER_RATE = "USER_REQUEST_RATE_EXCEEDED"
// USER_RATE_WAIT is the wait a USER_RATE refusal says when Kiro says none:
// longer than magpie's same-account retries (8s), so the request isn't
// sent again at 1, 2 and 4s, each try one more on the account's rate.
// Other Kiro relays pause 3 to 12s for it; one that outlived those
// wasn't going to clear in magpie's next few.
const USER_RATE_WAIT = 30_000

// userRate is a USER_RATE refusal in plain words: whose limit, what to
// do, and the request ID Kiro support asks for.
const userRate = (msg, id) =>
  `rate limited: Kiro is limiting how often this Kiro account sends requests (${msg}). ` +
  "Wait a minute before sending again. If it keeps coming back while the Kiro app works on the same account, " +
  "the limit is on the account, and Kiro support (app.kiro.dev) can look at it" +
  (id ? `, with request ID ${id}.` : ".")

const ERROR_TYPES = { 400: "invalid_request_error", 401: "authentication_error", 402: "billing_error", 403: "permission_error",
  404: "not_found_error", 413: "request_too_large", 429: "rate_limit_error", 503: "overloaded_error", 529: "overloaded_error" }
const errorType = (status) => ERROR_TYPES[status] ?? "api_error"
// Each failure says X-Magpie-Sign-In: kept, as the built-in never marked
// an account lapsed (see gone). One Kiro said when to ask again (waitOf)
// says it as Retry-After, in whole seconds, for magpie to wait as long.
const errorResponse = (status, message, wait) =>
  new Response(JSON.stringify({ type: "error", error: { type: errorType(status), message } }), {
    status,
    headers: { "Content-Type": "application/json", "X-Magpie-Sign-In": "kept",
      ...(wait > 0 ? { "Retry-After": String(Math.ceil(wait / 1000)) } : {}) },
  })

// requestID is the ID Kiro gave its answer, which its support asks for:
// what the Kiro IDE reads (x-amzn-requestid, else x-request-id).
const requestID = (headers) => headers.get("x-amzn-requestid") || headers.get("x-request-id") || ""

// waitOf is the milliseconds Kiro's refusal says to wait before asking
// again, or undefined: what Kiro's own clients read. The Kiro IDE (agent
// 1.1.499) reads the x-amzn-kiro-ratelimit-retry-after header and the
// body's retryAfterMilliseconds, both in milliseconds; kiro-cli's AWS SDK
// reads x-amz-retry-after, in milliseconds; and Retry-After is HTTP's, in
// seconds or as a date. Unsaid, magpie keeps to its own pauses, but for
// an account's request rate (USER_RATE_WAIT).
function waitOf(headers, body) {
  let w = saidWait(headers, body)
  if (w === undefined && String(body ?? "").includes(USER_RATE)) w = USER_RATE_WAIT
  return w
}

// saidWait is the wait Kiro itself said, if any (waitOf, but none of
// magpie's own).
function saidWait(headers, body) {
  const ms = (v) => {
    const n = v == null || v === "" ? NaN : Number(v)
    return Number.isFinite(n) && n > 0 ? n : undefined
  }
  let w = ms(headers.get("x-amzn-kiro-ratelimit-retry-after")) ?? ms(headers.get("x-amz-retry-after"))
  if (w === undefined)
    try {
      w = ms(JSON.parse(body)?.retryAfterMilliseconds)
    } catch {}
  const ra = headers.get("retry-after")
  if (w === undefined && ra) {
    const secs = ms(ra)
    w = secs !== undefined ? secs * 1000 : ms(Date.parse(ra) - Date.now())
  }
  return w
}

// kept is res saying the account is kept: a success too, which the
// built-in never took for a sign-in come back.
function kept(res) {
  if (res.headers.has("X-Magpie-Sign-In")) return res
  const headers = new Headers(res.headers)
  headers.set("X-Magpie-Sign-In", "kept")
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}

// ---- the reply: an AWS event stream → Messages ---------------------------------------

// frames reads an AWS event stream: each message its length, its headers'
// length and a checksum, the headers, the payload, a checksum of the whole.
async function* frames(body) {
  let buf = new Uint8Array(0)
  const reader = body.getReader()
  try {
    for (;;) {
      while (buf.length >= 12) {
        const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
        const total = v.getUint32(0)
        const hlen = v.getUint32(4)
        if (total < 16 || total > 16 << 20 || hlen > total - 16) throw new Error("a malformed event stream")
        if (buf.length < total) break
        const rest = buf.subarray(12, total)
        yield { headers: frameHeaders(rest.subarray(0, hlen)), payload: rest.subarray(hlen, rest.length - 4) }
        buf = buf.slice(total)
      }
      const { value, done } = await reader.read()
      if (done) {
        if (buf.length) throw new Error("unexpected EOF")
        return
      }
      const n = new Uint8Array(buf.length + value.length)
      n.set(buf)
      n.set(value, buf.length)
      buf = n
    }
  } finally {
    reader.releaseLock?.()
  }
}

function frameHeaders(h) {
  const out = {}
  const dec = new TextDecoder()
  const v = new DataView(h.buffer, h.byteOffset, h.byteLength)
  let i = 0
  while (i < h.length) {
    const n = h[i]
    if (h.length < i + 2 + n) break
    const name = dec.decode(h.subarray(i + 1, i + 1 + n))
    const type = h[i + 1 + n]
    i += 2 + n
    const size = { 0: 0, 1: 0, 2: 1, 3: 2, 4: 4, 5: 8, 8: 8, 9: 16 }[type]
    if (type === 6 || type === 7) {
      if (h.length < i + 2) break
      const l = v.getUint16(i)
      if (h.length < i + 2 + l) break
      if (type === 7) out[name] = dec.decode(h.subarray(i + 2, i + 2 + l))
      i += 2 + l
      continue
    }
    if (size === undefined || h.length < i + size) break
    i += size
  }
  return out
}

// exception is what an error in the stream says.
function exception(kind, payload) {
  let e = {}
  try {
    e = JSON.parse(new TextDecoder().decode(payload))
  } catch {}
  let msg = e.message || e.Message || new TextDecoder().decode(payload).trim()
  if (e.reason) msg += ` (${e.reason})`
  if (e.reason === USER_RATE) return userRate(msg)
  if (String(kind).toLowerCase().includes("throttl")) return "rate limited: " + msg
  return kind ? `${kind}: ${msg}` : msg
}

// ThinkParser splits a reply that opens with <thinking>…</thinking> into its
// thinking and the text after, however the tags fall across pieces.
const OPEN = "<thinking>"
const CLOSE = "</thinking>"
function partialSuffix(s, tag) {
  for (let n = Math.min(tag.length - 1, s.length); n > 0; n--) if (s.endsWith(tag.slice(0, n))) return n
  return 0
}
class ThinkParser {
  state = 0 // 0: not yet known, 1: thinking, 2: text
  buf = ""
  said = false
  feed(s) {
    this.buf += s
    const out = []
    for (;;) {
      if (this.state === 0) {
        const t = this.buf.replace(/^[ \t\r\n]+/, "")
        if (t.startsWith(OPEN)) {
          ;[this.buf, this.state] = [t.slice(OPEN.length), 1]
          continue
        }
        if (t.length < OPEN.length && OPEN.startsWith(t)) return out // may yet be the tag
        this.state = 2
        continue
      }
      if (this.state === 1) {
        if (!this.said) {
          this.buf = this.buf.replace(/^[\r\n]+/, "")
          if (!this.buf) return out
        }
        const i = this.buf.indexOf(CLOSE)
        if (i >= 0) {
          if (i > 0) {
            out.push({ kind: "think", text: this.buf.slice(0, i) })
            this.said = true
          }
          ;[this.buf, this.state] = [this.buf.slice(i + CLOSE.length).replace(/^[\r\n]+/, ""), 2]
          continue
        }
        // hold back what may be the start of the closing tag
        const n = this.buf.length - partialSuffix(this.buf, CLOSE)
        if (n > 0) {
          out.push({ kind: "think", text: this.buf.slice(0, n) })
          ;[this.buf, this.said] = [this.buf.slice(n), true]
        }
        return out
      }
      if (this.buf) out.push({ kind: "text", text: this.buf })
      this.buf = ""
      return out
    }
  }
  end() {
    if (!this.buf) return []
    const ev = { kind: this.state === 1 ? "think" : "text", text: this.buf }
    this.buf = ""
    if (this.state === 0) this.state = 2
    return [ev]
  }
}

// garMessages reads generateAssistantResponse's event stream: each event's
// kind and what it says ({kind, m}), or what an error in it says ({failed}).
const STREAM_ERRORS = ["error", "throttlingError", "validationError", "serviceUnavailableError", "internalServerException"]
async function* garMessages(body) {
  const dec = new TextDecoder()
  for await (const f of frames(body)) {
    const type = f.headers[":message-type"]
    if (type === "exception" || type === "error") {
      yield { failed: exception(f.headers[":exception-type"] || f.headers[":error-code"], f.payload) }
      return
    }
    let m
    try {
      m = JSON.parse(dec.decode(f.payload))
    } catch {
      continue
    }
    const kind = f.headers[":event-type"]
    if (STREAM_ERRORS.includes(kind)) {
      yield { failed: exception(kind, f.payload) }
      return
    }
    yield { kind, m }
  }
}

// events turns Kiro's reply into events: text, thinking, tool calls (the
// arguments in pieces), then the usage and why it stopped — or an error.
async function* events(body, model, budget, sse = false) {
  const think = new ThinkParser()
  let tool = ""
  let tools = 0
  let stop = ""
  // reported: Kiro sent a tokenUsage. It doesn't today: a reply has a
  // contextUsageEvent and a meteringEvent (credits) and nothing more, and
  // kiro-cli 2.32's own trace log shows its MetadataEvent with every token
  // count None, while a repeated prompt is billed about half the credits,
  // so Kiro does cache and doesn't say how much
  // credits: what Kiro's meteringEvents say the request cost, summed;
  // undefined when it sent none
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reported: false, credits: undefined }
  let pct = 0
  let said = 0
  let failed = ""
  try {
    for await (const ev of (sse ? crMessages : garMessages)(body)) {
      if (ev.failed) {
        failed = ev.failed
        break
      }
      const { kind, m } = ev
      if (kind === "assistantResponseEvent") {
        const text = typeof m.content === "string" ? m.content : ""
        said += text.length
        if (budget) yield* think.feed(text)
        else if (text) yield { kind: "text", text }
      } else if (kind === "reasoningContentEvent") {
        // one event may carry the reasoning and its signature together (auto,
        // called as the IDE): the signature goes on the block it ends
        if (m.text) {
          said += m.text.length
          yield { kind: "think", text: m.text }
        }
        if (m.signature) yield { kind: "sig", text: m.signature }
      } else if (kind === "toolUseEvent") {
        if (m.toolUseId && m.toolUseId !== tool) {
          yield* think.end() // the text before a call is all said
          tool = m.toolUseId
          tools++
          yield { kind: "toolStart", id: m.toolUseId, name: m.name ?? "" }
        }
        if (m.input !== undefined && m.input !== null) {
          if (typeof m.input === "string") {
            if (m.input) yield { kind: "toolArgs", text: m.input }
            said += m.input.length
          } else {
            const s = JSON.stringify(m.input)
            if (s !== "{}") yield { kind: "toolArgs", text: s }
            said += s.length
          }
        }
      } else if (kind === "metadataEvent" || kind === "messageMetadataEvent") {
        if (m.stopReason) stop = m.stopReason
        const tu = m.tokenUsage
        if (tu && typeof tu === "object") {
          usage.reported = true
          usage.input += tu.uncachedInputTokens || tu.inputTokens || 0
          usage.output += tu.outputTokens || 0
          usage.cacheRead += tu.cacheReadInputTokens || 0
          usage.cacheWrite += tu.cacheWriteInputTokens || 0
          if (tu.contextUsagePercentage > 0) pct = tu.contextUsagePercentage
        }
      } else if (kind === "contextUsageEvent") {
        if (m.contextUsagePercentage > 0) pct = m.contextUsagePercentage
      } else if (kind === "meteringEvent") {
        if (Number.isFinite(m.usage) && m.usage >= 0 && (!m.unit || /^credit/i.test(m.unit))) usage.credits = (usage.credits ?? 0) + m.usage
      }
    }
  } catch (e) {
    if (e?.name !== "AbortError") failed = "the reply broke off: " + e.message
  }
  yield* think.end()
  if (failed) {
    yield { kind: "error", text: failed }
    return
  }
  const window = windows.get(model) ?? 0
  // Kiro says how full the context is rather than how many tokens
  if (!usage.input && pct > 0 && window > 0) usage.input = Math.floor((pct / 100) * window)
  if (!usage.output) usage.output = Math.floor((said + 3) / 4)
  const full = /^model_context_window_exceeded$/i.test(stop)
  if (full && !said && !tools) {
    // stopped for the window before a word: the conversation doesn't fit
    yield { kind: "error", text: "the reply stopped as the model's context window was full (MODEL_CONTEXT_WINDOW_EXCEEDED)" }
    return
  }
  let reason = "end_turn"
  if (tools > 0) reason = "tool_use"
  else if (full) reason = "model_context_window_exceeded" // cut short, as Anthropic's API says it
  else if (/^max_tokens$/i.test(stop)) reason = "max_tokens"
  else if (/^content_filtered$/i.test(stop)) reason = "refusal"
  yield { kind: "stop", reason, usage }
}

// finished is the message's blocks with each call's arguments read.
function finished(content) {
  for (const b of content)
    if (b.type === "tool_use") {
      try {
        b.input = b.input ? JSON.parse(b.input) : {}
      } catch {
        b.input = {}
      }
    }
  return content
}

// anthropicUsage is the usage in Messages' words. With no tokenUsage from
// Kiro the input is reckoned from how full the context is, and what of it
// Kiro read from its cache is unknown, not 0: the cache fields are left
// out and magpie is told so (magpie_cache_unknown), so it shows no hit
// rate rather than 0%.
const anthropicUsage = (u) => ({
  ...(u.reported
    ? { input_tokens: u.input, output_tokens: u.output, cache_read_input_tokens: u.cacheRead, cache_creation_input_tokens: u.cacheWrite }
    : { input_tokens: u.input, output_tokens: u.output, magpie_cache_unknown: true }),
  // the hosted web searches made (searching)
  ...(u.searches ? { server_tool_use: { web_search_requests: u.searches } } : {}),
  // what Kiro said the request cost in credits (its meteringEvents), as
  // magpie reads a plan's credits (yetone/magpie#4328)
  ...(u.credits !== undefined ? { credit: u.credits } : {}),
})

// quotaWords are magpie's (internal/gateway/fallback.go): how a vendor says
// "out of quota" or "slow down".
const QUOTA_WORDS = /quota|insufficient|balance|credit|billing|exceeded|rate.?limit|usage.?limit|limit.?reached|hit your .*limit|limit.{0,24}resets|too many requests|overloaded|余额|额度|欠费|限流|频率|套餐|用量|上限/i

// failedBefore is the reply to an error before any of the answer, as
// magpie's built-in relay gives it: a status, not a stream, so another
// account can take over — a 429 when it reads as a quota or rate limit,
// else a 502.
//
// A conversation past the model's window is a 400 that says so, whichever
// way Kiro said it, before the quota words ("exceeded"): as a 502, magpie
// rested the account, asked it again, and told a lone agent of a vendor
// error, so it never compacted (ergou0954_54426 on Discord: Kiro in a
// group routed by intent, "超出上下文", the turn failed).
const failedBefore = (text) =>
  tooLongSaid(text) ? errorResponse(400, TOO_LONG + text) : text.includes(USER_RATE) ? errorResponse(429, text, USER_RATE_WAIT) : errorResponse(QUOTA_WORDS.test(text) ? 429 : 502, text)

// reply answers the Messages request from Kiro's events: a stream of
// Messages' events, or one message. names gives back the caller's name of
// a tool Kiro was sent under another (toolNames).
async function reply(it, model, stream, names = new Map()) {
  const id = "msg_" + randomBytes(12).toString("hex")
  if (!stream) {
    const content = []
    let last = null
    const add = (block) => {
      content.push(block)
      last = block
    }
    for await (const e of it) {
      if (e.kind === "text") {
        if (last?.type === "text") last.text += e.text
        else add({ type: "text", text: e.text })
      } else if (e.kind === "think") {
        if (last?.type === "thinking") last.thinking += e.text
        else add({ type: "thinking", thinking: e.text, signature: "" })
      } else if (e.kind === "sig") {
        if (last?.type === "thinking") last.signature += e.text
      } else if (e.kind === "serverTool") add({ type: "server_tool_use", id: e.id, name: e.name, input: e.input })
      else if (e.kind === "searched") add({ type: "web_search_tool_result", tool_use_id: e.id, content: e.content })
      else if (e.kind === "toolStart") add({ type: "tool_use", id: e.id, name: names.get(e.name) ?? e.name, input: "" })
      else if (e.kind === "toolArgs") {
        if (last?.type === "tool_use") last.input += e.text
      } else if (e.kind === "error") {
        // with none of the answer said, a status; else what was said. A
        // turn after a web search that failed is a status even so: what
        // was said is the searches, without the answer they were for
        if (e.status) return errorResponse(e.status, e.text)
        if (!content.length) return failedBefore(e.text)
        return Response.json({ id, type: "message", role: "assistant", model, content: finished(content), stop_reason: "end_turn",
          stop_sequence: null, usage: anthropicUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }) })
      } else if (e.kind === "stop") {
        return Response.json({ id, type: "message", role: "assistant", model, content: finished(content), stop_reason: e.reason, stop_sequence: null,
          usage: anthropicUsage(e.usage) })
      }
    }
    return errorResponse(502, "the reply ended before it was complete")
  }

  // an error before any of the answer is a status, as the built-in's
  const head = await it.next()
  if (head.value?.kind === "error") return failedBefore(head.value.text)
  let pending = head

  const enc = new TextEncoder()
  const sse = (type, data) => enc.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  let index = -1
  let open = "" // the kind of block open
  let started = false
  const body = new ReadableStream({
    async pull(ctl) {
      if (!started) {
        started = true
        ctl.enqueue(sse("message_start", { message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null,
          stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } }))
        return
      }
      const close = () => {
        if (open) ctl.enqueue(sse("content_block_stop", { index }))
        open = ""
      }
      const begin = (kind, block) => {
        close()
        index++
        open = kind
        ctl.enqueue(sse("content_block_start", { index, content_block: block }))
      }
      const r = pending ?? (await it.next())
      pending = null
      if (r.done) return ctl.close()
      const e = r.value
      switch (e.kind) {
        case "text":
          if (open !== "text") begin("text", { type: "text", text: "" })
          ctl.enqueue(sse("content_block_delta", { index, delta: { type: "text_delta", text: e.text } }))
          break
        case "think":
          if (open !== "thinking") begin("thinking", { type: "thinking", thinking: "", signature: "" })
          ctl.enqueue(sse("content_block_delta", { index, delta: { type: "thinking_delta", thinking: e.text } }))
          break
        case "sig":
          if (open === "thinking") ctl.enqueue(sse("content_block_delta", { index, delta: { type: "signature_delta", signature: e.text } }))
          break
        case "toolStart":
          begin("tool", { type: "tool_use", id: e.id, name: names.get(e.name) ?? e.name, input: {} })
          break
        case "toolArgs":
          if (open === "tool") ctl.enqueue(sse("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: e.text } }))
          break
        case "serverTool":
          begin("server", { type: "server_tool_use", id: e.id, name: e.name, input: {} })
          ctl.enqueue(sse("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(e.input) } }))
          close()
          break
        case "searched":
          begin("searched", { type: "web_search_tool_result", tool_use_id: e.id, content: e.content })
          close()
          break
        case "error":
          close()
          ctl.enqueue(sse("error", { error: { type: "api_error", message: e.text } }))
          return ctl.close()
        case "stop":
          close()
          ctl.enqueue(sse("message_delta", { delta: { stop_reason: e.reason, stop_sequence: null }, usage: anthropicUsage(e.usage) }))
          ctl.enqueue(sse("message_stop", {}))
          return ctl.close()
      }
    },
    cancel() {
      it.return?.()
    },
  })
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } })
}

// ---- web search: Kiro's own, for Anthropic's hosted tool ----------------------------
//
// A request offering Anthropic's hosted web search ({type:
// "web_search_20250305", name: "web_search"}) has it searched by Kiro's own
// web search, as kiro-cli (2.35) searches: its runtime's InvokeMCP
// operation (AWS JSON 1.0, x-amz-target
// AmazonCodeWhispererStreamingService.InvokeMCP, POSTed to the runtime's
// root) carrying a JSON-RPC tools/call of web_search, with the account's
// token and profile. The model is offered kiro-cli's web_search tool; a call
// it makes to it is searched here, the pages found go back to it as the
// call's result and it is asked again, and the caller is answered with
// server_tool_use and web_search_tool_result blocks and the answer, as
// Anthropic answers. The caller's own tools are never run here.

const SEARCH_TYPE = "web_search_20250305"
const SEARCH_NAME = "web_search"
const MCP_TARGET = "AmazonCodeWhispererStreamingService.InvokeMCP"
const SEARCH_USES = 10 // searches one request may make at most, max_uses or not
const SEARCH_QUERY = 200 // characters: what kiro-cli's web_search says its query takes
const SEARCH_TIMEOUT = 30_000
const SEARCH_BODY = 1 << 20 // bytes of a search's answer read at most
const SEARCH_RESULTS = 20
// PURPOSE is what kiro-cli's agent adds to every tool it offers: the model
// says why it calls it. It isn't searched for, nor shown to the caller.
const PURPOSE = "__tool_use_purpose"
// kiro-cli's web_search, as its agent offers it (2.35's own strings)
const SEARCH_SPEC = {
  name: SEARCH_NAME,
  description: "WebSearch looks up information that is outside the model's training data or cannot be reliably inferred from the current codebase/context.",
  inputSchema: { json: { type: "object", properties: {
    query: { type: "string", maxLength: SEARCH_QUERY, description: "Search query (max 200 chars) - use concise keywords, not full sentences" },
    [PURPOSE]: { type: "string", description: "A brief explanation why you are making this tool use." },
  }, required: ["query"] } },
}

// hostedSearch is the request's hosted web search, as it asks for it: the
// tool, how many searches it allows, and the domains it keeps or drops.
// null when it offers none; { error } when it asks for what can't be done.
function hostedSearch(req) {
  // magpie takes any tool whose type begins web_search for a web search and,
  // as this provider searches (config: searches), passes it here rather
  // than searching for it: one this can't search with is refused, not
  // dropped, so a search asked for isn't silently gone
  const searches = (req.tools ?? []).filter((t) => typeof t?.type === "string" && t.type.startsWith("web_search"))
  const odd = searches.find((t) => t.type !== SEARCH_TYPE || t.name !== SEARCH_NAME)
  if (odd) return { error: `the hosted web search on Kiro is {type: "${SEARCH_TYPE}", name: "${SEARCH_NAME}"}, not {type: ${JSON.stringify(odd.type)}, name: ${JSON.stringify(odd.name ?? null)}}; ` +
    "set provider.kiro.searches to false to have magpie search for it" }
  if (searches.length > 1) return { error: "web_search is offered more than once" }
  const tool = searches[0]
  if (!tool) return null
  if ((req.tools ?? []).some((t) => t !== tool && toolName(t?.name ?? "") === SEARCH_NAME))
    return { error: "two tools are named web_search: the hosted web search and another" }
  // Kiro's search has no place for where the user is
  if (tool.user_location) return { error: "web_search's user_location isn't supported on Kiro" }
  const list = (v) => (Array.isArray(v) ? v.filter((d) => typeof d === "string" && d.trim()).map((d) => d.trim()) : [])
  const allowed = list(tool.allowed_domains)
  const blocked = list(tool.blocked_domains)
  if (allowed.length && blocked.length) return { error: "web_search takes allowed_domains or blocked_domains, not both" }
  // a max_uses given is a whole number of at least 1, as Anthropic's API
  // takes it; none given is SEARCH_USES, and none is more
  if (tool.max_uses != null && !(Number.isInteger(tool.max_uses) && tool.max_uses > 0))
    return { error: "web_search's max_uses must be a whole number of at least 1" }
  return { tool, uses: Math.min(tool.max_uses ?? SEARCH_USES, SEARCH_USES), allowed, blocked }
}

// a domain as Anthropic's allowed_domains and blocked_domains name one:
// the host and its subdomains, and under a path when it gives one (a
// host's case doesn't matter, a path's does)
function inDomain(url, domain) {
  const slash = domain.indexOf("/")
  const host = (slash < 0 ? domain : domain.slice(0, slash)).replace(/^\*\./, "").toLowerCase()
  const path = slash < 0 ? "" : domain.slice(slash)
  const h = url.hostname.toLowerCase()
  return (h === host || h.endsWith("." + host)) && (!path || url.pathname.startsWith(path))
}

// searched is what each search found, by its server_tool_use id, as the
// model was given it: a conversation sent again with the result has its
// snippets told the model again. Bounded; one not kept is told from the
// result's titles and URLs.
const searched = new Map()
const SEARCHED_KEEP = 64
const keepSearched = (id, text) => {
  searched.set(id, text)
  if (searched.size > SEARCHED_KEEP) searched.delete(searched.keys().next().value)
}

const SEARCH_ERRORS = {
  invalid_tool_input: "the search query was missing or not text",
  query_too_long: `the search query was longer than ${SEARCH_QUERY} characters`,
  max_uses_exceeded: "no more searches are allowed for this request; answer with what was found",
  too_many_requests: "the search service is rate limited",
  unavailable: "the search service is unavailable",
}
const searchFailedText = (code) => "Web search failed: " + (SEARCH_ERRORS[code] ?? String(code ?? "unavailable"))

// searchedText is a web_search_tool_result told as text, for the model;
// null when it is an error.
function searchedText(p) {
  if (!Array.isArray(p?.content)) return null
  const kept = searched.get(p.tool_use_id)
  if (kept) return kept
  if (!p.content.length) return "No results."
  return p.content.filter((r) => r?.url).map((r, i) => `[${i + 1}] ${r.title || r.url}\nURL: ${r.url}` +
    (r.page_age ? `\nPublished: ${r.page_age}` : "")).join("\n\n")
}

// secretless is a message with anything like a token taken out, and short.
const secretless = (s) => String(s ?? "").replace(/Bearer\s+\S+/gi, "Bearer …").replace(/\b(ksk_|aoa|aor)[A-Za-z0-9._\-]{8,}/g, "…").slice(0, 200)

// bounded reads at most limit bytes of a body: null past it.
async function bounded(res, limit) {
  if (!res.body) return ""
  const reader = res.body.getReader()
  const parts = []
  let n = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    n += value.length
    if (n > limit) {
      await reader.cancel().catch(() => {})
      return null
    }
    parts.push(value)
  }
  return new TextDecoder().decode(Buffer.concat(parts))
}

// webSearch searches with Kiro's web_search through InvokeMCP: { results }
// (Anthropic's web_search_result blocks) and the text the model is given,
// or { code } (a web_search_tool_result_error's error_code) and why, or
// { status: 403 } for a token Kiro turned down. An abort is thrown. The
// profile is InvokeMCPRequest's profileArn, which AWS JSON 1.0 sends in the
// body: without it there Kiro answers 400 "profileArn is required for this
// request", the x-amzn-kiro-profile-arn header (its httpHeader binding in
// Kiro's REST model, sent too, as kiro-cli 2.35 sends it) notwithstanding.
// An API key names no profile, as kiro-cli names none for one. The tool's
// arguments are its query alone.
async function webSearch(a, query, hosted, signal) {
  const timeout = AbortSignal.timeout(SEARCH_TIMEOUT)
  const both = signal ? AbortSignal.any([signal, timeout]) : timeout
  const body = { jsonrpc: "2.0", id: "1", method: "tools/call", ...(a.profile ? { profileArn: a.profile } : {}),
    params: { name: SEARCH_NAME, arguments: { query } } }
  let res, text
  try {
    res = await fetch(runtime(a.region) + "/", { method: "POST", body: JSON.stringify(body), signal: both,
      headers: { ...sdkHeaders(a), "amz-sdk-request": "attempt=1; max=3", "Content-Type": "application/x-amz-json-1.0",
        "x-amz-target": MCP_TARGET, ...(a.profile ? { "x-amzn-kiro-profile-arn": a.profile } : {}) } })
    if (res.status === 403) {
      await res.body?.cancel().catch(() => {})
      return { status: 403 }
    }
    text = await bounded(res, SEARCH_BODY)
  } catch (e) {
    if (signal?.aborted) throw e
    return { code: "unavailable", why: timeout.aborted ? "the search timed out" : "the search service couldn't be reached: " + secretless(e?.message) }
  }
  if (!res.ok) return { code: res.status === 429 ? "too_many_requests" : "unavailable", why: `the search service answered ${res.status}` }
  if (text === null) return { code: "unavailable", why: "the search's answer was too long" }
  return searchAnswer(text, hosted)
}

// searchAnswer reads InvokeMCP's answer, { jsonrpc, id, result, error }: the
// result is the tools/call's, its content a text block of the search's JSON.
function searchAnswer(text, hosted) {
  let m
  try {
    m = JSON.parse(text)
  } catch {}
  const bad = (why) => ({ code: "unavailable", why })
  if (!m || typeof m !== "object") return bad("the search's answer wasn't JSON")
  if (m.error) return bad("the search failed: " + secretless(m.error.message ?? m.error.code))
  // a document, which may come as its JSON text
  let result = m.result
  if (typeof result === "string")
    try {
      result = JSON.parse(result)
    } catch {}
  const content = Array.isArray(result?.content) ? result.content : []
  const out = content.find((c) => c?.type === "text" && typeof c.text === "string")
  if (result?.isError) return bad("the search failed: " + secretless(out?.text))
  let r
  try {
    r = JSON.parse(out?.text ?? "")
  } catch {
    return bad("the search's answer wasn't one it reads")
  }
  if (!r || typeof r !== "object" || !Array.isArray(r.results)) return bad("the search's answer had no results list")
  if (r.error) return bad("the search failed: " + secretless(typeof r.error === "string" ? r.error : r.error.message))
  const results = []
  const lines = []
  for (const h of r.results) {
    let url
    try {
      url = new URL(String(h?.url ?? ""))
    } catch {
      continue
    }
    if (!/^https?:$/.test(url.protocol)) continue
    // Kiro's search has no domain filter: what it found outside the domains
    // asked for is left out
    if (hosted.allowed.length && !hosted.allowed.some((d) => inDomain(url, d))) continue
    if (hosted.blocked.some((d) => inDomain(url, d))) continue
    const title = typeof h.title === "string" && h.title.trim() ? h.title.trim() : url.href
    const age = typeof h.publishedDate === "string" && h.publishedDate ? h.publishedDate.slice(0, 64) : null
    // encrypted_content is the searcher's sealed copy of the page: Kiro
    // has none, and none is made up (as magpie's searchResultBlock)
    results.push({ type: "web_search_result", title, url: url.href, encrypted_content: "", page_age: age })
    const snippet = typeof h.snippet === "string" ? h.snippet.trim().slice(0, 2000) : ""
    lines.push(`[${results.length}] ${title}\nURL: ${url.href}` + (age ? `\nPublished: ${age}` : "") + (snippet ? `\n${snippet}` : ""))
    if (results.length >= SEARCH_RESULTS) break
  }
  return { results, text: lines.length ? lines.join("\n\n") : "No results." }
}

// generate answers a Messages request through Kiro's API: once more,
// refreshed, when Kiro turns the token down (403). As the built-in: no
// credentials is a 401, a failed refresh after the 403 a 502; none marks
// the account.
async function generate(creds, auth, req, signal, conversation) {
  const model = String(req.model ?? "auto")
  const budget = thinking(req, model)
  const hosted = hostedSearch(req)
  if (hosted?.error) return errorResponse(400, hosted.error)
  const first = await ask(creds, auth, req, model, budget, signal, conversation)
  if (!first.res) return errorResponse(first.status, first.message, first.wait)
  const it = hosted ? searching(creds, auth, req, model, budget, signal, hosted, first, conversation) : events(first.res.body, model, budget, responses.has(first.res))
  return kept(await reply(it, model, req.stream === true, toolNames(req)))
}

// ask sends one turn to Kiro: { res, a }, a 200, or the { status, message }
// of a failure.
async function ask(creds, auth, req, model, budget, signal, conversation) {
  let a
  try {
    a = await creds(auth)
  } catch (e) {
    return { status: 401, message: e.message }
  }
  if (a.pinned) return { status: 429, message: pinnedUnavailable(a) }
  let res
  try {
    res = await paced(a, await kiroBody(req, model, a.profile, budget, conversation), signal)
  } catch (e) {
    if (e?.name === "AbortError") throw e
    return { status: 502, message: e.message }
  }
  if (res.status === 403) {
    await res.body?.cancel()
    try {
      a = await creds(auth, true)
    } catch (e) {
      return { status: 502, message: e.message }
    }
    try {
      res = await paced(a, await kiroBody(req, model, a.profile, budget, conversation), signal)
    } catch (e) {
      if (e?.name === "AbortError") throw e
      return { status: 502, message: e.message }
    }
  }
  // an Identity Center account whose region's credits are used up goes on
  // in its other enabled region, once each; with none left it is used up
  // for magpie, and says which regions are and which aren't enabled
  const tried = new Set()
  while (!res.ok && a.key && creds.spend) {
    const text = (await res.text()).slice(0, 1 << 20)
    const f = { ...failure(res.status, text, requestID(res.headers)), wait: waitOf(res.headers, text) }
    if (!usedUpSaid(f.message)) return f
    tried.add(a.region)
    creds.spend(a.key, a.region)
    let next
    try {
      next = await creds(auth)
    } catch (e) {
      return { status: 401, message: e.message }
    }
    if (next.pinned) return { status: 429, message: pinnedUnavailable(next) + f.message, wait: f.wait }
    if (tried.has(next.region)) return { status: 429, message: regionsUsedUp(next) + f.message, wait: f.wait }
    a = next
    try {
      res = await paced(a, await kiroBody(req, model, a.profile, budget, conversation), signal)
    } catch (e) {
      if (e?.name === "AbortError") throw e
      return { status: 502, message: e.message }
    }
  }
  if (!res.ok) {
    // Kiro's own 401 is passed on, as the built-in did, the sign-in kept
    const text = (await res.text()).slice(0, 1 << 20)
    return { ...failure(res.status, text, requestID(res.headers)), wait: waitOf(res.headers, text) }
  }
  return { res, a }
}

// pinnedUnavailable heads the 429 of an account set to one region (a
// "<region>-only" switch) whose region is not enabled or used up: the other
// region is not tried, as the switch says.
function pinnedUnavailable(a) {
  const enabled = a.open?.includes(a.pinned)
  return enabled
    ? `Kiro credits used up in ${a.pinned}, the only region this account is set to use (magpie's ${onlyOption(a.pinned)} switch is on). `
    : `${a.pinned} is not enabled for this account, and magpie's ${onlyOption(a.pinned)} switch is on, so no other region is used: ask your admin to enable it. `
}

// regionsUsedUp heads the 429 of an account with every enabled region used
// up: the regions, and those not enabled, which an admin may enable.
function regionsUsedUp(a) {
  const off = CREDIT_REGIONS.filter((r) => !a.open?.includes(r))
  return `Kiro credits used up in ${(a.open ?? []).join(", ")}` + (off.length ? `; ${off.join(", ")} not enabled: ask your admin to enable it` : "") + ". "
}

const aborted = () => Object.assign(new Error("the request was cancelled"), { name: "AbortError" })

// searching is events for a request offering the hosted web search, over
// as many turns as its searches take: a call the model makes to it is
// searched rather than passed on (serverTool, searched), and Kiro is asked
// again with what was found, until it answers, calls a tool of the
// caller's (passed on as ever, the searches of its turn with it), or has
// taken hosted.uses + 2 turns (pause_turn, which the caller may send back
// to go on). Searches past hosted.uses are max_uses_exceeded.
async function* searching(creds, auth, req, model, budget, signal, hosted, first, conversation) {
  let { res, a } = first
  const messages = [...(req.messages ?? [])]
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reported: false, searches: 0 }
  let refreshed = false
  for (let turn = 1; ; turn++) {
    const said = [] // this turn's blocks, for the next turn's history
    const calls = [] // its searches
    let client = false
    let current = null
    let stop = null
    for await (const e of events(res.body, model, budget, responses.has(res))) {
      if (e.kind === "toolStart") {
        current = e.name === SEARCH_NAME ? { args: "" } : null
        if (current) calls.push(current)
        else {
          client = true
          said.push({ type: "tool_use", id: e.id, name: e.name, input: "" })
          yield e
        }
      } else if (e.kind === "toolArgs") {
        if (current) current.args += e.text
        else {
          const b = said.at(-1)
          if (b?.type === "tool_use") b.input += e.text
          yield e
        }
      } else if (e.kind === "stop") stop = e
      else {
        if (e.kind === "text") {
          const b = said.at(-1)
          if (b?.type === "text") b.text += e.text
          else said.push({ type: "text", text: e.text })
        }
        if (e.kind === "error") {
          // in a turn after a search, a status, not a finished answer
          // (reply): one past the window says so, as failedBefore does
          if (turn > 1 && tooLongSaid(e.text)) yield { ...e, status: 400, text: TOO_LONG + e.text }
          else yield turn > 1 ? { ...e, status: 502 } : e
          return
        }
        yield e
      }
    }
    if (signal?.aborted) throw aborted()
    if (!stop) return
    usage.input += stop.usage.input
    usage.output += stop.usage.output
    usage.cacheRead += stop.usage.cacheRead
    usage.cacheWrite += stop.usage.cacheWrite
    usage.reported ||= stop.usage.reported
    if (stop.usage.credits !== undefined) usage.credits = (usage.credits ?? 0) + stop.usage.credits
    for (const b of said)
      if (b.type === "tool_use")
        try {
          b.input = b.input ? JSON.parse(b.input) : {}
        } catch {
          b.input = {}
        }
    if (!calls.length) {
      yield { ...stop, usage }
      return
    }
    for (const c of calls) {
      const id = "srvtoolu_" + randomBytes(12).toString("hex")
      let input = {}
      try {
        const v = c.args ? JSON.parse(c.args) : {}
        if (v && typeof v === "object" && !Array.isArray(v)) input = v
      } catch {}
      // why the model searched (PURPOSE) is kiro-cli's, not Anthropic's: the
      // caller sees the query alone, and only it is searched for
      const { [PURPOSE]: _why, ...shown } = input
      input = shown
      yield { kind: "serverTool", id, name: SEARCH_NAME, input }
      const query = typeof input.query === "string" ? input.query.trim() : ""
      let found
      if (!query) found = { code: "invalid_tool_input" }
      else if (query.length > SEARCH_QUERY) found = { code: "query_too_long" }
      else if (usage.searches >= hosted.uses) found = { code: "max_uses_exceeded" }
      else {
        usage.searches++
        found = await webSearch(a, query, hosted, signal)
        // a token Kiro turned down is refreshed once for the request, as a
        // turn's is
        if (found.status === 403 && !refreshed) {
          refreshed = true
          try {
            a = await creds(auth, true)
            found = await webSearch(a, query, hosted, signal)
          } catch (e) {
            if (e?.name === "AbortError" || signal?.aborted) throw e
            found = { code: "unavailable", why: secretless(e?.message) }
          }
        }
        if (found.status === 403) found = { code: "unavailable", why: "Kiro turned down the token for its web search (403)" }
      }
      const content = found.results ?? { type: "web_search_tool_result_error", error_code: found.code }
      keepSearched(id, found.results ? found.text : searchFailedText(found.code) + (found.why ? ` (${found.why})` : ""))
      yield { kind: "searched", id, content }
      said.push({ type: "server_tool_use", id, name: SEARCH_NAME, input }, { type: "web_search_tool_result", tool_use_id: id, content })
    }
    if (signal?.aborted) throw aborted()
    if (client) {
      yield { kind: "stop", reason: "tool_use", usage }
      return
    }
    if (turn >= hosted.uses + 2) {
      yield { kind: "stop", reason: "pause_turn", usage }
      return
    }
    messages.push({ role: "assistant", content: said })
    const next = await ask(creds, auth, { ...req, messages }, model, budget, signal, conversation)
    if (!next.res) {
      yield { kind: "error", status: next.status, text: `Kiro, after its web search: ${next.message} (${next.status})` }
      return
    }
    ;({ res, a } = next)
  }
}

// ---- signing in ----------------------------------------------------------------------

function page(ok, title, text) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c])
  return `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font:15px system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;color:#222;background:#fafafa}
@media (prefers-color-scheme:dark){body{color:#eee;background:#161616}}main{text-align:center;max-width:28rem;padding:1rem}
.d{font-size:2rem;color:${ok ? "#2a9d5c" : "#c0392b"}}</style>
<main><div class="d">${ok ? "✓" : "✕"}</div><h1>${esc(title)}</h1><p>${esc(text)}</p></main>`
}

// signInPost posts JSON to Kiro's auth service or AWS's sign-in.
async function signInPost(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": IDE_UA },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  const text = await res.text()
  if (!res.ok) {
    let e = {}
    try {
      e = JSON.parse(text)
    } catch {}
    throw new Error(`the sign-in was refused (${res.status}): ${e.error_description || e.message || e.error || res.statusText}`)
  }
  return JSON.parse(text)
}

const expiry = (s) => Date.now() + (s > 0 ? s : 3600) * 1000

// what Kiro's page says of where to sign in at AWS, taken only in its shape:
// the region goes into AWS's host names
const AWS_REGION = /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/
// the ways Kiro's page comes back with a choice of
const KIRO_WAYS = ["google", "github", "builderid", "awsidc", "internal", "external_idp"]
function httpsURL(s) {
  try {
    const u = new URL(s)
    return u.protocol === "https:" && !u.username && !u.password
  } catch {
    return false
  }
}

// whoIs names a new sign-in with the email Kiro has for it, and its plan.
async function whoIs(c) {
  try {
    const profile = c.profile || (await profileOf(c))
    const a = { token: c.access, tokenType: tokenType(c), profile, region: regionOf(profile, c.region) }
    const l = await usageLimits(a, true)
    return { profile, email: l?.userInfo?.email ?? "", plan: planName(l?.subscriptionInfo?.subscriptionTitle) }
  } catch {
    return { profile: c.profile ?? "", email: "", plan: "" }
  }
}

async function listen() {
  for (const port of CALLBACK_PORTS) {
    const server = createServer()
    const ok = await new Promise((resolve) => {
      server.once("error", () => resolve(false))
      server.listen(port, "127.0.0.1", () => resolve(true))
    })
    if (ok) return { server, port }
  }
  throw new Error("the ports Kiro's sign-in comes back to are all busy; close the Kiro IDE's sign-in and try again")
}

// signingIn ends the browser sign-in under way, if any, and frees its
// port: magpie keeps one sign-in of a provider at a time, and one left
// behind (a tab closed, a paste never made) kept its port till it timed
// out, so a few of them left no port for the next
let signingIn = null

// browserSignIn is the IDE's: Kiro's sign-in page, back to a port here.
async function browserSignIn(inputs = {}) {
  const choice = inputs.loginMethod || "portal"
  if (!["portal", "builderid", "enterprise"].includes(choice)) throw new Error("unknown Kiro sign-in method")
  const issuer = choice === "enterprise" ? String(inputs.startUrl || "").trim() : BUILDER_ID_START
  const region = String(inputs.region || "us-east-1").trim()
  if (choice === "enterprise" && !httpsURL(issuer)) throw new Error("Enter the organization's HTTPS Start URL")
  if (choice !== "portal" && !AWS_REGION.test(region)) throw new Error("Enter a valid AWS region")
  signingIn?.()
  const { server, port } = await listen()
  const state = randomBytes(24).toString("base64url")
  const verifier = randomBytes(48).toString("base64url")
  const redirect = `http://localhost:${port}`
  const aws = {} // once Kiro's page has sent the browser on to AWS
  const awsRedirect = `http://127.0.0.1:${port}/oauth/callback`
  let waiting = true
  let settle
  const done = new Promise((r) => (settle = r))
  const finish = (result) => {
    if (!waiting) return
    waiting = false
    settle(result)
  }

  // A sign-in comes back here once (Google, GitHub), or twice (Builder ID,
  // Identity Center: Kiro's page, then AWS's). The browser may be on
  // another computer (magpie on a server or in Docker): the address its
  // tab ended on is pasted there, and magpie opens it here, on this port
  // (magpie's pluginsignin_paste.go), following a 302 to AWS as the next
  // page. So each stage answers only its own state, once, and a request
  // that isn't this sign-in's is a 404, which magpie says is the wrong
  // address at once instead of waiting.
  let stage = "portal" // then "aws", then "over"
  let busy = false // a code being traded: a second paste of it waits for the first
  let onToAWS = "" // the page the portal stage sent the browser on to, said again to a repeat
  let portalAsked = "" // what that stage was asked, so a repeat asking otherwise isn't taken
  async function startAWS(opt, issuer, region) {
    const reg = await signInPost(oidc(region) + "/client/register", { clientName: "Kiro IDE", clientType: "public", scopes: SCOPES,
      grantTypes: ["authorization_code", "refresh_token"], redirectUris: ["http://127.0.0.1/oauth/callback"], issuerUrl: issuer })
    if (stage === "over") throw new Error("this sign-in was cancelled")
    if (!reg.clientId) throw new Error("AWS registered no client")
    Object.assign(aws, { region, clientId: reg.clientId, clientSecret: reg.clientSecret,
      provider: { builderid: "BuilderId", awsidc: "Enterprise", internal: "Internal" }[opt],
      state: randomBytes(24).toString("base64url"), verifier: randomBytes(48).toString("base64url") })
    const a = new URLSearchParams({ response_type: "code", client_id: aws.clientId, redirect_uri: awsRedirect, scopes: SCOPES.join(","),
      state: aws.state, code_challenge: createHash("sha256").update(aws.verifier).digest("base64url"), code_challenge_method: "S256" })
    onToAWS = `${oidc(region)}/authorize?${a}`
    portalAsked = JSON.stringify([opt, issuer, region])
    stage = "aws"
    busy = false
    return onToAWS
  }

  server.on("request", async (req, res) => {
    // each answer its own connection: none held open keeps the port once
    // the sign-in is over
    res.setHeader("Connection", "close")
    const url = new URL(req.url ?? "/", redirect)
    const html = (code, body) => {
      res.writeHead(code, { "Content-Type": "text/html; charset=utf-8" })
      res.end(body)
    }
    if (url.pathname !== "/oauth/callback" && url.pathname !== "/signin/callback") return res.writeHead(404).end()
    const q = url.searchParams
    const over = () => html(404, page(false, "This sign-in is over", "Start it again."))
    const notOurs = () => html(404, page(false, "This link isn't from this sign-in", "Paste the address of the tab this sign-in opened, or start it again."))
    if (stage === "over") return over()
    const fail = (msg) => {
      stage = "over"
      finish({ type: "failed", error: msg })
      html(200, page(false, "Sign-in didn't finish", msg))
    }
    const got = q.get("state") ?? ""
    const portal = got === state
    const fromAWS = stage === "aws" && !!aws.state && got === aws.state
    // a stale tab, another sign-in's, or a page that just sends a request
    // here: it says nothing about this one, and can't end it
    if (!portal && !fromAWS) return notOurs()
    if (busy) return html(409, page(false, "Already finishing", "This sign-in is finishing with this address already."))
    if (q.get("error")) return fail(q.get("error_description") || q.get("error"))
    let c
    try {
      if (fromAWS) {
        // back from AWS, to the address it was sent with
        if (url.pathname !== "/oauth/callback") return notOurs()
        if (!q.get("code")) return fail("AWS sent back no code")
        busy = true
        const t = await signInPost(oidc(aws.region) + "/token", { clientId: aws.clientId, clientSecret: aws.clientSecret,
          grantType: "authorization_code", redirectUri: awsRedirect, code: q.get("code"), codeVerifier: aws.verifier })
        if (!t.accessToken) throw new Error("AWS sent back no token")
        c = { access: t.accessToken, refresh: t.refreshToken ?? "", expires: expiry(t.expiresIn), method: "idc", loginProvider: aws.provider,
          region: aws.region, clientId: aws.clientId, clientSecret: aws.clientSecret, profile: "", builderID: isBuilderID(aws.provider) }
      } else {
        const opt = q.get("login_option") ?? ""
        const asked = JSON.stringify([opt, q.get("issuer_url"), q.get("idc_region")])
        if (stage === "aws") {
          // Kiro's page's address again (pasted twice, or reloaded): the
          // same AWS page, not a second client and state, which would
          // leave the first AWS tab's code refused
          if (onToAWS && asked === portalAsked) {
            res.writeHead(302, { Location: onToAWS })
            return res.end()
          }
          // chosen again on Kiro's page (Back, then another way): that
          // choice now, the AWS sign-in left behind dropped. Anything else
          // with Kiro's page's state isn't a choice, and leaves AWS's going
          if (!KIRO_WAYS.includes(opt)) return notOurs()
          stage = "portal"
          onToAWS = portalAsked = ""
          for (const k of Object.keys(aws)) delete aws[k]
        }
        if (opt === "google" || opt === "github") {
          if (!q.get("code")) return fail("Kiro's page sent back no code")
          busy = true
          const t = await signInPost(AUTH_SERVICE + "/oauth/token", { code: q.get("code"), code_verifier: verifier,
            redirect_uri: redirect + url.pathname + "?login_option=" + opt })
          if (!t.accessToken) throw new Error("Kiro sent back no token")
          c = { access: t.accessToken, refresh: t.refreshToken ?? "", expires: expiry(t.expiresIn), method: "social",
            loginProvider: opt === "google" ? "Google" : "Github", region: "us-east-1", profile: t.profileArn ?? "" }
        } else if (opt === "builderid" || opt === "awsidc" || opt === "internal") {
          // on to AWS, with a client registered for this sign-in. The region
          // goes into AWS's host name, so it is only a region's shape
          const issuer = q.get("issuer_url")
          const region = q.get("idc_region")
          if (!issuer || !region) return fail("Kiro's page didn't say where to sign in at AWS")
          if (!AWS_REGION.test(region)) return fail("Kiro's page named a region AWS doesn't have")
          if (!httpsURL(issuer)) return fail("Kiro's page named an AWS sign-in that isn't an https address")
          busy = true
          await startAWS(opt, issuer, region)
          res.writeHead(302, { Location: onToAWS })
          return res.end()
        } else if (opt === "external_idp") {
          return fail("A company's own identity provider can't be signed in to here yet; sign in with `kiro-cli login`, and use Kiro CLI's sign-in")
        } else return fail(`Kiro's page came back with a sign-in this plugin doesn't know (${JSON.stringify(opt)})`)
      }
    } catch (e) {
      if (stage === "over") return over()
      busy = false
      return fail(e.message)
    }
    if (stage === "over") return over() // ended (a new sign-in, the time) while the code was traded
    // still busy while it is named: a second paste is told it is finishing
    const who = await whoIs(c)
    if (stage === "over") return over()
    const user = who.email ? nameOf(who.email, c.loginProvider) : "Kiro account"
    stage = "over"
    finish({ type: "success", provider: ID, refresh: c.refresh, access: c.access, expires: c.expires, accountId: user,
      ...(uidOf(c.loginProvider) ? { uid: uidOf(c.loginProvider) } : {}),
      method: c.method, loginProvider: c.loginProvider, region: c.region, profileArn: who.profile,
      ...(c.clientId ? { clientId: c.clientId, clientSecret: c.clientSecret } : {}), ...(who.plan ? { plan: who.plan } : {}) })
    html(200, page(true, "You're signed in", `${user} is signed in. You can close this tab.`))
  })

  const timer = setTimeout(() => {
    stage = "over"
    finish({ type: "failed", error: "the sign-in timed out" })
  }, SIGN_IN_TIMEOUT)
  const end = () => {
    if (signingIn === superseded) signingIn = null
    server.close()
  }
  // a new sign-in ends this one, or, over, frees its port at once
  const superseded = () => {
    stage = "over"
    finish({ type: "failed", error: "another sign-in to Kiro was started" })
    end()
  }
  signingIn?.() // one started while this one found its port
  signingIn = superseded
  done.then(() => {
    clearTimeout(timer)
    // a late address (pasted again, a tab reloaded) is told it is over a while
    setTimeout(end, 10_000).unref?.()
  })
  if (choice === "builderid" || choice === "enterprise") {
    try {
      const url = await startAWS(choice === "enterprise" ? "awsidc" : "builderid", issuer, region)
      return {
        url,
        instructions: "Complete AWS sign-in. If magpie runs on another computer, paste the complete address of the final localhost page back here.",
        method: "auto",
        callback: () => done,
      }
    } catch (error) {
      stage = "over"
      finish({ type: "failed", error: error.message })
      end()
      throw error
    }
  }
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  const q = new URLSearchParams({ state, code_challenge: challenge, code_challenge_method: "S256", redirect_uri: redirect, redirect_from: "KiroIDE" })
  return {
    url: `${PORTAL}/signin?${q}`,
    instructions: "Sign in to Kiro with Google, GitHub, AWS Builder ID or IAM Identity Center.",
    method: "auto",
    callback: () => done,
  }
}

// ownSignIn uses kiro-cli's sign-in, else the Kiro IDE's: nothing is copied,
// they are read where they keep it each time.
async function ownSignIn() {
  return {
    url: "",
    instructions: "Uses the account kiro-cli or the Kiro IDE is signed in to.",
    method: "auto",
    callback: async () => {
      const cli = await readCLI()
      const c = cli ?? (await readIDE())
      if (!c) return { type: "failed", error: "neither kiro-cli nor the Kiro IDE is signed in" }
      const who = fresh(c) ? await whoIs(c) : { email: "", plan: "" }
      return { type: "success", provider: ID, refresh: "", access: "", expires: 0, source: cli ? "kiro-cli" : "kiro-ide",
        accountId: who.email || (cli ? "kiro-cli's account" : "Kiro IDE's account"), ...(who.plan ? { plan: who.plan } : {}) }
    },
  }
}

// ---- the plugin ------------------------------------------------------------------------

async function bodyOf(input, init) {
  const b = init.body ?? (input instanceof Request ? await input.clone().text() : undefined)
  return JSON.parse(typeof b === "string" ? b : new TextDecoder().decode(b))
}

export async function KiroAuthPlugin({ client, magpie } = {}) {
  const creds = account(client, magpie)
  return {
    auth: {
      provider: ID,
      // magpie renews a sign-in kept here LEAD_MS before its end, once for
      // the account, before its requests, models and usage ask for it; the
      // check before each request stays for OpenCode, which doesn't call
      // this. kiro-cli's and the IDE's sign-ins have no end magpie knows
      // (expires 0) and are never asked for.
      refreshLead: LEAD_MS,
      // A failure is thrown as it is, a refusal too: the built-in marked
      // no Kiro account lapsed (see gone).
      async refresh(auth) {
        if (auth?.type !== "oauth" || auth.source || !auth.access || !auth.refresh) return undefined
        return creds.renew(auth)
      },
      async loader(getAuth) {
        const auth = await getAuth()
        if (!(auth?.type === "api" && auth.key) && auth?.type !== "oauth") return {}
        return {
          baseURL: BASE,
          apiKey: "kiro", // the fetch signs each request itself
          // every Messages request answered through Kiro's own API
          async fetch(input, init = {}) {
            const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
            if (!/\/messages$/.test(new URL(url).pathname))
              return errorResponse(404, `this plugin only answers Anthropic Messages requests, not ${new URL(url).pathname}`)
            let req
            try {
              req = await bodyOf(input, init)
            } catch {
              return errorResponse(400, "a request that isn't JSON")
            }
            return generate(creds, (await getAuth()) ?? auth, req, init.signal, sessionOf(input, init))
          },
        }
      },
      // the account's credits, as magpie's built-in showed them. A sign-in
      // Kiro refused (gone) marks the account signed out, so magpie passes
      // over it and its row offers Sign in again; a clean read takes the
      // mark off, as after `kiro-cli login`. Any other failure keeps it.
      async usage(getAuth) {
        const auth = await getAuth()
        if (!(auth?.type === "api" && auth.key) && auth?.type !== "oauth") return { error: "not signed in", signIn: "kept" }
        try {
          const a = await creds(auth)
          let u
          if (a.key) {
            // every credit region, the ones not enabled told as such
            const reads = await Promise.all(CREDIT_REGIONS.map(async (region) => {
              if (!a.profiles[region]) return { region }
              try {
                return { region, l: await usageLimits({ ...a, region, profile: a.profiles[region] }, true) }
              } catch (error) {
                return { region, error }
              }
            }))
            if (reads.every((r) => r.error || !r.l)) throw reads.find((r) => r.error)?.error ?? new Error("Kiro read no credits")
            const got = regionsUsage(reads, Date.now(), onlyRegion(magpie))
            for (const r of got.regions) creds.spend(a.key, r.region, r.full ? r.resetsAt || 0 : -1)
            u = got.usage
          } else u = usageOf(await usageLimits(a, true))
          // named as the account is
          if (u.user && auth.type === "oauth" && !auth.source) u.user = nameOf(u.user, auth.loginProvider)
          return { ...u, signIn: "renewed" }
        } catch (e) {
          return { error: e.message, signIn: e.gone ? "expired" : "kept" }
        }
      },
      // labels, messages and hints are magpie's own fields: the same words
      // by the window's language (OpenCode shows the English)
      // magpie's switches for the provider (#2038): shown in its editor, read
      // with input.magpie.option at each request
      options: [
        ...CREDIT_REGIONS.map((region, i) => {
          const other = CREDIT_REGIONS[1 - i]
          return {
            key: onlyOption(region),
            label: `Use ${region} only`,
            description: `An Identity Center account sends every request to ${region} and none to ${other}, whatever its credits there, and its Usage counts ${region} alone. With ${region} not enabled for the account, or its credits used up, the answer is a 429 and magpie goes on to another account. Both switches off, the account uses us-east-1 first and eu-central-1 when it is used up. Both on is the same as both off. Past the plan's credits a region is billed as overage, $0.04 a credit: 10000 credits of it come to $400, about the price of another 10000-credit plan, so a region's overage is worth keeping an eye on before it is the only one in use.`,
            labels: { zh: `只使用 ${region}` },
            descriptions: { zh: `IAM Identity Center 账号的请求全部发往 ${region}，不发往 ${other}，不论后者还有多少额度，额度合计也只算 ${region}。该区域未开通或额度用完时返回 429，由 magpie 换下一个账号。两个开关都关闭时先用 us-east-1，用完再用 eu-central-1。两个都开与都关相同。超出套餐的部分按超额计费，每个 credit $0.04：超额 10000 credits 是 $400，约等于再买一个 10000 credits 的账号，只用一个区域前请留意它的超额。` },
          }
        }),
      ],
      methods: [
        { type: "oauth", label: "Kiro (Google, GitHub, AWS Builder ID, IAM Identity Center)", labels: WORDS.browser,
          prompts: [{ type: "select", key: "loginMethod", message: "Choose a sign-in method", messages: WORDS.choose, options: [
            { label: "IAM Identity Center (organization Start URL)", value: "enterprise", hint: "Sign in to your organization with its AWS Start URL", labels: WORDS.enterprise, hints: WORDS.enterpriseHint },
            { label: "AWS Builder ID", value: "builderid", hint: "Open AWS sign-in directly; one callback to paste on a remote server", hints: WORDS.builderidHint },
            { label: "Kiro sign-in page", value: "portal", hint: "Google, GitHub, IAM Identity Center or other Kiro sign-in methods", labels: WORDS.portal, hints: WORDS.portalHint },
          ] },
          { type: "text", key: "startUrl", message: "Organization Start URL", messages: WORDS.startUrl, placeholder: "https://d-xxxxxxxxxx.awsapps.com/start",
            condition: (inputs) => inputs.loginMethod === "enterprise",
            validate: (value) => httpsURL(String(value || "").trim()) ? undefined : "Enter an HTTPS Start URL" },
          { type: "text", key: "region", message: "AWS region (blank uses us-east-1)", messages: WORDS.region, placeholder: "us-east-1",
            condition: (inputs) => inputs.loginMethod === "enterprise",
            validate: (value) => !value || AWS_REGION.test(value.trim()) ? undefined : "Enter a valid AWS region" },
          ], authorize: browserSignIn },
        { type: "oauth", label: "Kiro CLI's or Kiro IDE's sign-in", labels: WORDS.own, authorize: ownSignIn },
        { type: "api", label: "Kiro API key (ksk_…)", labels: WORDS.key, placeholder: "ksk_…" },
      ],
    },
    async config(config) {
      config.provider ??= {}
      const was = config.provider[ID] ?? {}
      config.provider[ID] = {
        name: "Kiro",
        npm: MESSAGES,
        api: BASE,
        // magpie's own field (#2027): Kiro answers Anthropic's hosted web
        // search itself (searching), so magpie passes a client's on as sent
        // rather than searching for it. The user's own setting goes over it.
        searches: true,
        ...was,
        models: { ...Object.fromEntries(MODELS.map((m) => [m.id, configModel(m)])), ...(was.models ?? {}) },
      }
    },
    // the account's own list, the default first
    provider: {
      id: ID,
      async models(provider, { auth } = {}) {
        if (!(auth?.type === "api" && auth.key) && auth?.type !== "oauth") return provider.models
        try {
          const list = await listModels(await creds(auth))
          return Object.fromEntries(list.map((m) => [m.id, runtimeModel(m)]))
        } catch {
          return provider.models
        }
      },
    },
  }
}

// for tests
export const _internal = { generate, responsesBody, crMessages, crRefusal, features, FEATURES, featureKey, waitOf, timing, TRIES, refresh, usageOf, buildKiro, kiroBody, IMAGE_LIMIT, events, reply, failure, toolID, toolName, toolNames, thinking, nativeFields, listModels, rateOf, contextFirst, configModel, runtimeModel, readCLI, readIDE, regionOf, planName, frames }
