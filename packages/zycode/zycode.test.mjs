import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { KEY_ENV, applyModel, pathsFor, startBridge, sync, wanted } from "./bridge.mjs"
import { agent, connect } from "./zycode.agent.js"

const gateway = { url: "http://127.0.0.1:3425", v1: "http://127.0.0.1:3425/v1", key: "magpie-zycode" }

// What magpie writes to local.env for this agent: the model, then connect's keys
const envText = (model, extra = "") =>
  `${extra}MAGPIE_ZYCODE_MODEL=${model}\nMAGPIE_ZYCODE_API_KEY=magpie-zycode\n# magpie: points at magpie's local gateway\nMAGPIE_ZYCODE_BASE_URL=${gateway.v1}\n`

// A real-looking agent.toml: comments, unknown keys, a multi-line string
// that holds a line that looks like a header, and tables after [model].
const user = `# my zycode
permission = "ask" # ask | auto | always-approve
thinking_level = "off"
future_key = { nested = [1, 2, 3] }

[model]
provider = "deepseek"   # my own provider
id = "deepseek-ai/DeepSeek-V4-Flash"
base_url = "https://api.example.com/v1"
api_key_env = "REAL_LLM_API_KEY"
reasoning = true
unknown_model_key = "keep"

[[models]]
id = "deepseek-ai/DeepSeek-V4-Pro"

[prompt]
append_system_prompt = """
[model]
id = "not a header"
"""

[skills]
paths = [
  "~/.pi-python/skills",
  ".pi/skills",
]
`

let root
let p
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-zycode-"))
  p = pathsFor(root)
  fs.mkdirSync(path.dirname(p.toml), { recursive: true })
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

const put = (file, text) => fs.writeFileSync(file, text)
const get = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null)
const pick = (model, extra) => put(p.env, envText(model, extra))
const off = (extra = "") => put(p.env, extra)

test("names zycode and where it keeps its model", () => {
  expect(agent).toMatchObject({ id: "zycode", name: "zycode", config: "~/.pi-python/local.env", model: "MAGPIE_ZYCODE_MODEL" })
  expect(agent.dir).toBe("~/.pi-python")
})

test("connect gives zycode the gateway and its own key", () => {
  const out = connect({ gateway, model: { id: "deepseek/pro" }, models: [], agent: { id: "zycode", config: "/home/u/.pi-python/local.env" } })
  expect(out).toEqual({ MAGPIE_ZYCODE_API_KEY: "magpie-zycode", MAGPIE_ZYCODE_BASE_URL: "http://127.0.0.1:3425/v1" })
  expect(Object.keys(out)).toContain(KEY_ENV)
})

test("declares a plain agent package with a host part and no dependencies", () => {
  const pkg = JSON.parse(fs.readFileSync(new URL("./package.json", import.meta.url), "utf8"))
  expect(pkg.name).toBe("@magpie-community/agent-zycode")
  expect(pkg.magpie.agent).toBe("./zycode.agent.js")
  expect(pkg.main).toBe("./index.mjs")
  expect(pkg.dependencies).toBeUndefined()
  expect(pkg.scripts).toBeUndefined()
  for (const f of ["zycode.agent.js", "index.mjs", "bridge.mjs", "README.md"]) expect(pkg.files).toContain(f)
})

test("reads what magpie wrote, as zycode reads local.env", () => {
  expect(wanted(envText("deepseek/pro"))).toEqual({ model: "deepseek/pro", url: gateway.v1 })
  expect(wanted(`export MAGPIE_ZYCODE_MODEL="a/b"\nMAGPIE_ZYCODE_API_KEY='k'\nMAGPIE_ZYCODE_BASE_URL=http://localhost:3425/v1\n`)).toEqual({ model: "a/b", url: "http://localhost:3425/v1" })
  expect(wanted("")).toBeNull()
  expect(wanted(null)).toBeNull()
  expect(wanted("MAGPIE_ZYCODE_MODEL=a/b\nMAGPIE_ZYCODE_API_KEY=k\n")).toBeNull()
  expect(() => wanted("MAGPIE_ZYCODE_MODEL=a\nMAGPIE_ZYCODE_API_KEY=k\nMAGPIE_ZYCODE_BASE_URL=ftp://127.0.0.1:3425/v1\n")).toThrow()
  expect(() => wanted("MAGPIE_ZYCODE_MODEL=a\nMAGPIE_ZYCODE_API_KEY=k\nMAGPIE_ZYCODE_BASE_URL=not a url\n")).toThrow()
  expect(() => wanted("MAGPIE_ZYCODE_MODEL=a\nMAGPIE_ZYCODE_API_KEY=k\nMAGPIE_ZYCODE_BASE_URL=http://user:pass@127.0.0.1:3425/v1\n")).toThrow()
})

