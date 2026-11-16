import assert from "node:assert/strict"
import { env } from "node:process"
import test from "node:test"
import { readFile, access } from "node:fs/promises"
import { agent, connect } from "./saymore.agent.js"

test("exports a reversible connection without touching existing Providers", () => {
  assert.equal(agent.id, "saymore")
  assert.equal(agent.model, "integrations.magpie.model")
  const result = connect({
    gateway: { v1: "http://127.0.0.1:3425/v1", key: "local-attribution" },
    model: { id: "provider/model" },
  })
  assert.equal(result["integrations.magpie.model"], undefined)
  assert.equal(result["integrations.magpie.base_url"], "http://127.0.0.1:3425/v1")
  assert.equal(result["integrations.magpie.api_key"], "local-attribution")
  assert.equal(result["integrations.magpie.profile"], "portable")
})

test("targets only the production macOS handoff", async () => {
  const pkg = JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf8"))
  const manifestAgent = new URL(pkg.magpie.agent, import.meta.url)
  assert.equal(manifestAgent.href, new URL("./saymore.agent.js", import.meta.url).href)
  assert.equal(pkg.name, "@magpie-community/agent-saymore")
  assert.equal(pkg.main, undefined)
  assert.equal(pkg.magpie.agent, "./saymore.agent.js")
  for (const field of ["name", "summary", "icon"]) {
    assert.deepEqual(pkg.magpie[field], agent[field])
  }
  const registry = JSON.parse(await readFile(env.MAGPIE_REGISTRY ?? new URL("../../registry.json", import.meta.url), "utf8"))
  const entries = registry.plugins.filter((entry) => entry.package === pkg.name)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].kind, "agent")
  assert.equal(entries[0].providers, undefined)
  for (const field of ["name", "summary", "icon"]) {
    assert.deepEqual(pkg.magpie[field], entries[0][field])
  }
  assert.equal(agent.config, "~/Library/Application Support/Saymore/config.json")
  assert.equal(agent.dir, "~/Library/Application Support/Saymore")
  for (const path of pkg.files) {
    await access(new URL(path, import.meta.url))
  }
})
