// Imported first by every test here: nothing a test runs reaches Trae.
// fetch and HTTP/2 go to this machine (a test's fake) or fail, so a test
// left without its fake, or work still going after it, can't send a token
// to trae.cn, mchost.guru or any other of Trae's hosts.
import http2 from "node:http2"

const local = (u) => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/.test(u)
const realFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  if (!local(u)) throw new Error("a test asked " + u + " with no fake in place")
  return realFetch(input, init)
}
const connect = http2.connect
http2.connect = (origin, ...rest) => {
  if (!local(String(origin))) throw new Error("a test connected to " + origin)
  return connect(origin, ...rest)
}
// nor does a test write this machine's session salt (saltOf): the plugin's
// salt goes in a folder of the test run's own
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
process.env.MAGPIE_TRAE_SESSION_SALT = join(mkdtempSync(join(tmpdir(), "trae-test-salt-")), "trae-session-salt")
