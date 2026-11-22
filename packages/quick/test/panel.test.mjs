// The read-only account panel: the trimming functions against the exact
// shapes the live qbsproxy endpoints returned (captured 2026-11-22), and
// the degradation contract — a failed piece becomes {error}, never a throw.
import { expect, test } from "bun:test"
import { sessionCard, runCard, agentCard } from "../lib/panel.mjs"

test("a session's metadata trims to the panel card (live shape, 2026-11-22)", () => {
  // exactly what store/sessions/<id>?include=a2ui returned for the probe
  const raw = {
    id: "be7a0ec6-b80e-4578-89e0-0622b2c99669",
    title: "New Conversation",
    created_at: 1795307579.7058327,
    updated_at: 1795307595.288265,
    agent_mode: "smart",
    message_count: 0,
    parent_session_id: null,
    session_type: "main",
    fork_source_session_id: null,
    task_status: null,
    pinned: false,
    archived: false,
    private: false,
    incognito: true,
    deleted_at: null,
  }
  const c = sessionCard(raw)
  expect(c).toEqual({
    id: "be7a0ec6-b80e-4578-89e0-0622b2c99669",
    title: "New Conversation",
    agentMode: "smart",
    messageCount: 0,
    createdAt: new Date(1795307579.7058327 * 1000).toISOString(),
    updatedAt: new Date(1795307595.288265 * 1000).toISOString(),
    incognito: true,
    private: false,
    pinned: false,
    archived: false,
    sessionType: "main",
    parentSessionId: null,
    forkSourceSessionId: null,
    taskStatus: null,
    deletedAt: null,
  })
})

test("a run and an agent trim to their cards; junk degrades to null", () => {
  const r = runCard({ id: "run-1", session_id: "s1", status: "running", agent_mode: "smart", duration_s: 42, created_at: 1795307579 })
  expect(r.status).toBe("running")
  expect(r.durationS).toBe(42)
  expect(r.createdAt).toBe(new Date(1795307579 * 1000).toISOString())
  const a = agentCard({ id: "a1", name: "kiro", type: "acp", enabled: true })
  expect(a).toEqual({ id: "a1", name: "kiro", type: "acp", enabled: true, url: undefined })
  expect(sessionCard(null)).toBe(null)
  expect(runCard("junk")).toBe(null)
  expect(agentCard(undefined)).toBe(null)
})