test("connect: a home with no agent.toml gets a [model] table, and disconnect removes the file", () => {
  pick("deepseek/pro")
  expect(sync(p)).toBe("connected")
  expect(get(p.toml)).toBe(
    `[model]\nprovider = "openai"\nid = "deepseek/pro"\nbase_url = "http://127.0.0.1:3425/v1"\napi_key_env = "MAGPIE_ZYCODE_API_KEY"\n`,
  )
  off()
  expect(sync(p)).toBe("disconnected")
  expect(get(p.toml)).toBeNull()
  expect(get(p.state)).toBeNull()
})

test("connect: replaces the four keys of [model] and keeps every other line", () => {
  put(p.toml, user)
  pick("deepseek/pro")
  sync(p)
  const out = get(p.toml)
  expect(out).toBe(
    user
      .replace(/^provider = .*$/m, 'provider = "openai"')
      .replace(/^id = "deepseek-ai\/DeepSeek-V4-Flash"$/m, 'id = "deepseek/pro"')
      .replace(/^base_url = .*$/m, 'base_url = "http://127.0.0.1:3425/v1"')
      .replace(/^api_key_env = .*$/m, 'api_key_env = "MAGPIE_ZYCODE_API_KEY"'),
  )
  // the unknown key, the comments, [[models]] and the string that holds "[model]" are all still there
  for (const kept of ["# my zycode", "future_key = { nested = [1, 2, 3] }", 'unknown_model_key = "keep"', "reasoning = true", '[[models]]', '[model]\nid = "not a header"']) {
    expect(out).toContain(kept)
  }
})

test("switching the model changes only id, and disconnect still restores the first file", () => {
  put(p.toml, user)
  pick("deepseek/pro")
  sync(p)
  const first = get(p.toml)
  pick("codex/gpt-5.5")
  sync(p)
  const second = get(p.toml)
  expect(second).toBe(first.replace('id = "deepseek/pro"', 'id = "codex/gpt-5.5"'))
  pick("deepseek/pro")
  sync(p)
  expect(get(p.toml)).toBe(first)
  off()
  sync(p)
  expect(get(p.toml)).toBe(user)
})

test("disconnect restores the original file byte for byte, CRLF and a missing final newline included", () => {
  const crlf = user.replaceAll("\n", "\r\n").replace(/\r\n$/, "")
  put(p.toml, crlf)
  pick("a/b")
  sync(p)
  expect(get(p.toml)).not.toBe(crlf)
  expect(get(p.toml)).toContain('id = "a/b"\r\n')
  off()
  sync(p)
  expect(Buffer.from(get(p.toml))).toEqual(Buffer.from(crlf))
})

test("a file with no [model] table gets one at the end, and loses it again", () => {
  const plain = '# only a mode\npermission = "auto"\n\n[[models]]\nid = "x"'
  put(p.toml, plain)
  pick("a/b")
  sync(p)
  const out = get(p.toml)
  expect(out.startsWith(plain + "\n\n[model]\n")).toBe(true)
  off()
  sync(p)
  expect(get(p.toml)).toBe(plain)
})

test("a [model] table that lacks some keys gets them, and loses them again", () => {
  const partial = '[model]\nprovider = "openai"  # same as ours\nreasoning = false\n'
  put(p.toml, partial)
  pick("a/b")
  sync(p)
  const out = get(p.toml)
  expect(out).toContain('provider = "openai"  # same as ours\n')
  expect(out).toContain('id = "a/b"')
  expect(out).toContain("reasoning = false")
  off()
  sync(p)
  expect(get(p.toml)).toBe(partial)
})

test("a second pass with nothing new writes nothing", () => {
  put(p.toml, user)
  pick("a/b")
  sync(p)
  const before = fs.statSync(p.toml).mtimeMs
  const state = get(p.state)
  sync(p)
  expect(fs.statSync(p.toml).mtimeMs).toBe(before)
  expect(get(p.state)).toBe(state)
})

