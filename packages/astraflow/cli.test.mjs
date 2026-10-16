import { afterEach, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cliAuthorize, cliDirectory, cliPrompts, importCliCredential } from "./cli.mjs"

const roots = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "astraflow-cli-fixture-"))
  roots.push(home)
  const dir = join(home, "cli")
  await mkdir(join(dir, "configs"), { recursive: true, mode: 0o700 })
  return { home, dir, runtime: { home, env: { ASTRAFLOW_HOME: dir } } }
}
const stored = (changes = {}) => ({ version: 3, api_key: "fixture-inference-key", endpoint: "https://api.modelverse.cn", region: "china", protocol: "all", kind: "astraflow-key", ...changes })
async function save(path, value) { await writeFile(path, JSON.stringify(value), { mode: 0o600 }) }

test("resolves official OS configuration directories without scanning workspaces", () => {
  expect(cliDirectory({ platform: "darwin", home: "/fixture", env: {} })).toBe("/fixture/Library/Application Support/cn.UCloud.AstraFlow")
  expect(cliDirectory({ platform: "linux", home: "/fixture", env: {} })).toBe("/fixture/.config/astraflow")
  expect(cliDirectory({ platform: "linux", home: "/fixture", env: { XDG_CONFIG_HOME: "/fixture/xdg" } })).toBe("/fixture/xdg/astraflow")
  expect(cliDirectory({ platform: "win32", home: "C:\\fixture", env: { APPDATA: "C:\\roaming" } })).toBe("C:\\roaming\\UCloud\\AstraFlow\\config")
  expect(cliPrompts.map((prompt) => prompt.key)).toEqual(["source", "configName", "path"])
})

test("copies a named OAuth config's inference key and leaves source bytes untouched", async () => {
  const { dir, runtime } = await fixture()
  const path = join(dir, "configs", "dev.json")
  await save(path, stored({ endpoint: "https://api-sg.umodelverse.ai/v1/", region: "singapore", protocol: "responses", kind: "ucloud-oauth", oauth: { access_token: "private-access", refresh_token: "private-refresh" }, project_id: "proj", key_id: "key-id" }))
  const before = await readFile(path)
  const imported = await importCliCredential({ source: "named", configName: "dev" }, runtime)
  expect(imported).toEqual({ type: "success", key: "fixture-inference-key", metadata: { region: "singapore", protocol: "responses", cliImport: true, cliSource: "named", cliConfig: "dev" }, accountId: "AstraFlow CLI / dev" })
  expect(JSON.stringify(imported)).not.toMatch(/private-access|private-refresh|project_id|key_id/)
  expect(await readFile(path)).toEqual(before)
})

test("explicit config and ASTRAFLOW_CONFIG precede environment keys, then env precedes default", async () => {
  const { dir, runtime } = await fixture()
  await save(join(dir, "configs", "dev.json"), stored())
  runtime.env.ASTRAFLOW_API_KEY = "env-astra-key"
  runtime.env.MODELVERSE_API_KEY = "env-modelverse-key"
  expect((await importCliCredential({ source: "named", configName: "dev" }, runtime)).key).toBe("fixture-inference-key")
  runtime.env.ASTRAFLOW_CONFIG = "dev"
  expect((await importCliCredential({}, runtime)).key).toBe("fixture-inference-key")
  delete runtime.env.ASTRAFLOW_CONFIG
  expect((await importCliCredential({}, runtime)).key).toBe("env-astra-key")
  delete runtime.env.ASTRAFLOW_API_KEY
  expect((await importCliCredential({ source: "environment", protocol: "gemini" }, runtime)).metadata.protocol).toBe("gemini")
  expect((await importCliCredential({}, runtime)).key).toBe("env-modelverse-key")
})

test("uses the selected default config, and supports legacy versions without migrating", async () => {
  const { dir, runtime } = await fixture()
  const legacy = join(dir, "credentials.json")
  await save(legacy, stored({ version: 1, protocol: "chat-completions" }))
  expect((await importCliCredential({}, runtime)).metadata.cliSource).toBe("legacy")
  await save(join(dir, "configs", "default.json"), stored({ api_key: "default-key", protocol: "anthropic" }))
  await save(join(dir, "config.json"), { default_config: "default" })
  const selected = await importCliCredential({}, runtime)
  expect(selected.key).toBe("default-key")
  expect(selected.metadata.protocol).toBe("anthropic")
  expect(JSON.parse(await readFile(legacy, "utf8")).version).toBe(1)
})

