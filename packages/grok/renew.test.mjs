// A token Grok turns away before its time (plugins#324): Grok can reject a
// token hours ahead of its expires_at, so a 401 has Grok Build renew it in
// the account's home and the request, model list or usage read asks once
// more. Where the CLI's run leaves the token as it was, the failure says
// Grok Build couldn't renew it, and what helps: opening Grok Build for its
// own home, signing in through magpie for a home of the plugin's. Never
// "run `grok login`", which renews neither.
//
// auth.json caught while the CLI rewrites it is unknown, not "not signed
// in": it is read again, else the last sign-in read whole there stands.
//
// The CLI is a fake as in refresh.test.mjs: /bin/sh under grok's name,
// `grok models` being `sh models` reading the script below. FAKE_GROK says
// what the run does: renew writes a new token, same exits 0 leaving the
// token as it was (the CLI saying "Renewed" with pre_key == post_key), fail
// exits 1 as a failed silent refresh. PATH is emptied so no real grok is
// ever found, and fetch is a stand-in: nothing reaches the network.
import { noRealGrok } from "./nocli.mjs"
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GrokAuthPlugin } from "./index.mjs"

noRealGrok()

const real = globalThis.fetch
const env = { ...process.env }
const root = mkdtempSync(join(tmpdir(), "grok-renew-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const bin = join(root, "bin")
const later = new Date(Date.now() + 24 * 3600_000).toISOString()
mkdirSync(bin)
symlinkSync("/bin/sh", join(bin, "grok"))
writeFileSync(
  join(root, "models"),
  `n=$(( $(cat "$GROK_HOME/runs" 2>/dev/null || echo 0) + 1 ))
echo $n > "$GROK_HOME/runs"
case "$FAKE_GROK" in
  renew) printf '{"a":{"key":"tok-%s","email":"g@x.ai","expires_at":"${later}"}}' $n > "$GROK_HOME/auth.json" ;;
  same) ;;
  *) echo "silent refresh outcome=Failed(SelfHealing)" >&2; exit 1 ;;
esac
`,
)

let home
beforeEach(() => {
  home = mkdtempSync(join(root, "home-"))
  process.env.GROK_BIN_DIR = bin
  process.env.PATH = ""
  // the CLI's own home is elsewhere unless a test says it is this one
  process.env.GROK_HOME = join(root, "cli-home")
  process.env.FAKE_GROK = "renew"
})
afterEach(() => {
  globalThis.fetch = real
  for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k]
  Object.assign(process.env, env)
})

// signedIn writes the CLI's sign-in in home, good for a day by its own say
function signedIn(key) {
  writeFileSync(join(home, "auth.json"), JSON.stringify({ a: { key, email: "g@x.ai", expires_at: later } }))
  return { type: "oauth", refresh: home, access: key, expires: Date.parse(later), accountId: "g@x.ai" }
}
const runs = () => {
  try {
    return Number(readFileSync(join(home, "runs"), "utf8").trim() || 0)
  } catch {
    return 0
  }
}

// grok answers 401 to tok-0 and serves any other token
function grok(ok) {
  const sent = []
  globalThis.fetch = async (url, init) => {
    const auth = new Headers(init?.headers).get("Authorization")
    sent.push(auth)
    if (auth === "Bearer tok-0") return Response.json({ error: "Invalid or expired credentials" }, { status: 401 })
    return ok(String(url))
  }
  return sent
}

async function plugin() {
  const saved = []
  const hooks = await GrokAuthPlugin({ client: { auth: { set: async (x) => saved.push(x) } } })
  return { hooks, saved }
}

async function chat(auth) {
  const { hooks, saved } = await plugin()
  const opts = await hooks.auth.loader(async () => auth)
  const res = await opts.fetch("https://cli-chat-proxy.grok.com/v1/responses", { method: "POST", body: '{"model":"grok-4.7","input":"hi"}' })
  return { res, saved }
}

const MODELS = { data: [{ id: "grok-4.7", name: "Grok 4.7", api_backend: "responses", context_window: 256000 }] }

test("a request Grok turns away is sent once more with the token Grok Build renewed", async () => {
  const auth = signedIn("tok-0")
  const sent = grok(() => Response.json({ ok: true }))
  const { res, saved } = await chat(auth)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: true })
  expect(sent).toEqual(["Bearer tok-0", "Bearer tok-1"])
  expect(runs()).toBe(1)
  expect(saved.at(-1).body.access).toBe("tok-1")
})

