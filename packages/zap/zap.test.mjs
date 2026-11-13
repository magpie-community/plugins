import { describe, expect, test } from "bun:test"
import { agent, connect } from "./zap.agent.js"
import { getLastUsedModel, providerBlockText, reconcileToml, removeProviderBlocks, PROVIDER_ID } from "./toml.mjs"

const gateway = { url: "http://127.0.0.1:3425", v1: "http://127.0.0.1:3425/v1", key: "magpie-zap" }

describe("agent", () => {
  test("manages a JSON outbox next to Zap's settings.toml", () => {
    expect(agent).toMatchObject({
      id: "zap",
      config: "~/.zap/magpie-bridge.json",
      format: "json",
      model: "selected",
      prefix: "",
    })
  })

  test("shows Zap's own icon, as the package gives it", async () => {
    const pkg = await Bun.file(new URL("./package.json", import.meta.url)).json()
    expect(agent.icon).toBe(pkg.magpie.icon)
  })
})

describe("connect", () => {
  test("hands the gateway and the whole catalog to the outbox", () => {
    const out = connect({
      gateway,
      models: [
        { id: "acme/acme-coder", name: "Acme Coder", context: 200000, images: true },
        { id: "acme/acme-mini", name: "Acme Mini", context: 0, images: false },
      ],
    })
    expect(out.base_url).toBe("http://127.0.0.1:3425/v1")
    expect(out.models["acme/acme-coder"]).toEqual({ name: "Acme Coder", context: 200000, image: true })
    expect(out.models["acme/acme-mini"]).toEqual({ name: "Acme Mini" })
  })
})

// A user-made provider on the magpie gateway URL and a DeepSeek provider,
// plus a multi-line string with three empty lines elsewhere in the file.
const USER_TOML = `[notes]
text = """line one


line four"""
[agents.third_party.per_agent]
Codex = { toolbar = true }

[agents.byop]
last_used_model_id = "byop:user-own-uuid:my-model"

[[agents.warp_agent.providers]]
id = "user-own-uuid"
name = "My magpie"
kind = "open_ai_compatible"
api_type = "open_ai"
base_url = "http://127.0.0.1:3425/v1"

[[agents.warp_agent.providers.models]]
name = "My Model"
id = "my-model"

[[agents.warp_agent.providers]]
id = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
name = "DeepSeek official"
kind = "open_ai_compatible"
api_type = "open_ai"
base_url = "https://api.deepseek.com/v1"

[[agents.warp_agent.providers.models]]
name = "DeepSeek Chat"
id = "deepseek-chat"
`

const OUTBOX = {
  base_url: "http://127.0.0.1:3425/v1",
  selected: "tokenservice/kimi-k3",
  models: {
    "tokenservice/kimi-k3": { name: "Kimi K3", context: 1048576, image: true },
    "zcode/glm-5.3": { name: "GLM 5.3" },
  },
}

describe("user content is preserved", () => {
  test("a hand-made provider on the gateway URL is never removed", () => {
    const { text } = reconcileToml(USER_TOML, OUTBOX, {})
    expect(text).toContain('id = "user-own-uuid"')
    expect(text).toContain('name = "My magpie"')
    expect(text).toContain('id = "my-model"')
    const off = reconcileToml(text, null, { lastAppliedSelected: "tokenservice/kimi-k3", preLastUsed: getLastUsedModel(USER_TOML) })
    expect(off.text).toContain('id = "user-own-uuid"')
    expect(off.text).not.toContain(PROVIDER_ID)
    const off2 = reconcileToml(off.text, null, off.state) // no flap
    expect(off2.changed).toBe(false)
  })

  test("multi-line strings and blank runs keep their exact bytes", () => {
    const { text } = reconcileToml(USER_TOML, OUTBOX, {})
    expect(text).toContain("line one\n\n\nline four")
    const off = reconcileToml(text, null, { lastAppliedSelected: "tokenservice/kimi-k3", preLastUsed: getLastUsedModel(USER_TOML) })
    expect(off.text).toContain("line one\n\n\nline four")
  })

  test("removeProviderBlocks touches nothing outside the managed block", () => {
    const withManaged = reconcileToml(USER_TOML, OUTBOX, {}).text
    const { text, removedText } = removeProviderBlocks(withManaged)
    expect(removedText).toContain(PROVIDER_ID)
    expect(text).toBe(USER_TOML.replace("[agents.byop]\nlast_used_model_id = \"byop:user-own-uuid:my-model\"", "[agents.byop]\nlast_used_model_id = \"byop:6d616770-6965-4000-8000-7a6170000001:tokenservice/kimi-k3\""))
  })
})

