// A key's account is named by Devin itself (GetUserStatus, asked with the
// key), not by the devin CLI: the CLI on Windows reads its own
// credentials.toml whatever APPDATA it is run with, so it named every
// browser sign-in after its own account, and "Add another Devin account"
// replaced the first account's key with the second's (#17). Its model list
// is the CLI's own account's there too, so it isn't taken for the key's.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DevinAuthPlugin, _internal } from "./index.mjs"

const real = globalThis.fetch
const env = { ...process.env }
const tmp = mkdtempSync(join(tmpdir(), "devin-identity-"))
const bin = join(tmp, "bin")
mkdirSync(bin)
// each test's CLI runs go to a log of its own: a run a test left behind
// can't land in the next test's list
let log = ""
let logs = 0

// a devin CLI signed in as a@x.dev: `auth status` reads the data folder it
// is given when FAKE_HONOURS is set, and its own (as on Windows) when not;
// `models list` lists one family, and every run is logged in FAKE_LOG
writeFileSync(
  join(bin, "devin"),
  `#!/bin/sh
echo "$*" >> "$FAKE_LOG"
if [ "$1" = auth ]; then
  if [ -n "$FAKE_HONOURS" ]; then f="$XDG_DATA_HOME/devin/credentials.toml"; else f="${tmp}/own/devin/credentials.toml"; fi
  printf 'Logged in (via Devin).\\n\\nCredentials:\\n  File:              %s\\n\\nUser:\\n  Email:             %s\\n\\nAccount:\\n  Tier:              Devin Pro\\n' "$f" "${"$"}{FAKE_EMAIL:-a@x.dev}"
  exit 0
fi
echo '{"families":[{"family_uid":"cli-only","family_label":"CLI Only","variants":[{"model_uid":"cli-only-high","label":"CLI Only High"}]}]}'
`,
)
chmodSync(join(bin, "devin"), 0o755)

// macOS checks a script the first time it is run, and a loaded machine can
// keep that check past any one test's bound (#268): the check is waited
// for here, by running the fake once, so no test's time holds it
beforeAll(async () => {
  if (process.platform === "win32") return
  const p = spawn(join(bin, "devin"), ["--version"], { env: { ...process.env, FAKE_LOG: "/dev/null" }, stdio: "ignore" })
  await new Promise((resolve, reject) => p.on("error", reject).on("close", resolve))
}, 10 * 60_000)

beforeEach(() => {
  log = join(tmp, `cli-${++logs}.log`)
  process.env.FAKE_LOG = log
  process.env.PATH = bin + ":" + env.PATH
  process.env.XDG_CACHE_HOME = join(tmp, "cache")
  delete process.env.FAKE_HONOURS
  delete process.env.FAKE_EMAIL
  asked.length = 0
})
afterEach(() => {
  globalThis.fetch = real
  for (const k of ["PATH", "XDG_CACHE_HOME", "FAKE_HONOURS", "FAKE_EMAIL", "FAKE_LOG"]) env[k] === undefined ? delete process.env[k] : (process.env[k] = env[k])
})
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const runs = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [])

// GetUserStatus for each key: b's is B's account. GetCliModelConfigs
// answers with configs (a response body) when given, and 503 when not.
const asked = []
const devin = (byKey, configs) => {
  globalThis.fetch = async (url, init) => {
    asked.push(String(url).split("/").pop())
    if (String(url) === "https://server.codeium.com/exa.api_server_pb.ApiServerService/GetCliModelConfigs") {
      return configs ? new Response(configs) : new Response("", { status: 503 })
    }
    expect(String(url)).toBe("https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus")
    return byKey(JSON.parse(init.body).metadata.apiKey)
  }
}
const statusOf = (email, tier) =>
  Response.json({ userStatus: { name: email.split("@")[0], email, teamsTier: tier, planStatus: { planInfo: { planName: "Pro" } } } })

const unix = process.platform !== "win32"
// runCLI's own bound: the fake answers at once once beforeAll has had it
// checked
const SLOW = 30_000