test("a request whose token Grok Build couldn't renew says so, and to add the account again for a home of the plugin's", async () => {
  process.env.FAKE_GROK = "same"
  const auth = signedIn("tok-0")
  const sent = grok(() => Response.json({ ok: true }))
  const { res } = await chat(auth)
  expect(res.status).toBe(401)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept")
  const msg = (await res.json()).error.message
  expect(msg).toContain("Grok Build couldn't renew the sign-in (grok models ran and left the same token)")
  expect(msg).toContain("add the account in magpie again")
  expect(msg).toContain("Invalid or expired credentials")
  expect(msg).not.toContain("grok login")
  expect(msg).not.toMatch(/sign-in has expired/)
  expect(sent).toEqual(["Bearer tok-0"])
  expect(runs()).toBe(1)
})

test("for Grok Build's own home, a token it couldn't renew says to open Grok Build, with what the CLI said", async () => {
  process.env.FAKE_GROK = "fail"
  const auth = signedIn("tok-0")
  process.env.GROK_HOME = home
  grok(() => Response.json({ ok: true }))
  const { res } = await chat(auth)
  expect(res.status).toBe(401)
  const msg = (await res.json()).error.message
  expect(msg).toContain("Grok Build couldn't renew the sign-in (grok models exited 1: silent refresh outcome=Failed(SelfHealing))")
  expect(msg).toContain("open Grok Build and send it a message")
  expect(msg).not.toContain("grok login")
})

test("a model list Grok turns away is asked again with the renewed token", async () => {
  const auth = signedIn("tok-0")
  const sent = grok(() => Response.json(MODELS))
  const { hooks } = await plugin()
  const got = await hooks.provider.models({ id: "grok", models: {} }, { auth })
  expect(Object.keys(got)).toEqual(["grok-4.7"])
  expect(sent).toEqual(["Bearer tok-0", "Bearer tok-1"])
  expect(runs()).toBe(1)
})

test("a model list whose token Grok Build couldn't renew says so, not that the sign-in expired", async () => {
  process.env.FAKE_GROK = "same"
  const auth = signedIn("tok-0")
  grok(() => Response.json(MODELS))
  const { hooks } = await plugin()
  const e = await hooks.provider.models({ id: "grok", models: {} }, { auth }).catch((e) => e)
  expect(e).toBeInstanceOf(Error)
  expect(e.message).toContain("Grok Build couldn't renew the sign-in")
  expect(e.message).not.toMatch(/sign-in has expired|grok login/)
  expect(e.signIn).toBeUndefined()
})

test("a usage read Grok turns away is read again with the renewed token", async () => {
  const auth = signedIn("tok-0")
  const sent = grok(() => Response.json({ config: { creditUsagePercent: 10 } }))
  const { hooks } = await plugin()
  const u = await hooks.auth.usage(async () => auth)
  expect(u).toEqual({ signIn: "kept", windows: [{ name: "Allowance", used: 10 }] })
  expect(sent).toEqual(["Bearer tok-0", "Bearer tok-1"])
})

test("auth.json caught mid-write is read again, not taken as signed out", async () => {
  const auth = signedIn("tok-5")
  writeFileSync(join(home, "auth.json"), '{"a":{"key":"tok-5","em')
  setTimeout(() => signedIn("tok-5"), 150)
  const sent = grok(() => Response.json({ ok: true }))
  const { res } = await chat(auth)
  expect(res.status).toBe(200)
  expect(sent).toEqual(["Bearer tok-5"])
})

test("auth.json that stays torn is the last sign-in read whole there", async () => {
  const auth = signedIn("tok-6")
  const sent = grok(() => Response.json({ ok: true }))
  expect((await chat(auth)).res.status).toBe(200)
  writeFileSync(join(home, "auth.json"), "")
  expect((await chat(auth)).res.status).toBe(200)
  expect(sent).toEqual(["Bearer tok-6", "Bearer tok-6"])
})

test("auth.json torn with nothing read before is unknown: no account is marked signed out", async () => {
  writeFileSync(join(home, "auth.json"), '{"a":{"key":"tok-7"')
  const auth = { type: "oauth", refresh: home, access: "tok-7", expires: Date.now() + 60_000, accountId: "g@x.ai" }
  const { hooks } = await plugin()
  const e = await hooks.auth.refresh(structuredClone(auth)).catch((e) => e)
  expect(e).toBeInstanceOf(Error)
  expect(e.signIn).toBeUndefined()
  expect(e.message).toContain("couldn't be read")
  expect(e.message).not.toContain("not signed in")
})