test("keeps the file's own mode, and makes the state file private", () => {
  if (process.platform === "win32") return
  put(p.toml, user)
  fs.chmodSync(p.toml, 0o640)
  pick("a/b")
  sync(p)
  expect(fs.statSync(p.toml).mode & 0o777).toBe(0o640)
  expect(fs.statSync(p.state).mode & 0o777).toBe(0o600)
})

test("an edit made while connected stays when magpie is switched off", () => {
  put(p.toml, user)
  pick("a/b")
  sync(p)
  // the user edits other lines and zycode --setup rewrites nothing of ours
  put(p.toml, get(p.toml).replace('permission = "ask"', 'permission = "auto"').replace('reasoning = true', 'reasoning = false'))
  off()
  sync(p)
  expect(get(p.toml)).toBe(user.replace('permission = "ask"', 'permission = "auto"').replace("reasoning = true", "reasoning = false"))
})

test("a [model] key the user changed while connected is not put back over their change", () => {
  put(p.toml, user)
  pick("a/b")
  sync(p)
  put(p.toml, get(p.toml).replace('id = "a/b"', 'id = "mine/own"'))
  off()
  sync(p)
  const out = get(p.toml)
  expect(out).toContain('id = "mine/own"')
  expect(out).toContain('provider = "deepseek"   # my own provider')
  expect(out).toContain('api_key_env = "REAL_LLM_API_KEY"')
})

test("a table magpie made, with an edit made after it, is removed down to that edit", () => {
  pick("a/b")
  sync(p)
  put(p.toml, `permission = "ask"\n\n` + get(p.toml))
  off()
  sync(p)
  expect(get(p.toml)).toBe('permission = "ask"\n\n')
})

test("a file that is gone while connected is not brought back", () => {
  put(p.toml, user)
  pick("a/b")
  sync(p)
  fs.rmSync(p.toml)
  off()
  sync(p)
  expect(get(p.toml)).toBeNull()
  expect(get(p.state)).toBeNull()
})

test("refuses layouts it cannot edit safely and writes nothing", () => {
  const bad = [
    'model = { id = "x" }\n',
    'model.id = "x"\n',
    '[model]\nid = "x"\n[model.extra]\na = 1\n',
    '[[model]]\nid = "x"\n',
    '[model]\nid = """\nx\n"""\n',
    '[model]\nid = "x"\nid = "y"\n',
    "[model\nid = 1\n",
    '[prompt]\nappend_system_prompt = """\nnever closed\n',
  ]
  for (const text of bad) {
    put(p.toml, text)
    pick("a/b")
    expect(() => sync(p)).toThrow()
    try { sync(p) } catch (e) { expect(e.refusal).toBe(true) }
    expect(get(p.toml)).toBe(text)
    expect(get(p.state)).toBeNull()
  }
})

test("refuses a symbolic link in place of agent.toml", () => {
  if (process.platform === "win32") return
  const real = path.join(root, "dotfiles-agent.toml")
  put(real, user)
  fs.symlinkSync(real, p.toml)
  pick("a/b")
  expect(() => sync(p)).toThrow()
  expect(get(real)).toBe(user)
  expect(fs.lstatSync(p.toml).isSymbolicLink()).toBe(true)
})

test("applyModel never changes a table it already matches", () => {
  const done = applyModel(user, { model: "a/b", url: gateway.v1 })
  expect(applyModel(done, { model: "a/b", url: gateway.v1 })).toBe(done)
})

test("the host part follows local.env: connect, switch, disconnect", () => {
  put(p.toml, user)
  const stop = startBridge(p, { interval: 20, onError: () => { throw new Error("bridge paused") } })
  const settle = (ok) => new Promise((resolve, reject) => {
    const t0 = Date.now()
    const look = () => (ok() ? resolve() : Date.now() - t0 > 3000 ? reject(new Error("timeout")) : setTimeout(look, 10))
    look()
  })
  return (async () => {
    try {
      pick("a/b")
      await settle(() => get(p.toml).includes('id = "a/b"'))
      pick("c/d")
      await settle(() => get(p.toml).includes('id = "c/d"'))
      off()
      await settle(() => get(p.toml) === user && get(p.state) === null)
    } finally {
      stop()
    }
  })()
})