test.if(unix)("a second account is named as Devin names its key, not as the CLI's own account", async () => {
  devin((key) => (key === "key-b" ? statusOf("b@x.dev", "TEAMS_TIER_DEVIN_PRO") : statusOf("a@x.dev", "TEAMS_TIER_DEVIN_PRO")))
  const r = await _internal.success("key-b", "https://server.codeium.com")
  expect(r).toEqual({ type: "success", provider: "devin", key: "key-b", metadata: { email: "b@x.dev", plan: "Devin Pro" } })
  expect((await _internal.success("key-a", "https://server.codeium.com")).metadata.email).toBe("a@x.dev")
}, SLOW)

test("two organizations under the same email are named and keyed apart", async () => {
  const orgStatus = (orgName, orgId, teamId) =>
    Response.json({
      userStatus: {
        name: "sky",
        email: "m@x.dev",
        teamId,
        teamsTier: "TEAMS_TIER_DEVIN_MAX",
        planStatus: {
          planInfo: {
            planName: "Max",
            devinInfo: { orgId, accountDisplayName: orgName },
          },
        },
      },
    })
  devin((key) =>
    key === "key-org-1"
      ? orgStatus("opt", "org_1", "devin-team$account-1")
      : orgStatus("lab", "org_2", "devin-team$account-2"),
  )
  const r1 = await _internal.success("key-org-1", "https://server.codeium.com")
  const r2 = await _internal.success("key-org-2", "https://server.codeium.com")
  expect(r1).toEqual({
    type: "success",
    provider: "devin",
    key: "key-org-1",
    metadata: { email: "m@x.dev · opt", plan: "Devin Max", orgId: "org_1", teamId: "devin-team$account-1" },
  })
  expect(r2).toEqual({
    type: "success",
    provider: "devin",
    key: "key-org-2",
    metadata: { email: "m@x.dev · lab", plan: "Devin Max", orgId: "org_2", teamId: "devin-team$account-2" },
  })
})

test.if(unix)("a key Devin refuses fails the sign-in, whatever the CLI says", async () => {
  devin(() => Response.json({ code: "unauthenticated", message: "invalid api key" }, { status: 401 }))
  await expect(_internal.success("key-refused", "https://server.codeium.com")).rejects.toThrow("Devin didn't take the sign-in")
}, SLOW)

test.if(unix)("when Devin can't tell, the CLI names the account only if it read the key's own folder", async () => {
  devin(() => new Response("", { status: 503 }))
  // the CLI read its own credentials.toml: not the key's account
  expect((await _internal.success("key-c", "https://server.codeium.com")).metadata).toEqual({ email: "Devin" })
  // a CLI that honours the folder answers for the key
  process.env.FAKE_HONOURS = "1"
  process.env.FAKE_EMAIL = "c@x.dev"
  expect((await _internal.success("key-c", "https://server.codeium.com")).metadata).toEqual({ email: "c@x.dev", plan: "Devin Pro" })
}, SLOW)

test.if(unix)("a CLI that reads its own account's folder isn't asked for the key's models", async () => {
  devin(() => statusOf("b@x.dev"))
  const fams = await _internal.familiesFor("key-models-b", "https://server.codeium.com")
  expect(fams.map((f) => f.uid)).toEqual(_internal.familiesOf(_internal.SNAPSHOT).map((f) => f.uid))
  expect(runs()).toEqual(["auth status"])
  // nor asked again
  await _internal.familiesFor("key-models-b", "https://server.codeium.com")
  expect(runs()).toEqual(["auth status"])
}, SLOW)

test.if(unix)("a CLI that names another account than Devin does isn't asked for the key's models", async () => {
  process.env.FAKE_HONOURS = "1"
  devin(() => statusOf("b@x.dev"))
  const fams = await _internal.familiesFor("key-models-b2", "https://server.codeium.com")
  expect(fams.map((f) => f.uid)).not.toContain("cli-only")
  expect(runs()).toEqual(["auth status"])
}, SLOW)

test.if(unix)("a CLI that answers for the key gives its list", async () => {
  process.env.FAKE_HONOURS = "1"
  process.env.FAKE_EMAIL = "b@x.dev"
  devin(() => statusOf("B@x.dev"))
  const fams = await _internal.familiesFor("key-models-ok", "https://server.codeium.com")
  expect(fams.map((f) => f.uid)).toEqual(["cli-only"])
  expect(runs()).toEqual(["auth status", "models list --format json"])
}, SLOW)

