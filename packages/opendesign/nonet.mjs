// Imported first by every test here. Nothing a test runs reaches Open
// Design: fetch goes to this machine (a test's fake) or fails, so a test
// left without its fake can't send a key to amr-api.open-design.ai or
// amr-link.open-design.ai. And no test reads or writes the real
// ~/.amr/config.json: a run whose HOME is the user's own is refused, so run
// the suite with HOME set to a scratch folder.
import { userInfo } from "node:os"
import { resolve } from "node:path"

// Bun's userInfo() reads $HOME, so the user's own home is where the OS keeps
// homes for this user name
const homes = (() => {
  let name = ""
  try {
    name = userInfo().username
  } catch {}
  name ||= process.env.USER || process.env.USERNAME || ""
  if (!name) return []
  return ["/Users/" + name, "/home/" + name, "/var/home/" + name, "C:\\Users\\" + name].map((h) => resolve(h).toLowerCase())
})()
const home = process.env.HOME ? resolve(process.env.HOME).toLowerCase() : ""
if (!home || homes.includes(home) || home === "/root")
  throw new Error("the opendesign tests run with HOME set to a scratch folder, not your own (it holds ~/.amr/config.json)")

const local = (u) => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/.test(u)
const realFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  if (!local(u)) throw new Error("a test asked " + u + " with no fake in place")
  return realFetch(input, init)
}
