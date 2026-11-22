// The sign-in runs `agy acp --login`, which only agy 1.5 and later have. An
// older agy doesn't know the subcommand (or the flag) and refuses it the way
// its argument parser refuses anything: pflag prints `unexpected argument
// "acp"` plus a line about where prompts may come from, and acp prints its
// usage. login.mjs read only the usage, so every other shape fell through to
// the generic "agy exited before printing a sign-in link: <last line>" — the
// user saw agy's parser complaint, not that their agy is too old to sign in
// from here (magpie-community/plugins#1455).
//
// These cases hold the seam that tells an agy without `acp --login` from one
// that failed for another reason. They run under bun with ../cp-hook.mjs
// preloaded (see ../agy-cli.test.mjs), so `node:child_process`'s default
// export is the writable `live` object and platform.mjs's `spawn` named
// import calls through it. Replacing `childProcess.spawn` (the default) is
// therefore what startLogin sees, with no real agy spawned.
import assert from "node:assert/strict"
import childProcess from "node:child_process"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { test } from "node:test"
import { startLogin } from "../login.mjs"

// What agy 1.2.12 writes when handed `acp --login`, captured from the real
// binary: it has neither the subcommand nor the flag.
const PFLAG_REFUSAL =
  'Error: unexpected argument "acp".\n' +
  "Prompts are read only from -p/--print, -i/--prompt-interactive, or stdin, so this argument would have been ignored.\n"

// The shape the old check already knew: acp's usage, from an agy that has the
// subcommand but not --login.
const ACP_USAGE = "Usage:\n  agy acp [flags]\n\nFlags:\n  --port int\n"

const SIGN_IN_LINK =
  "https://accounts.google.com/o/oauth2/auth?client_id=test&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&response_type=code"

// fakeAgy hands startLogin a child that runs script instead of a real agy.
async function fakeAgy(script) {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = new PassThrough()
  child.stdin.on("error", () => {})
  child.kill = () => {}
  const originalSpawn = childProcess.spawn
  childProcess.spawn = () => child
  try {
    const login = startLogin("/fake/agy")
    // Let startLogin attach its listeners before the child says anything.
    await new Promise((resolve) => setImmediate(resolve))
    await script(child)
    return await login
  } finally {
    childProcess.spawn = originalSpawn
  }
}

// say writes text to the child's stderr and lets it reach startLogin's read()
// before the close that follows.
async function say(child, text) {
  child.stderr.write(text)
  await new Promise((resolve) => setImmediate(resolve))
}

test("an agy whose parser refuses `acp` is told apart from a sign-in that failed", async () => {
  const login = await fakeAgy(async (child) => {
    await say(child, PFLAG_REFUSAL)
    child.emit("close", 2)
  })
  assert.ok(login.error, "a refused subcommand resolves with an error")
  assert.match(login.error, /can't sign in from magpie/)
  assert.doesNotMatch(login.error, /exited before printing a sign-in link/)
  // The way out: upgrade, or sign in once in a terminal. `agy update` can fail
  // on a machine that can't reach the updater, so it can't be the only route.
  assert.match(login.error, /agy update/)
  assert.match(login.error, /terminal/)
})

test("acp's usage is still read as an agy without `acp --login`", async () => {
  const login = await fakeAgy(async (child) => {
    await say(child, ACP_USAGE)
    child.emit("close", 2)
  })
  assert.match(login.error, /can't sign in from magpie/)
})

test("a child that prints the link still signs in, whatever else it says", async () => {
  const login = await fakeAgy(async (child) => {
    // A usage line ahead of the link must not turn a real sign-in away.
    await say(child, "Usage: agy acp --login\n" + SIGN_IN_LINK + "\n")
    child.emit("close", 0)
  })
  assert.equal(login.url, SIGN_IN_LINK)
  assert.equal(typeof login.finish, "function")
})

test("a failure that is not about the subcommand keeps agy's own last line", async () => {
  const login = await fakeAgy(async (child) => {
    await say(child, "Error: could not open the keyring: no secret service\n")
    child.emit("close", 1)
  })
  assert.match(login.error, /exited before printing a sign-in link/)
  assert.match(login.error, /could not open the keyring/)
  assert.doesNotMatch(login.error, /can't sign in from magpie/)
})

test("an agy that says nothing at all still reports the bare exit", async () => {
  const login = await fakeAgy(async (child) => {
    child.emit("close", 1)
  })
  assert.equal(login.error, "agy exited before printing a sign-in link")
})
