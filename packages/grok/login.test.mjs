// A `grok login` that prints no link says why (𝕏 on Discord): the sign-in
// said only "grok login gave no link to open", where the CLI had said it
// couldn't reach x.ai.
//
// The fake CLI is /bin/sh under grok's name, not a script written here: on
// macOS the first run of a file just written waits for the system's scan
// of it, which took 4-15s on a busy machine and timed these tests out
// (#65). `grok login --device-auth` is then `sh login --device-auth`, and
// sh reads the script `login` in the folder the plugin runs it in, the
// home folder: a plain file, read and never scanned.
import { noRealGrok } from "./nocli.mjs"
import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { GrokAuthPlugin } from "./index.mjs"

noRealGrok()

const dir = mkdtempSync(join(tmpdir(), "grok-login-"))
const script = join(homedir(), "login")
beforeAll(() => {
  // the script goes in the home folder, so only a home made for the test
  if (![tmpdir(), realpathSync(tmpdir())].some((t) => homedir().startsWith(t))) throw new Error("run with HOME=$(mktemp -d) bun test")
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(script, { force: true })
})

async function signIn(body) {
  const bin = mkdtempSync(join(dir, "bin-"))
  symlinkSync("/bin/sh", join(bin, "grok"))
  symlinkSync("/bin/sh", join(bin, "grok.exe")) // as a test that says it is Windows looks for it
  writeFileSync(script, `${body}\n`)
  const env = { GROK_BIN_DIR: process.env.GROK_BIN_DIR, GROK_HOME: process.env.GROK_HOME }
  process.env.GROK_BIN_DIR = bin
  process.env.GROK_HOME = mkdtempSync(join(dir, "home-"))
  try {
    const hooks = await GrokAuthPlugin({ client: { auth: { set: async () => {} } } })
    return await hooks.auth.methods[0].authorize()
  } finally {
    for (const [k, v] of Object.entries(env)) v === undefined ? delete process.env[k] : (process.env[k] = v)
  }
}

test.skipIf(process.platform === "win32")("a login that fails says what the CLI said", async () => {
  await expect(signIn(`printf 'Starting sign-in\\n\\033[31merror: request to auth.x.ai timed out\\033[0m\\n' >&2; exit 1`)).rejects.toThrow(
    "grok login gave no link to open: error: request to auth.x.ai timed out",
  )
})

// as grok 1.0.46 says a proxy it can't get through: the URL in it is the
// endpoint, not a page to open
test.skipIf(process.platform === "win32")("the endpoint a failed login names is no link", async () => {
  const said = "Error: error sending request for url (https://auth.x.ai/oauth2/device/code): client error (Connect): tunnel error: failed to create underlying connection: tcp connect error: Connection refused (os error 61)"
  await expect(signIn(`echo '${said}' >&2; exit 1`)).rejects.toThrow(`grok login gave no link to open: ${said}`)
})

test.skipIf(process.platform === "win32")("a login that says nothing asks whether x.ai is reachable", async () => {
  await expect(signIn("exit 1")).rejects.toThrow("can this machine reach auth.x.ai?")
})

test.skipIf(process.platform === "win32")("a login's link is still handed on", async () => {
  const a = await signIn(`echo 'To sign in, open this URL in your browser:'; echo '  https://accounts.x.ai/oauth2/device?user_code=AB12-CD34'; exit 1`)
  expect(a.url).toBe("https://accounts.x.ai/oauth2/device?user_code=AB12-CD34")
})

// `grok login --device-auth` opens its page itself where it can, and the
// sign-in's opener opened it too: two pages every time (andyfmyth on X).
// On macOS and Windows, where nothing turns Grok Build's off, the sign-in
// says the page is open already; elsewhere Grok Build is given a $BROWSER
// that opens nothing, and the page is the opener's to open.
async function signInOn(platform, body) {
  const was = Object.getOwnPropertyDescriptor(process, "platform")
  const browser = process.env.BROWSER
  delete process.env.BROWSER
  Object.defineProperty(process, "platform", { ...was, value: platform })
  try {
    return await signIn(body)
  } finally {
    Object.defineProperty(process, "platform", was)
    if (browser !== undefined) process.env.BROWSER = browser
  }
}

// the link carries the $BROWSER Grok Build was given
const saysBrowser = `echo "https://accounts.x.ai/oauth2/device?user_code=AB12-CD34&browser=$BROWSER"; exit 1`

test.skipIf(process.platform === "win32")("on macOS and Windows the page Grok Build opened isn't opened again", async () => {
  for (const os of ["darwin", "win32"]) {
    const a = await signInOn(os, saysBrowser)
    expect(a.opened).toBe(true)
    expect(a.url).toBe("https://accounts.x.ai/oauth2/device?user_code=AB12-CD34&browser=")
  }
})

test.skipIf(process.platform === "win32")("elsewhere Grok Build opens nothing and the page is the opener's", async () => {
  for (const os of ["linux", "freebsd"]) {
    const a = await signInOn(os, saysBrowser)
    expect(a.opened).toBe(false)
    expect(a.url).toBe("https://accounts.x.ai/oauth2/device?user_code=AB12-CD34&browser=true")
  }
})