test("missing or malformed selected config does not silently select another key", async () => {
  const { dir, runtime } = await fixture()
  runtime.env.ASTRAFLOW_API_KEY = "available-env-key"
  await expect(importCliCredential({ source: "named", configName: "absent" }, runtime)).rejects.toThrow("not found")
  delete runtime.env.ASTRAFLOW_API_KEY
  await save(join(dir, "credentials.json"), stored())
  await save(join(dir, "config.json"), { default_config: "missing" })
  await expect(importCliCredential({}, runtime)).rejects.toThrow("not found")
  await save(join(dir, "config.json"), { default_config: "../../escape" })
  await expect(importCliCredential({}, runtime)).rejects.toThrow("default_config")
})

test("explicit file accepts every supported regional host and binds the host's region", async () => {
  const { dir, runtime } = await fixture()
  const hosts = { "api.modelverse.cn": "china", "api.umodelverse.ai": "global", "api-cn-wlcb.modelverse.cn": "wulanchabu", "api-cn-sh2.modelverse.cn": "shanghai", "api-sg.umodelverse.ai": "singapore", "api-us-ca.umodelverse.ai": "los-angeles", "api-ge-fra.umodelverse.ai": "frankfurt" }
  for (const [host, region] of Object.entries(hosts)) {
    const path = join(dir, "explicit.json")
    await save(path, stored({ endpoint: `https://${host}`, region: "china" }))
    const imported = await importCliCredential({ source: "path", path, protocol: "gemini" }, runtime)
    expect(imported.metadata.region).toBe(region)
    expect(imported.metadata.protocol).toBe("gemini")
  }
})

test("rejects custom endpoints, invalid versions, protocols, keys, regions and names", async () => {
  const { dir, runtime } = await fixture()
  const path = join(dir, "explicit.json")
  for (const changes of [{ version: 4 }, { version: "3" }, { api_key: "key\r\ninjected" }, { api_key: "" }, { api_key: 123 }, { kind: "custom" }, { kind: "unexpected" }, { protocol: "unexpected" }, { region: "unexpected" }, { endpoint: "https://evil.example/v1" }, { endpoint: "http://api.modelverse.cn" }, { endpoint: "https://key@api.modelverse.cn" }, { endpoint: "https://api.modelverse.cn/v1?key=secret" }, { endpoint: "https://api.modelverse.cn:1234" }, { endpoint: "https://api.modelverse.cn/redirect" }]) {
    await save(path, stored(changes))
    await expect(importCliCredential({ source: "path", path }, runtime)).rejects.toThrow("AstraFlow CLI:")
  }
  for (const name of ["../private", "_invalid", "name/other", "", "a".repeat(65)]) await expect(importCliCredential({ source: "named", configName: name }, runtime)).rejects.toThrow("valid CLI")
  await save(path, stored({ protocol: "responses" }))
  await expect(importCliCredential({ source: "path", path, protocol: "chat" }, runtime)).rejects.toThrow("conflicting")
})

test("rejects symlinked files and directories, unsafe permissions, and oversized input", async () => {
  const { dir, home, runtime } = await fixture()
  const path = join(dir, "credentials.json")
  await save(path, stored())
  const link = join(dir, "link.json")
  await symlink(path, link)
  await expect(importCliCredential({ source: "path", path: link }, runtime)).rejects.toThrow("symlink")
  const linked = join(home, "linked")
  await symlink(dir, linked)
  await expect(importCliCredential({ source: "path", path: join(linked, "credentials.json") }, runtime)).rejects.toThrow("symlink")
  if (process.platform !== "win32") {
    await chmod(path, 0o644)
    await expect(importCliCredential({ source: "path", path }, runtime)).rejects.toThrow("private permissions")
    expect((await readFile(path, "utf8")).includes("fixture-inference-key")).toBe(true)
    await chmod(path, 0o600)
  }
  await writeFile(path, "x".repeat(1024 * 1024 + 1))
  await expect(importCliCredential({ source: "path", path }, runtime)).rejects.toThrow("too large")
})

test("automatic callback returns redacted failures and performs no network or repair", async () => {
  const { dir, runtime } = await fixture()
  const path = join(dir, "credentials.json")
  const malformed = '{"api_key":"secret-that-must-not-leak" invalid JSON'
  await writeFile(path, malformed, { mode: 0o600 })
  const authorization = await cliAuthorize({}, runtime)
  expect(authorization.method).toBe("auto")
  expect(authorization.url).toBe("")
  const result = await authorization.callback()
  expect(result).toEqual({ type: "failed", error: "AstraFlow CLI: configuration is not valid JSON" })
  expect(await readFile(path, "utf8")).toBe(malformed)
  expect(JSON.stringify(result)).not.toContain("secret-that-must-not-leak")
})
