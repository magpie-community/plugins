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

const USER_TOML = `[agents.third_party.per_agent]
Codex = { toolbar = true }

[agents.byop]
last_used_model_id = "auto/kimi-k3"

[[agents.warp_agent.providers]]
id = "000ab961-5ef4-4d48-a8c5-0ad6f4ed1b22"
name = "magpie (local)"
kind = "open_ai_compatible"
api_type = "open_ai"
base_url = "http://127.0.0.1:3425/v1"

[[agents.warp_agent.providers.models]]
name = "Kimi K3"
id = "auto/kimi-k3"
context_window = 1048576
image = true

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

describe("toml surgery", () => {
  test("adopts a hand-made provider on the same gateway, keeps the others", () => {
    const out = removeProviderBlocks(USER_TOML, { baseUrl: "http://127.0.0.1:3425/v1" })
    expect(out).not.toContain("magpie (local)")
    expect(out).toContain("DeepSeek official")
    expect(out).toContain("[agents.third_party.per_agent]")
  })

  test("renders a provider block in Zap's shape", () => {
    const block = providerBlockText({ baseUrl: "http://127.0.0.1:3425/v1", models: OUTBOX.models })
    expect(block).toContain(`id = "${PROVIDER_ID}"`)
    expect(block).toContain('base_url = "http://127.0.0.1:3425/v1"')
    expect(block).toContain('id = "tokenservice/kimi-k3"')
    expect(block).toContain("context_window = 1048576")
    expect(block).toContain("image = true")
    expect(block).not.toContain('id = "zcode/glm-5.3"\ncontext_window')
  })

  test("reconcile installs provider, points last_used at the pick, keeps user tables", () => {
    const { text, state, changed } = reconcileToml(USER_TOML, OUTBOX, {})
    expect(changed).toBe(true)
    expect(text).toContain(`id = "${PROVIDER_ID}"`)
    expect(text).not.toContain("magpie (local)")
    expect(text).toContain("DeepSeek official")
    expect(text).toContain("[agents.third_party.per_agent]")
    expect(getLastUsedModel(text)).toBe(`byop:${PROVIDER_ID}:tokenservice/kimi-k3`)
    expect(state.lastAppliedSelected).toBe("tokenservice/kimi-k3")
    expect(state.preLastUsed).toBe("auto/kimi-k3")
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

  test("disconnect removes the provider and restores the previous pick", () => {
    const first = reconcileToml(USER_TOML, OUTBOX, {})
    const off = reconcileToml(first.text, null, first.state)
    expect(off.text).not.toContain(PROVIDER_ID)
    expect(off.text).toContain("DeepSeek official")
    expect(getLastUsedModel(off.text)).toBe("auto/kimi-k3")
    expect(off.state).toEqual({})
    // and it stays off without flapping
    const again = reconcileToml(off.text, null, off.state)
    expect(again.changed).toBe(false)
  })
})
