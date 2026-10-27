// auth.refresh: magpie renews the sign-in ahead of time by having the CLI
// renew it in the account's home, as a request does, and never runs the
// CLI there twice at once. The CLI here is a fake in GROK_BIN_DIR: on
// `grok models` it counts the run and, by FAKE_GROK, writes a new token
// (renew), drops the sign-in (logout) or fails (anything else).
import { noRealGrok } from "./nocli.mjs"
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GrokAuthPlugin } from "./index.mjs"

noRealGrok()

const real = globalThis.fetch
const env = { ...process.env }
const root = mkdtempSync(join(tmpdir(), "grok-refresh-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

// The fake CLI is /bin/sh under grok's name, not a script written here: on
// macOS the first run of a file just written waits for the system's scan
// of it, which took 4-15s on a busy machine and timed these tests out
// (#65). The plugin runs `grok models` in the folder above the account's
// home, so that is `sh models` reading the script `models` in root: a
// plain file, read and never scanned. `grok --version` is sh's own answer
// (bash's version, or dash refusing the flag); no test here checks the
// version a request says.
const bin = join(root, "bin")
const later = new Date(Date.now() + 24 * 3600_000).toISOString()
mkdirSync(bin)
symlinkSync("/bin/sh", join(bin, "grok"))
writeFileSync(
  join(root, "models"),
  `n=$(( $(cat "$GROK_HOME/runs" 2>/dev/null || echo 0) + 1 ))
echo $n > "$GROK_HOME/runs"
sleep 0.2
case "$FAKE_GROK" in
  renew) printf '{"a":{"key":"tok-%s","email":"g@x.ai","expires_at":"${later}"}}' $n > "$GROK_HOME/auth.json" ;;
  logout) rm -f "$GROK_HOME/auth.json" ;;
  *) exit 1 ;;
esac
`,
)

let home
beforeEach(() => {
  home = mkdtempSync(join(root, "home-"))
  process.env.GROK_BIN_DIR = bin
  process.env.FAKE_GROK = "renew"
})
afterEach(() => {
  globalThis.fetch = real
  for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k]
  Object.assign(process.env, env)
})

// signedIn writes the CLI's sign-in in home, its token ending at expires
function signedIn(key, expires) {
  writeFileSync(join(home, "auth.json"), JSON.stringify({ a: { key, email: "g@x.ai", expires_at: new Date(expires).toISOString() } }))
  return { type: "oauth", refresh: home, access: key, expires, accountId: "g@x.ai" }
}
const runs = () => Number(readFileSync(join(home, "runs"), "utf8").trim() || 0)

async function plugin() {
  const saved = []
  const hooks = await GrokAuthPlugin({ client: { auth: { set: async (x) => saved.push(x) } } })
  return { hooks, saved }
}

test("a token about to end is renewed by the CLI, and what it gives is returned, not saved", async () => {
  const auth = signedIn("tok-0", Date.now() + 60_000)
  const { hooks, saved } = await plugin()
  expect(hooks.auth.refreshLead).toBe(5 * 60 * 1000)
  expect(await hooks.auth.refresh(structuredClone(auth))).toEqual({ access: "tok-1", expires: Date.parse(later) })
  expect(runs()).toBe(1)
  expect(saved).toEqual([])
})

test("a request renewing meanwhile is joined: the CLI runs once", async () => {
  const auth = signedIn("tok-0", Date.now() + 60_000)
  const { hooks } = await plugin()
  const sent = []
  globalThis.fetch = async (url, init) => {
    sent.push(init.headers.get("Authorization"))
    return new Response("{}")
  }
  const opts = await hooks.auth.loader(async () => auth)
  const [got, res] = await Promise.all([
    hooks.auth.refresh(structuredClone(auth)),
    opts.fetch("https://cli-chat-proxy.grok.com/v1/responses", { method: "POST", body: '{"model":"grok-4.7","input":"hi"}' }),
  ])
  expect(res.status).toBe(200)
  expect(runs()).toBe(1)
  expect(got).toEqual({ access: "tok-1", expires: Date.parse(later) })
  expect(sent).toEqual(["Bearer tok-1"])
})

test("a token the CLI renewed already is returned without running it", async () => {
  const auth = signedIn("tok-0", Date.now() + 60_000)
  signedIn("tok-9", Date.parse(later))
  const { hooks } = await plugin()
  expect(await hooks.auth.refresh(structuredClone(auth))).toEqual({ access: "tok-9", expires: Date.parse(later) })
  expect(() => runs()).toThrow()
})

test("a sign-in the CLI dropped is one to make again", async () => {
  process.env.FAKE_GROK = "logout"
  const auth = signedIn("tok-0", Date.now() + 60_000)
  const { hooks } = await plugin()
  const e = await hooks.auth.refresh(structuredClone(auth)).catch((e) => e)
  expect(e).toBeInstanceOf(Error)
  expect(e.signIn).toBe("expired")
})

test("a token the CLI couldn't renew past its end is a plain failure, tried again later", async () => {
  process.env.FAKE_GROK = "fail"
  const auth = signedIn("tok-0", Date.now() - 1000)
  const { hooks } = await plugin()
  const e = await hooks.auth.refresh(structuredClone(auth)).catch((e) => e)
  expect(e).toBeInstanceOf(Error)
  expect(e.signIn).toBeUndefined()
  expect(runs()).toBe(1)
})

test("nothing to renew with: no home, or no CLI", async () => {
  const { hooks } = await plugin()
  expect(await hooks.auth.refresh({ type: "oauth", access: "tok-0", expires: Date.now() + 60_000 })).toBeUndefined()
  expect(await hooks.auth.refresh({ type: "api", key: "k" })).toBeUndefined()
  const auth = signedIn("tok-0", Date.now() + 60_000)
  process.env.GROK_BIN_DIR = join(root, "none")
  process.env.GROK_HOME = join(root, "none")
  process.env.PATH = ""
  expect(await hooks.auth.refresh(structuredClone(auth))).toBeUndefined()
})