test("readsHome and tierName", () => {
  const { readsHome, tierName } = _internal
  const home = join(tmp, "h")
  expect(readsHome(`Logged in\n  File:   ${join(home, "devin", "credentials.toml")}\n`, home)).toBe(true)
  expect(readsHome(`Logged in\n  File:   ${join(tmp, "own", "devin", "credentials.toml")}\n`, home)).toBe(false)
  expect(readsHome("Logged in\n  Email: a@x.dev\n", home)).toBe(true)
  expect(tierName("TEAMS_TIER_DEVIN_PRO")).toBe("Devin Pro")
  expect(tierName("TEAMS_TIER_DEVIN_TEAMS_V2")).toBe("Devin Teams")
  expect(tierName("TEAMS_TIER_UNSPECIFIED")).toBe("")
  expect(tierName(undefined)).toBe("")
})

// Devin's own response to GetCliModelConfigs (2026-10-14), cut to a few of
// its configs: SWE-2, Gemini 4 Argon, GLM-5.2, DeepSeek V4 Flash and
// MODEL_PRIVATE_11, which names no family
const realConfigs = readFileSync(join(import.meta.dir, "testdata", "model-configs.bin"))

test("Devin's model configs are read as the families `devin models list` prints", () => {
  const fams = _internal.parseConfigFamilies(new Uint8Array(realConfigs))
  expect(fams.map((f) => [f.uid, f.label, f.aliases])).toEqual([
    ["swe-2", "SWE-2", ["swe"]],
    ["gemini-4-argon", "Gemini 4 Argon", []],
    ["glm-5.2", "GLM-5.2", []],
    ["deepseek-v4-flash", "DeepSeek V4 Flash", []],
    ["Claude Haiku 4.5", "Claude Haiku 4.5", []],
  ])
  expect(fams[1].models).toEqual([
    { id: "gemini-4-argon-medium", name: "Gemini 4 Argon Medium", context: 1048576, output: 1000000 },
    { id: "gemini-4-argon-low", name: "Gemini 4 Argon Low", context: 1048576, output: 1000000 },
    { id: "gemini-4-argon-high", name: "Gemini 4 Argon High", context: 1048576, output: 1000000 },
  ])
  expect(fams[4].models).toEqual([{ id: "MODEL_PRIVATE_11", name: "Claude Haiku 4.5", context: 200000, output: 64000 }])
})

test.if(unix)("an account the CLI doesn't answer for gets Devin's list for its key, Gemini 4 Argon in it (plugins #115)", async () => {
  // as on Windows: the CLI reads its own credentials.toml, signed in as A
  devin(() => statusOf("b@x.dev"), realConfigs)
  const fams = await _internal.familiesFor("key-models-win", "https://server.codeium.com")
  expect(fams.map((f) => f.uid)).toContain("gemini-4-argon")
  expect(fams.map((f) => f.uid)).not.toContain("cli-only")
  expect(runs()).toEqual([])
  expect(asked).toEqual(["GetCliModelConfigs"])
}, SLOW)

test.if(unix)("a CLI that reads its own folder but is signed in as the key's account gives its list when Devin can't be asked", async () => {
  // as on Windows, the CLI signed in to the same account as the key
  process.env.FAKE_EMAIL = "b@x.dev"
  devin(() => statusOf("B@x.dev"))
  const fams = await _internal.familiesFor("key-models-win-same", "https://server.codeium.com")
  expect(fams.map((f) => f.uid)).toEqual(["cli-only"])
  expect(runs()).toEqual(["auth status", "models list --format json"])
}, SLOW)

test.if(unix)("a list the plugin is asked for names Gemini 4 Argon for an account the CLI doesn't answer for", async () => {
  devin(() => statusOf("b@x.dev"), realConfigs)
  const got = await (await DevinAuthPlugin()).provider.models({ models: {} }, { auth: { type: "api", key: "key-models-list" } })
  expect(Object.keys(got)).toContain("gemini-4-argon")
  expect(got["gemini-4-argon"].name).toBe("Gemini 4 Argon")
  expect(got["glm-5.2"].capabilities.input.image).toBe(false)
}, SLOW)
