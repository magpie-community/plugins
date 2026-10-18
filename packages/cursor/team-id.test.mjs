// Team ID (x-cursor-team-id header) is sent when cli-config.json has
// authInfo.activeTeamId for the account that signed in (token's sub matches
// authInfo.authId). Without it Cursor uses the token's default team, which
// may have on-demand spend off ("Team budget limit reached"). Tests run in
// a sandbox HOME so the real ~/.cursor/cli-config.json is not read.
import "./nonet.mjs"
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CursorAuthPlugin, _internal } from "./index.mjs"

const real = globalThis.fetch
const realEnv = { ...process.env }
afterEach(() => {
  globalThis.fetch = real
  process.env = { ...realEnv }
  _internal.resetTeam()
})

// jwt builds a token with the given subject and expiry
const jwt = (sub, exp) => {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url")
  const payload = Buffer.from(JSON.stringify({ sub, exp })).toString("base64url")
  return `${header}.${payload}.sig`
}

const tok1 = jwt("auth0|user_abc", Math.floor(Date.now() / 1000) + 3600)
const tok2 = jwt("auth0|user_xyz", Math.floor(Date.now() / 1000) + 3600)
const auth1 = { type: "oauth", access: tok1, refresh: "", expires: 0, accountId: "a@b.c" }
const auth2 = { type: "oauth", access: tok2, refresh: "", expires: 0, accountId: "x@y.z" }

const PERIOD = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage"
const PLAN = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo"

async function run(a, configDir, configContent) {
  if (configContent !== undefined) {
    await writeFile(join(configDir, "cli-config.json"), JSON.stringify(configContent))
  }
  process.env.CURSOR_CONFIG_DIR = configDir
  _internal.expireTeam() // force re-read of cli-config.json
  const seen = []
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), method: init.method, headers: init.headers, body: init.body })
    if (String(url) === PLAN) return Response.json({ planInfo: { planName: "Pro" } })
    return Response.json({ billingCycleEnd: "1792833042000", planUsage: { autoPercentUsed: 10, apiPercentUsed: 20, totalPercentUsed: 15 } })
  }
  const hooks = await CursorAuthPlugin()
  await hooks.auth.usage(async () => a, { models: {} })
  return seen
}

test("activeTeamId sent in header and body when authId matches token", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cursor-team-"))
  try {
    const config = { authInfo: { authId: "auth0|user_abc", activeTeamId: 42 } }
    const seen = await run(auth1, dir, config)
    const period = seen.find((r) => r.url === PERIOD)
    expect(period.headers["x-cursor-team-id"]).toBe("42")
    expect(JSON.parse(period.body)).toEqual({ teamId: 42 })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("no team header when authId does not match token", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cursor-team-"))
  try {
    const config = { authInfo: { authId: "auth0|user_abc", activeTeamId: 42 } }
    const seen = await run(auth2, dir, config) // auth2 has different sub
    const period = seen.find((r) => r.url === PERIOD)
    expect(period.headers["x-cursor-team-id"]).toBeUndefined()
    expect(JSON.parse(period.body)).toEqual({})
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("no team header when authId is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cursor-team-"))
  try {
    const config = { authInfo: { activeTeamId: 42 } } // no authId
    const seen = await run(auth1, dir, config)
    const period = seen.find((r) => r.url === PERIOD)
    expect(period.headers["x-cursor-team-id"]).toBeUndefined()
    expect(JSON.parse(period.body)).toEqual({})
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("no team header when only teamId exists (no activeTeamId)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cursor-team-"))
  try {
    const config = { authInfo: { authId: "auth0|user_abc", teamId: 99 } }
    const seen = await run(auth1, dir, config)
    const period = seen.find((r) => r.url === PERIOD)
    expect(period.headers["x-cursor-team-id"]).toBeUndefined()
    expect(JSON.parse(period.body)).toEqual({})
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("no team header when activeTeamId is not a safe integer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cursor-team-"))
  try {
    const config = { authInfo: { authId: "auth0|user_abc", activeTeamId: "42" } }
    const seen = await run(auth1, dir, config)
    const period = seen.find((r) => r.url === PERIOD)
    expect(period.headers["x-cursor-team-id"]).toBeUndefined()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("no team header when activeTeamId is zero or negative", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cursor-team-"))
  try {
    const config = { authInfo: { authId: "auth0|user_abc", activeTeamId: 0 } }
    const seen = await run(auth1, dir, config)
    const period = seen.find((r) => r.url === PERIOD)
    expect(period.headers["x-cursor-team-id"]).toBeUndefined()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("no team header when cli-config.json does not exist", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cursor-team-"))
  try {
    const seen = await run(auth1, dir, undefined) // no file written
    const period = seen.find((r) => r.url === PERIOD)
    expect(period.headers["x-cursor-team-id"]).toBeUndefined()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("a half-written cli-config.json keeps the last team; a deleted one clears it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cursor-team-"))
  try {
    const file = join(dir, "cli-config.json")
    const header = async () => (await run(auth1, dir, undefined)).find((r) => r.url === PERIOD).headers["x-cursor-team-id"]
    await writeFile(file, JSON.stringify({ authInfo: { authId: "auth0|user_abc", activeTeamId: 42 } }))
    expect(await header()).toBe("42")
    await writeFile(file, '{"authInfo":{"authId":"auth0|us') // cursor-agent mid-write
    expect(await header()).toBe("42")
    await rm(file)
    expect(await header()).toBeUndefined()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