// A login that ends signed in is kept, or says where it looked and what it
// found (llllleo9 on 𝕏: "grok login finished without an account"). Run in a
// sandbox against a stand-in auth.x.ai, grok 1.0.62 writes "email": null
// when the sign-in's id_token has no email (an xAI account signed in
// through X), and keeps its sign-in at GROK_AUTH_PATH when that is set.
const LINK = "https://accounts.x.ai/oauth2/device?user_code=AB12-CD34"
const later = new Date(Date.now() + 24 * 3600_000).toISOString()
const scope = "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828"
const jwt = (claims) => ["e30", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join(".")
const theirs = { [scope]: { key: "cli-tok", email: "cli@x.ai", user_id: "u-cli", expires_at: later } }

// finish runs a login that prints the link, writes what (if anything) where
// grok 1.0.62 does, says it signed in and exits 0. With cli, the CLI's own
// home already holds that sign-in, so the plugin signs in beside it.
async function finish({ what, cli, env = {} }) {
  const bin = mkdtempSync(join(dir, "bin-"))
  symlinkSync("/bin/sh", join(bin, "grok"))
  const write = what ? `printf '%s' '${JSON.stringify(what)}' > "\${GROK_AUTH_PATH:-$GROK_HOME/auth.json}"` : ":"
  writeFileSync(script, `echo 'To sign in, open this URL in your browser:'\necho '  ${LINK}'\n${write}\necho '✓ Signed in'\n`)
  const cliHome = mkdtempSync(join(dir, "home-"))
  if (cli) writeFileSync(join(cliHome, "auth.json"), JSON.stringify(cli))
  const set = { GROK_BIN_DIR: bin, GROK_HOME: cliHome, XDG_CONFIG_HOME: mkdtempSync(join(dir, "cfg-")), ...env }
  const was = Object.fromEntries(Object.keys(set).map((k) => [k, process.env[k]]))
  Object.assign(process.env, set)
  try {
    const hooks = await GrokAuthPlugin({ client: { auth: { set: async () => {} } } })
    const a = await hooks.auth.methods[0].authorize()
    expect(a.url).toBe(LINK)
    return { r: await a.callback(), cliHome }
  } finally {
    for (const [k, v] of Object.entries(was)) v === undefined ? delete process.env[k] : (process.env[k] = v)
  }
}

test.skipIf(process.platform === "win32")("a sign-in beside the CLI's own with no email is kept by its user id", async () => {
  const { r } = await finish({ cli: theirs, what: { [scope]: { key: "tok", email: null, user_id: "u-1", expires_at: later } } })
  expect(r.type).toBe("success")
  expect(r.accountId).toBe("u-1")
  expect(r.access).toBe("tok")
})

test.skipIf(process.platform === "win32")("with no user id either, it is kept by the token's subject", async () => {
  const key = jwt({ sub: "u-2", iss: "https://auth.x.ai" })
  const { r } = await finish({ cli: theirs, what: { [scope]: { key, email: null, user_id: "", expires_at: later } } })
  expect(r.type).toBe("success")
  expect(r.accountId).toBe("u-2")
})

test.skipIf(process.platform === "win32")("one that names no account at all says so, and where", async () => {
  const { r, cliHome } = await finish({ cli: theirs, what: { [scope]: { key: "tok", email: null, expires_at: later } } })
  expect(r.type).toBe("failed")
  expect(r.error).toContain('grok login finished (it said "✓ Signed in")')
  expect(r.error).toContain("names no account")
  expect(r.error).toContain(cliHome)
})

test.skipIf(process.platform === "win32")("a login that leaves nothing says where it looked", async () => {
  const { r, cliHome } = await finish({})
  expect(r.type).toBe("failed")
  expect(r.error).toContain(`left no sign-in where this plugin reads it: there is no ${join(cliHome, "auth.json")}`)
  expect(r.error).toContain("Use Grok Build's current sign-in")
})

test.skipIf(process.platform === "win32")("one that leaves a file with no token says what it holds", async () => {
  const { r } = await finish({ what: { [scope]: { email: "g@x.ai" } } })
  expect(r.type).toBe("failed")
  expect(r.error).toContain(`has ${scope}, none with a token`)
})

// GROK_AUTH_PATH moves the CLI's sign-in out of its home: the login runs
// without it, so the sign-in lands where the plugin reads it
test.skipIf(process.platform === "win32")("GROK_AUTH_PATH doesn't take the sign-in elsewhere", async () => {
  const away = join(mkdtempSync(join(dir, "away-")), "auth.json")
  const { r, cliHome } = await finish({ what: { [scope]: { key: "tok", email: "g@x.ai", expires_at: later } }, env: { GROK_AUTH_PATH: away } })
  expect(r.type).toBe("success")
  expect(r.accountId).toBe("g@x.ai")
  expect(r.refresh).toBe(cliHome)
})
