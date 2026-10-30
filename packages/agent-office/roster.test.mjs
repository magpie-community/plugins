import { expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadRoster, personOf, rosterPath } from "./lib/roster.mjs"
import { createAlerter } from "./lib/alerts.mjs"
import { card } from "./lib/notify.mjs"

const T0 = 1793196000000
const MIN = 60e3
const tmps = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "agent-office-roster-")); tmps.push(d); return d }
const write = (dir, name, body) => { const p = join(dir, name); writeFileSync(p, body); return p }

const good = JSON.stringify({
  group: { name: "某课题组", directions: ["方向A", "方向B"], projects: ["横向1"] },
  people: [
    { agent: "codex", name: "小明", direction: "方向A", skills: "代码编写", note: "" },
    { agent: "zcode", name: "阿智", direction: "", skills: "全能打杂" },
    { agent: "noname", direction: "缺名字的被丢掉" },
    { agent: "claude", name: "  小克  " },
    "不是对象的行也被丢掉",
  ],
})

test("a missing file is an empty roster, not an error", () => {
  const r = loadRoster(join(tmp(), "nope", "roster.json"))
  expect(r.people).toEqual({})
  expect(personOf(r, "codex")).toBeNull()
})

test("a broken file is an empty roster too", () => {
  const d = tmp()
  const r = loadRoster(write(d, "roster.json", "{ not json"))
  expect(r.people).toEqual({})
})

test("a roster is read, trimmed and keyed by agent", () => {
  const r = loadRoster(write(tmp(), "roster.json", good))
  expect(r.group.name).toBe("某课题组")
  expect(personOf(r, "codex")).toEqual({ name: "小明", direction: "方向A", skills: "代码编写", note: "" })
  expect(personOf(r, "zcode").skills).toBe("全能打杂")
  expect(personOf(r, "claude").name).toBe("小克") // trimmed
  expect(personOf(r, "noname")).toBeNull()
})

test("the roster is hot-read: a rewrite lands on the next load", () => {
  const d = tmp()
  const p = write(d, "roster.json", good)
  expect(loadRoster(p).people.codex.name).toBe("小明")
  writeFileSync(p, JSON.stringify({ people: [{ agent: "codex", name: "大明" }] }))
  expect(loadRoster(p).people.codex.name).toBe("大明")
})

test("rosterPath honours an override and the env", () => {
  const d = tmp()
  expect(rosterPath(join(d, "r.json"))).toBe(join(d, "r.json"))
  const was = process.env.MAGPIE_AGENT_OFFICE_ROSTER
  process.env.MAGPIE_AGENT_OFFICE_ROSTER = join(d, "env.json")
  try { expect(rosterPath()).toBe(join(d, "env.json")) } finally {
    if (was === undefined) delete process.env.MAGPIE_AGENT_OFFICE_ROSTER
    else process.env.MAGPIE_AGENT_OFFICE_ROSTER = was
  }
})

// ---- the cards and the states ---------------------------------------------

const files = (phase, extra = {}) => ({
  key: "codex|c1", source: "files", agent: "codex", session: "c1", cwd: "/Users/me/app", project: "app",
  title: "Fix failing test", query: "", model: "claude-opus-5",
  started: T0, updated: T0, touched: T0, phase, step: "Bash · bun test", reply: "", error: "",
  pendingSince: 0, turns: 2, ...extra,
})
const people = { codex: { name: "小明", direction: "方向A", skills: "代码编写", note: "" } }

test("a card says 小明 and the person's line when the roster knows them", () => {
  const a = createAlerter({})
  const said = a.tick([files("approval", { touched: T0 })], T0 + MIN, people)
  expect(said.length).toBe(1)
  expect(said[0].name).toBe("小明")
  expect(said[0].direction).toBe("方向A")
  const c = card(said[0], "zh", false)
  expect(c).toContain("⏸ 小明 等你批准")
  expect(c).toContain("方向A · 代码编写")
  expect(c).toContain("项目：app")
  // a tool step keeps its name only, as before
  expect(c).not.toContain("bun test")
})

test("an agent the roster doesn't know keeps its agent name", () => {
  const a = createAlerter({})
  const said = a.tick([files("approval", { key: "gemini|g1", agent: "gemini", session: "g1", touched: T0 })], T0 + MIN, people)
  expect(said[0].name).toBe("")
  expect(card(said[0], "zh", false)).toContain("Gemini 等你批准")
  expect(card(said[0], "zh", false)).not.toContain("方向A")
})

test("tick without people still works (the old shape)", () => {
  const a = createAlerter({})
  const said = a.tick([files("approval", { touched: T0 })], T0 + MIN)
  expect(said[0].name).toBe("")
})
