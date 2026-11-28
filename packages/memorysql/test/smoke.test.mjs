import { expect, test } from "bun:test"
import { createEmbeddedBackend } from "../lib/backend/embedded.mjs"

test("embedded store imports a session, searches it, and injects nothing by default", async () => {
  const fetchCalls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    fetchCalls.push(String(url))
    throw new Error(`network call in test: ${url}`)
  }
  const llm = {
    async models() {
      return [{ id: "test/model", name: "Test Model" }]
    },
    async resolveModel() {
      return "test/model"
    },
    async chat() {
      return { model: "test/model", content: "{}" }
    }
  }
  const backend = await createEmbeddedBackend({ memory: true, llm })
  try {
    expect(backend.recallConfig()).toEqual({ inject: false, all: true, agents: [] })
    const imported = JSON.parse(
      await backend.call("memory_import_session", {
        agent: "zcode",
        externalId: "smoke-1",
        cwd: "H:/work/demo",
        title: "登录排查",
        messages: [
          { role: "user", content: "登录一直失败怎么办？" },
          { role: "assistant", content: "先看 session 过期时间。" }
        ]
      })
    )
    expect(imported.outcome).toBe("imported")

    const hits = JSON.parse(await backend.call("memory_search", { query: "登录", format: "json" }))
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.some((hit) => hit.sessionId === imported.id)).toBe(true)

    await backend.ui.setDistill({ inject: true, injectAll: false, injectAgents: [] })
    expect(backend.recallConfig()).toEqual({ inject: true, all: false, agents: [] })
    expect(fetchCalls).toEqual([])
  } finally {
    globalThis.fetch = realFetch
    backend.close()
  }
})
