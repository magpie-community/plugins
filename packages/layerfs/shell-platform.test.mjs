import assert from "node:assert/strict"
import { test } from "node:test"
import { shellFor } from "./layerfs.mjs"

// A command runs through the shell each platform has (#1325): /bin/sh with
// -c where there is one, cmd.exe with /d /s /c where there is not, and each
// with the temp directory that platform's programs look at.
test("shellFor picks the shell and the temp directory of the platform", () => {
  const posix = shellFor("linux", "echo hi", "/w")
  assert.equal(posix.file, "/bin/sh")
  assert.deepEqual(posix.args, ["-c", "echo hi"])
  assert.equal(posix.env.TMPDIR, "/w/.tmp")
  assert.equal(posix.env.XDG_CACHE_HOME, "/w/.cache")

  const win = shellFor("win32", "echo hi", "C:/w")
  assert.match(win.file, /cmd(\.exe)?$/i, win.file)
  assert.deepEqual(win.args, ["/d", "/s", "/c", "echo hi"])
  assert.equal(win.env.TEMP, "C:/w/.tmp")
  assert.equal(win.env.TMP, "C:/w/.tmp")
  // the cache variable is POSIX-only: Windows gets TEMP and TMP, not this one
  assert.equal(win.env.XDG_CACHE_HOME, process.env.XDG_CACHE_HOME)
})

test("shellFor keeps the command as one argument, so quoting survives", () => {
  const cmd = 'echo "a b" && dir c:\\temp'
  for (const platform of ["linux", "win32"]) {
    const sh = shellFor(platform, cmd, "/w")
    assert.equal(sh.args[sh.args.length - 1], cmd)
  }
})
