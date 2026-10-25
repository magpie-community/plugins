// Team selection lets an account in several teams name which one a request
// is billed to. Without it Cursor bills the default team, whose budget may
// be spent while another team's is not.
import "./nonet.mjs"
import { expect, test, beforeEach, afterEach } from "bun:test"
import { CursorAuthPlugin, _internal } from "./index.mjs"

const { teamOf, teamHeader, keepTeam, failure } = _internal

// reset env and team state between tests
const envWas = process.env.CURSOR_TEAM_ID
beforeEach(() => {
  delete process.env.CURSOR_TEAM_ID
})
afterEach(() => {
  if (envWas !== undefined) process.env.CURSOR_TEAM_ID = envWas
  else delete process.env.CURSOR_TEAM_ID
})

test("teamOf is empty when nothing names a team", () => {
  expect(teamOf("tok-none")).toBe("")
})

test("teamOf reads CURSOR_TEAM_ID when set", () => {
  process.env.CURSOR_TEAM_ID = "12345"
  expect(teamOf("tok-env-a")).toBe("12345")
  expect(teamOf("tok-env-b")).toBe("12345") // applies to every token
})

test("teamOf ignores CURSOR_TEAM_ID when it is not a number", () => {
  process.env.CURSOR_TEAM_ID = "not-a-number"
  expect(teamOf("tok-badenv")).toBe("")
  process.env.CURSOR_TEAM_ID = ""
  expect(teamOf("tok-badenv")).toBe("")
})

test("keepTeam remembers the team from a sign-in's teamId", () => {
  const tok = "tok-keep"
  keepTeam(tok, { teamId: 33044 })
  expect(teamOf(tok)).toBe("33044")
})

test("keepTeam forgets the team when teamId is absent", () => {
  const tok = "tok-forget"
  keepTeam(tok, { teamId: 33044 })
  expect(teamOf(tok)).toBe("33044")
  keepTeam(tok, {}) // sign-in with no teamId
  expect(teamOf(tok)).toBe("")
})

test("keepTeam ignores teamId when it is not a number", () => {
  const tok = "tok-badid"
  keepTeam(tok, { teamId: "not-a-number" })
  expect(teamOf(tok)).toBe("")
})

test("CURSOR_TEAM_ID takes precedence over keepTeam", () => {
  const tok = "tok-prec"
  keepTeam(tok, { teamId: 11111 })
  process.env.CURSOR_TEAM_ID = "22222"
  expect(teamOf(tok)).toBe("22222")
})

test("teamHeader is empty when no team is chosen", () => {
  expect(teamHeader("tok-hdr-none")).toEqual({})
})

test("teamHeader names the team when chosen", () => {
  const tok = "tok-hdr"
  keepTeam(tok, { teamId: 99999 })
  expect(teamHeader(tok)).toEqual({ "x-cursor-team-id": "99999" })
})

test("teamHeader names the env team when set", () => {
  process.env.CURSOR_TEAM_ID = "88888"
  expect(teamHeader("tok-hdr-env")).toEqual({ "x-cursor-team-id": "88888" })
})

test("each token's team is separate", () => {
  keepTeam("tok-a", { teamId: 11111 })
  keepTeam("tok-b", { teamId: 22222 })
  expect(teamOf("tok-a")).toBe("11111")
  expect(teamOf("tok-b")).toBe("22222")
  expect(teamOf("tok-c")).toBe("")
})

test("a team budget refusal says how to bill another team", () => {
  const msg = "Team budget limit reached: Your team has reached the spending limit set by your organization. Please contact your organization admin to increase the budget."
  const f = failure(200, JSON.stringify({ error: { code: "resource_exhausted", message: msg } }))
  expect(f.status).toBe(429)
  expect(f.message).toContain("usage limit reached")
  expect(f.message).toContain("Team budget limit reached")
  expect(f.message).toContain("bill another team you are in")
  expect(f.message).toContain("cursor-agent team list")
})

test("other usage-limit refusals stay as they were", () => {
  const msg = "You've hit your usage limit"
  const f = failure(200, JSON.stringify({ error: { code: "resource_exhausted", message: msg } }))
  expect(f.status).toBe(429)
  expect(f.message).toBe("usage limit reached: You've hit your usage limit")
})

test("a rate limit stays as it was", () => {
  const f = failure(429, JSON.stringify({ error: { code: "resource_exhausted", message: "slow down" } }))
  expect(f.status).toBe(429)
  expect(f.message).toBe("usage limit reached: slow down")
})