describe("managed provider lifecycle", () => {
  test("connect installs the provider and points last_used at the pick", () => {
    const { text, state, changed } = reconcileToml(USER_TOML, OUTBOX, {})
    expect(changed).toBe(true)
    expect(text).toContain(`id = "${PROVIDER_ID}"`)
    expect(text).toContain('name = "DeepSeek official"')
    expect(text).toContain("[agents.third_party.per_agent]")
    expect(getLastUsedModel(text)).toBe(`byop:${PROVIDER_ID}:tokenservice/kimi-k3`)
    expect(state.lastAppliedSelected).toBe("tokenservice/kimi-k3")
    expect(state.preLastUsed).toBe("byop:user-own-uuid:my-model")
    expect(state.managedBlock).toBeTruthy()
  })

  test("reconcile is idempotent once in sync", () => {
    const first = reconcileToml(USER_TOML, OUTBOX, {})
    const second = reconcileToml(first.text, OUTBOX, first.state)
    expect(second.changed).toBe(false)
  })

  test("a model switch moves last_used", () => {
    const first = reconcileToml(USER_TOML, OUTBOX, {})
    const switched = reconcileToml(first.text, { ...OUTBOX, selected: "zcode/glm-5.3" }, first.state)
    expect(getLastUsedModel(switched.text)).toBe(`byop:${PROVIDER_ID}:zcode/glm-5.3`)
  })

  test("a user's own pick in Zap is left alone", () => {
    const first = reconcileToml(USER_TOML, OUTBOX, {})
    const userPicked = first.text.replace(
      `last_used_model_id = "byop:${PROVIDER_ID}:tokenservice/kimi-k3"`,
      'last_used_model_id = "byop:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb:deepseek-chat"',
    )
    const again = reconcileToml(userPicked, OUTBOX, first.state)
    expect(getLastUsedModel(again.text)).toBe("byop:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb:deepseek-chat")
  })

  test("disconnect removes the managed provider and restores the previous pick", () => {
    const first = reconcileToml(USER_TOML, OUTBOX, {})
    const off = reconcileToml(first.text, null, first.state)
    expect(off.text).not.toContain(PROVIDER_ID)
    expect(off.text).toContain('id = "user-own-uuid"')
    expect(getLastUsedModel(off.text)).toBe("byop:user-own-uuid:my-model")
    expect(off.state).toEqual({})
  })
})

describe("host stopped with a stale outbox", () => {
  // The plugin is turned off or removed while connected: core empties the
  // outbox but the host is down, so the disconnect is never written. The
  // tombstone left by earlier ticks must clean the file on the next tick.
  const buildStale = () => {
    const first = reconcileToml(USER_TOML, OUTBOX, {})
    const tombstone = { managedBlock: first.state.managedBlock, preLastUsed: first.state.preLastUsed }
    return { text: first.text, tombstone }
  }

  test("the stale managed provider is removed from the file", () => {
    const { text, tombstone } = buildStale()
    const cleaned = reconcileToml(text, null, tombstone)
    expect(cleaned.text).not.toContain(PROVIDER_ID)
    expect(cleaned.text).toContain('id = "user-own-uuid"')
    expect(getLastUsedModel(cleaned.text)).toBe("byop:user-own-uuid:my-model")
    expect(cleaned.state).toEqual({})
    const again = reconcileToml(cleaned.text, null, cleaned.state)
    expect(again.changed).toBe(false)
  })
})
