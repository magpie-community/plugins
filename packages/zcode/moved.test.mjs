// ZCode 3.14 can move its data to another folder (数据存储路径): it copies
// ~/.zcode/v2 there, all but setting.json, records the folder in the home
// folder's setting.json as dataBaseDir, and from then on reads
// credentials.json from the new folder. "ZCode app's sign-in" follows it, as
// magpie's built-in does (internal/appdir ZCodeDataIn), and still takes the
// team plan from the home folder's setting.json, where ZCode keeps it.
import { test, expect, beforeAll } from "bun:test"
import { homedir, tmpdir } from "node:os"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createCipheriv, createHash, randomBytes } from "node:crypto"
import { join } from "node:path"

let _internal
beforeAll(async () => {
  if (![tmpdir(), realpathSync(tmpdir())].some((t) => homedir().startsWith(t))) throw new Error("run with HOME=$(mktemp -d) bun test")
  process.env.ZCODE_CREDENTIAL_SECRET = "test-seed"
  ;({ _internal } = await import("./index.mjs"))
})

function enc(text) {
  const key = createHash("sha256").update("test-seed").digest()
  const iv = randomBytes(12)
  const c = createCipheriv("aes-256-gcm", key, iv)
  const data = Buffer.concat([c.update(text, "utf8"), c.final()])
  return "enc:v1:" + [iv, c.getAuthTag(), data].map((b) => b.toString("base64url")).join(".")
}
const writeStore = (v2, store) => {
  mkdirSync(v2, { recursive: true })
  writeFileSync(join(v2, "credentials.json"), JSON.stringify(Object.fromEntries(Object.entries(store).map(([k, v]) => [k, enc(v)]))))
}
const KEY = "account-provider:coding-plan:account:zai-individual-coding-plan:account:u1:api-key"

test("ZCode's sign-in is read from the folder its data was moved to", () => {
  const homeV2 = join(homedir(), ".zcode", "v2")
  const moved = mkdtempSync(join(tmpdir(), "zcode-moved-"))
  const movedV2 = join(moved, ".zcode", "v2")
  const setting = (s) => writeFileSync(join(homeV2, "setting.json"), JSON.stringify(s))
  try {
    // what ZCode leaves after the move: the old copy at home, the live one moved
    writeStore(homeV2, { [KEY]: "old.stale", zcodejwttoken: "j-old" })
    writeStore(movedV2, { [KEY]: "new.live", zcodejwttoken: "j-new", "oauth:zai:access_token": "tok-team" })
    setting({ locale: "zh-CN", dataBaseDir: moved })
    expect(_internal.ownSignIn()).toMatchObject({ key: "new.live", jwt: "j-new" })

    // the team plan ZCode switched to stays in the home folder's setting.json
    setting({ dataBaseDir: "  " + moved + " ", providerFamilyConnectionSelections: { zai: { kind: "team-coding-plan", organizationId: "org1", projectId: "p1" } } })
    expect(_internal.ownSignIn()).toMatchObject({ token: "tok-team", org: "org1", project: "p1", jwt: "j-new" })

    // an empty, blank, relative or non-string dataBaseDir is no move
    for (const d of ["", "  ", "ZCodeData", 7, null]) {
      setting({ dataBaseDir: d })
      expect(_internal.ownSignIn()).toMatchObject({ key: "old.stale", jwt: "j-old" })
    }
  } finally {
    rmSync(moved, { recursive: true, force: true })
    rmSync(join(homeV2, "setting.json"), { force: true })
  }
})
