import "./nonet.mjs"
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin, { _internal } from "./index.mjs"
import { fakeOpenDesign, json } from "./fake.mjs"

const env = ["AMR_HOME", "OPEN_DESIGN_AMR_PROFILE", "VELA_PROFILE"]
const was = Object.fromEntries(env.map((k) => [k, process.env[k]]))
const amr = mkdtempSync(join(tmpdir(), "od-amr-"))
const restore = () => {
  for (const k of env) was[k] === undefined ? delete process.env[k] : (process.env[k] = was[k])
}
beforeEach(() => {
  restore()
  process.env.AMR_HOME = amr
})
afterAll(restore)

// what `vela login` writes (vela.ts VelaConfigFile)
const write = (profiles) => writeFileSync(join(amr, "config.json"), JSON.stringify({ profiles }))
const PROD = { controlKey: "vela_ctrl_abc", runtimeKey: "sk-amr-xyz", user: { id: "u_1", email: "a@example.com", plan: "pro" } }

const hooks = () => plugin.server({})
const methodOf = async (label) => (await hooks()).auth.methods.find((m) => m.label.includes(label))

test("vela's home: AMR_HOME with ~ is the home folder, else ~/.amr", () => {
  process.env.AMR_HOME = "~/x"
  expect(_internal.amrHome()).toBe(join(process.env.HOME, "x"))
  delete process.env.AMR_HOME
  expect(_internal.amrHome()).toBe(join(process.env.HOME, ".amr"))
})

test("the profile: OPEN_DESIGN_AMR_PROFILE, then VELA_PROFILE, prod for one vela doesn't know", () => {
  expect(_internal.profileName()).toBe("prod")
  process.env.VELA_PROFILE = "test"
  expect(_internal.profileName()).toBe("test")
  process.env.OPEN_DESIGN_AMR_PROFILE = "local"
  expect(_internal.profileName()).toBe("local")
  process.env.OPEN_DESIGN_AMR_PROFILE = "evil"
  delete process.env.VELA_PROFILE
  expect(_internal.profileName()).toBe("prod")
})

test("the CLI's sign-in takes both keys and the user from the profile", async () => {
  write({ prod: PROD, test: { runtimeKey: "sk-amr-test" } })
  const a = await (await methodOf("~/.amr")).authorize()
  expect(a.method).toBe("auto")
  const r = await a.callback()
  expect(r).toMatchObject({ type: "success", access: "sk-amr-xyz", control: "vela_ctrl_abc", refresh: "", email: "a@example.com", uid: "u_1", from: "amr", profile: "prod" })
})

test("a profile with no runtime key, or no file, is not signed in", async () => {
  write({ prod: { user: { id: "u" } } })
  let r = await (await (await methodOf("~/.amr")).authorize()).callback()
  expect(r.type).toBe("failed")
  expect(r.error).toContain("no runtime key")
  process.env.AMR_HOME = join(amr, "nowhere")
  r = await (await (await methodOf("~/.amr")).authorize()).callback()
  expect(r.type).toBe("failed")
  expect(r.error).toContain("vela login")
})

test("hosts from the config are taken only on Open Design's own domain", async () => {
  write({ prod: { ...PROD, apiUrl: "https://evil.example", linkUrl: "https://amr-link.open-design.ai" } })
  const p = await _internal.readProfile()
  expect(p.apiUrl).toBe("")
  expect(p.linkUrl).toBe("https://amr-link.open-design.ai/v1")
  expect(_internal.ownHost("http://amr-api.open-design.ai")).toBe("")
  expect(_internal.ownHost("https://open-design.ai.evil.com")).toBe("")
})

test("a sign-in from the config follows a later vela login, and keeps its keys when the file can't be read", async () => {
  write({ prod: PROD })
  const saved = await (await (await methodOf("~/.amr")).authorize()).callback()
  write({ prod: { ...PROD, runtimeKey: "sk-amr-new", controlKey: "vela_ctrl_new" } })
  let acc = await _internal.accountOf({ type: "oauth", ...saved })
  expect(acc.runtime).toBe("sk-amr-new")
  expect(acc.control).toBe("vela_ctrl_new")
  writeFileSync(join(amr, "config.json"), "{not json")
  acc = await _internal.accountOf({ type: "oauth", ...saved })
  expect(acc.runtime).toBe("sk-amr-xyz")
  expect(acc.control).toBe("vela_ctrl_abc")
})

test("a pasted key: the runtime key alone, or both in either order", () => {
  expect(_internal.keysOf("sk-amr-1")).toEqual({ runtime: "sk-amr-1", control: "" })
  expect(_internal.keysOf("vela_ctrl_2  sk-amr-1")).toEqual({ runtime: "sk-amr-1", control: "vela_ctrl_2" })
  expect(_internal.keysOf("sk-amr-1,vela_ctrl_2\n")).toEqual({ runtime: "sk-amr-1", control: "vela_ctrl_2" })
})

// ---- the device sign-in (`vela login`) ----

let fake
beforeEach(() => (fake = fakeOpenDesign()))
afterEach(() => fake.close())

test("the browser sign-in opens a device authorization and polls it with the secret", async () => {
  fake.route("POST /api/v1/cli/device-authorizations", () =>
    json({ deviceId: "d1", deviceSecret: "s1", userCode: "ABCD-EFGH", activationUrl: "https://open-design.ai/cli/activate?code=ABCD-EFGH", pollIntervalSeconds: 0.001, expiresAt: new Date(Date.now() + 60_000).toISOString() }),
  )
  let polls = 0
  fake.route("POST /api/v1/cli/device-authorizations/d1/token", () =>
    ++polls < 3 ? json({ status: "pending" }, 202) : json({ status: "approved", controlKey: "vela_ctrl_d", runtimeKey: "sk-amr-d", user: { id: "u_d", email: "d@example.com" } }),
  )
  const a = await (await methodOf("browser")).authorize()
  expect(a.url).toBe("https://open-design.ai/cli/activate?code=ABCD-EFGH")
  expect(a.instructions).toContain("ABCD-EFGH")
  const r = await a.callback()
  expect(r).toMatchObject({ type: "success", access: "sk-amr-d", control: "vela_ctrl_d", email: "d@example.com", from: "device" })
  const start = fake.seen[0]
  expect(start.json).toMatchObject({ cliVersion: "0.1.4", profile: "prod" })
  expect(typeof start.json.host).toBe("string")
  expect(start.headers.get("authorization")).toBeNull()
  expect(fake.seen.at(-1).json).toEqual({ deviceSecret: "s1" })
})

test("a denied or expired device sign-in fails, a 5xx poll is tried again", async () => {
  const d = { deviceId: "d2", deviceSecret: "s", interval: 0.001, until: Date.now() + 60_000 }
  let n = 0
  fake.route("POST /api/v1/cli/device-authorizations/d2/token", () => (++n === 1 ? json({}, 503) : json({ status: "denied" }, 400)))
  await expect(_internal.pollDevice(d)).rejects.toThrow("denied")
  expect(n).toBe(2)
  await expect(_internal.pollDevice({ ...d, deviceId: "gone" })).rejects.toThrow("start again")
  await expect(_internal.pollDevice({ ...d, until: Date.now() - 1 })).rejects.toThrow("ran out")
})
