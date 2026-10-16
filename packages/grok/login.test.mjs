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
import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { GrokAuthPlugin } from "./index.mjs"

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
