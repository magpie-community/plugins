import { expect, test } from "bun:test"
import { RaccoonAuthPlugin, _internal } from "./index.mjs"

const {
  normalizeRaccoonThinking,
  levelForEffort,
  applyThinkingLevel,
  variantsFor,
  parseCatalog,
} = _internal

// The shapes the vendor's catalog actually returns.
const THREE = {
  supported: true,
  can_disable: true,
  default_level: "off",
  display_levels: [
    { value: "level_1", label: "Minimal" },
    { value: "level_3", label: "Medium" },
    { value: "level_5", label: "Max" },
  ],
}

const FOUR = {
  supported: true,
  can_disable: true,
  default_level: "off",
  display_levels: [
    { value: "level_1", label: "Minimal" },
    { value: "level_2", label: "Low" },
    { value: "level_4", label: "High" },
    { value: "level_5", label: "Max" },
  ],
}

const THREE_LOCKED = {
  supported: true,
  can_disable: false,
  default_level: "level_1",
  display_levels: THREE.display_levels,
}

function catalogPayload(models) {
  return { data: { categories: [{ type: "chat", models }] } }
}

test("normalizeRaccoonThinking keeps the levels the vendor publishes", () => {
  expect(normalizeRaccoonThinking(THREE)).toEqual({
    supported: true,
    canDisable: true,
    defaultLevel: "off",
    levels: [
      { value: "level_1", label: "Minimal" },
      { value: "level_3", label: "Medium" },
      { value: "level_5", label: "Max" },
    ],
  })
})

test("normalizeRaccoonThinking refuses what is not a capability", () => {
  expect(normalizeRaccoonThinking(undefined)).toBeNull()
  expect(normalizeRaccoonThinking(null)).toBeNull()
  expect(normalizeRaccoonThinking("yes")).toBeNull()
  expect(normalizeRaccoonThinking([THREE])).toBeNull()
  expect(normalizeRaccoonThinking({ supported: false, can_disable: false, display_levels: [] })).toBeNull()
})

test("levelForEffort ranks an effort across three levels", () => {
  const t = normalizeRaccoonThinking(THREE)
  expect(levelForEffort("minimal", t)).toBe("level_1")
  expect(levelForEffort("low", t)).toBe("level_3")
  expect(levelForEffort("medium", t)).toBe("level_3")
  expect(levelForEffort("high", t)).toBe("level_5")
  expect(levelForEffort("max", t)).toBe("level_5")
  // xhigh is "extra high": it takes the top level, as max does
  expect(levelForEffort("xhigh", t)).toBe("level_5")
})

test("levelForEffort ranks the same names across four levels", () => {
  const t = normalizeRaccoonThinking(FOUR)
  expect(levelForEffort("minimal", t)).toBe("level_1")
  expect(levelForEffort("low", t)).toBe("level_2")
  expect(levelForEffort("medium", t)).toBe("level_4")
  expect(levelForEffort("high", t)).toBe("level_4")
  expect(levelForEffort("max", t)).toBe("level_5")
})

test("levelForEffort takes a level name as given", () => {
  const t = normalizeRaccoonThinking(FOUR)
  expect(levelForEffort("level_4", t)).toBe("level_4")
  expect(levelForEffort("LEVEL_2", t)).toBe("level_2")
})

test("levelForEffort honours can_disable", () => {
  expect(levelForEffort("off", normalizeRaccoonThinking(THREE))).toBe("off")
  expect(levelForEffort("off", normalizeRaccoonThinking(THREE_LOCKED))).toBeNull()
  expect(levelForEffort("none", normalizeRaccoonThinking(THREE_LOCKED))).toBeNull()
})

test("levelForEffort says nothing for no effort, no levels or an unknown name", () => {
  const t = normalizeRaccoonThinking(THREE)
  expect(levelForEffort(undefined, t)).toBeNull()
  expect(levelForEffort("", t)).toBeNull()
  expect(levelForEffort("turbo", t)).toBeNull()
  expect(levelForEffort("max", null)).toBeNull()
  expect(levelForEffort("max", normalizeRaccoonThinking({ supported: false }))).toBeNull()
})

test("applyThinkingLevel sets the level and drops the effort the vendor misreads", () => {
  const t = normalizeRaccoonThinking(THREE)
  const body = JSON.stringify({
    model: "sn-qwen4-max",
    messages: [{ role: "user", content: "hi" }],
    temperature: 0,
    reasoning_effort: "max",
  })
  const out = JSON.parse(applyThinkingLevel(body, t))
  expect(out.raccoon_thinking_level).toBe("level_5")
  expect("reasoning_effort" in out).toBe(false)
  // everything else is left exactly as the client sent it
  expect(out.model).toBe("sn-qwen4-max")
  expect(out.temperature).toBe(0)
  expect(out.messages).toEqual([{ role: "user", content: "hi" }])
})

test("applyThinkingLevel leaves a request with no effort alone", () => {
  const t = normalizeRaccoonThinking(THREE)
  const body = JSON.stringify({ model: "sn-qwen4-max", messages: [] })
  expect(applyThinkingLevel(body, t)).toBeNull()
})

test("applyThinkingLevel clears the level for off", () => {
  const t = normalizeRaccoonThinking(THREE)
  const body = JSON.stringify({
    model: "sn-qwen4-max",
    messages: [],
    reasoning_effort: "off",
    raccoon_thinking_level: "level_5",
  })
  const out = JSON.parse(applyThinkingLevel(body, t))
  expect("raccoon_thinking_level" in out).toBe(false)
  expect("reasoning_effort" in out).toBe(false)
})

test("applyThinkingLevel is a no-op for a body it cannot read", () => {
  const t = normalizeRaccoonThinking(THREE)
  expect(applyThinkingLevel("not json", t)).toBeNull()
  expect(applyThinkingLevel("", t)).toBeNull()
  expect(applyThinkingLevel(undefined, t)).toBeNull()
  expect(applyThinkingLevel(JSON.stringify(["array"]), t)).toBeNull()
  expect(applyThinkingLevel(JSON.stringify({ reasoning_effort: "max" }), null)).toBeNull()
})

test("applyThinkingLevel reports no change when the body is already right", () => {
  const t = normalizeRaccoonThinking(THREE)
  const body = JSON.stringify({ raccoon_thinking_level: "level_5" })
  // nothing to strip, the level already matches: the caller keeps its body
  expect(applyThinkingLevel(body, t)).toBeNull()
})

test("variantsFor offers the picker a client reads", () => {
  expect(variantsFor(normalizeRaccoonThinking(THREE))).toEqual({
    off: {},
    minimal: { raccoon_thinking_level: "level_1" },
    low: { raccoon_thinking_level: "level_3" },
    medium: { raccoon_thinking_level: "level_3" },
    high: { raccoon_thinking_level: "level_5" },
    max: { raccoon_thinking_level: "level_5" },
  })
  expect(variantsFor(normalizeRaccoonThinking(THREE_LOCKED)).off).toBeUndefined()
  expect(variantsFor(null)).toEqual({})
})

test("parseCatalog takes thinking from the catalog instead of claiming it", () => {
  const models = parseCatalog(
    catalogPayload([
      { name: "sn-qwen4-max", params: { context_window: 1_000_000, max_tokens: 100_000, raccoon_thinking: THREE } },
      {
        name: "sn-no-thinking",
        params: { raccoon_thinking: { supported: false, can_disable: false, display_levels: [] } },
      },
      { name: "sn-silent", params: { context_window: 256_000 } },
    ]),
  )
  const byId = Object.fromEntries(models.map((m) => [m.id, m]))

  expect(byId["sn-qwen4-max"].reasoning).toBe(true)
  expect(byId["sn-qwen4-max"].thinking.levels.map((l) => l.value)).toEqual([
    "level_1",
    "level_3",
    "level_5",
  ])

  // a model that says it does not think is no longer advertised as one
  expect(byId["sn-no-thinking"].reasoning).toBe(false)
  expect(byId["sn-no-thinking"].thinking).toBeUndefined()

  // a catalog that predates the field keeps the old claim
  expect(byId["sn-silent"].reasoning).toBe(true)
  expect(byId["sn-silent"].thinking).toBeUndefined()
})

// ---- end to end through the plugin's own loader -----------------------------

function fakeJwt(claims) {
  const h = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url")
  const p = Buffer.from(JSON.stringify(claims)).toString("base64url")
  return `${h}.${p}.sig`
}

async function withFakeVendor(run) {
  const seen = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url)
      if (u.pathname.endsWith("/model_catalog")) {
        return Response.json({
          code: 0,
          data: {
            categories: [
              {
                type: "chat",
                models: [{ name: "sn-qwen4-max", params: { raccoon_thinking: THREE } }],
              },
            ],
          },
        })
      }
      if (u.pathname.endsWith("/chat/completions")) {
        seen.push(await req.json())
        return Response.json({ choices: [{ message: { content: "ok" } }] })
      }
      return new Response("{}", { status: 404 })
    },
  })
  const prev = process.env.RACCOON_MAIN_SITE_URL
  process.env.RACCOON_MAIN_SITE_URL = `http://127.0.0.1:${server.port}`
  try {
    await run(seen)
  } finally {
    server.stop(true)
    if (prev === undefined) delete process.env.RACCOON_MAIN_SITE_URL
    else process.env.RACCOON_MAIN_SITE_URL = prev
  }
}

async function loaderFor() {
  const tok = fakeJwt({ iss: "74350b", name: "Mason", exp: Math.floor(Date.now() / 1000) + 3600 })
  const stored = { type: "oauth", access: tok, refresh: "R1", expires: Date.now() + 3600_000 }
  const hooks = await RaccoonAuthPlugin({ client: { auth: { set: async () => {} } } })
  return hooks.auth.loader(async () => stored)
}

test("the loader sends the level the vendor wants, not the effort it misreads", async () => {
  await withFakeVendor(async (seen) => {
    const loaded = await loaderFor()
    const res = await loaded.fetch(`${loaded.baseURL}/chat/completions`, {
      method: "POST",
      body: JSON.stringify({
        model: "sn-qwen4-max",
        messages: [{ role: "user", content: "hi" }],
        reasoning_effort: "max",
      }),
    })
    expect(res.status).toBe(200)
    expect(seen.length).toBe(1)
    expect(seen[0].raccoon_thinking_level).toBe("level_5")
    expect("reasoning_effort" in seen[0]).toBe(false)
    expect(seen[0].model).toBe("sn-qwen4-max")
    expect(seen[0].messages).toEqual([{ role: "user", content: "hi" }])
  })
})

test("the loader leaves a request with no effort exactly as it came", async () => {
  await withFakeVendor(async (seen) => {
    const loaded = await loaderFor()
    await loaded.fetch(`${loaded.baseURL}/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "sn-qwen4-max", messages: [] }),
    })
    expect(seen[0]).toEqual({ model: "sn-qwen4-max", messages: [] })
  })
})

test("the loader levels a model the gateway names with its provider prefix", async () => {
  await withFakeVendor(async (seen) => {
    const loaded = await loaderFor()
    await loaded.fetch(`${loaded.baseURL}/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "raccoon/sn-qwen4-max", messages: [], reasoning_effort: "medium" }),
    })
    expect(seen[0].raccoon_thinking_level).toBe("level_3")
    expect(seen[0].model).toBe("raccoon/sn-qwen4-max")
  })
})

const FIVE = {
  supported: true,
  can_disable: true,
  default_level: "off",
  display_levels: [
    { value: "level_1", label: "Minimal" },
    { value: "level_2", label: "Low" },
    { value: "level_3", label: "Medium" },
    { value: "level_4", label: "High" },
    { value: "level_5", label: "Max" },
  ],
}

test("a model with all five levels maps one to one", () => {
  const t = normalizeRaccoonThinking(FIVE)
  expect(levelForEffort("minimal", t)).toBe("level_1")
  expect(levelForEffort("low", t)).toBe("level_2")
  expect(levelForEffort("medium", t)).toBe("level_3")
  expect(levelForEffort("high", t)).toBe("level_4")
  expect(levelForEffort("max", t)).toBe("level_5")
  expect(levelForEffort("off", t)).toBe("off")
})

test("an effort may be named by the vendor's own label", () => {
  const t = normalizeRaccoonThinking(FIVE)
  expect(levelForEffort("Medium", t)).toBe("level_3")
  expect(levelForEffort("High", t)).toBe("level_4")
})

test("an effort with nothing above it takes the highest level the model has", () => {
  // a model whose top is level_2: max has nowhere to round up to
  const two = normalizeRaccoonThinking({
    supported: true,
    can_disable: false,
    display_levels: [{ value: "level_1" }, { value: "level_2" }],
  })
  expect(levelForEffort("max", two)).toBe("level_2")
  expect(levelForEffort("high", two)).toBe("level_2")
  expect(levelForEffort("minimal", two)).toBe("level_1")
})

test("an effort missing its own level rounds up, not down", () => {
  const t = normalizeRaccoonThinking(THREE)
  // level_2 and level_4 are not published: both go to the next one up
  expect(levelForEffort("low", t)).toBe("level_3")
  expect(levelForEffort("high", t)).toBe("level_5")
})

test("a model is found however the catalog and the request spell it", () => {
  const models = [
    { id: "sn-qwen4-max-p", thinking: normalizeRaccoonThinking(THREE) },
    { id: "sn-glm-5-3", thinking: normalizeRaccoonThinking(THREE) },
  ]
  const { thinkingOf } = _internal
  // the catalog suffixes -p, the request may not
  expect(thinkingOf("sn-qwen4-max", models)?.levels.length).toBe(3)
  // the gateway prefixes its provider
  expect(thinkingOf("raccoon/sn-qwen4-max", models)?.levels.length).toBe(3)
  expect(thinkingOf("raccoon/sn-qwen4-max-p", models)?.levels.length).toBe(3)
  expect(thinkingOf("sn-qwen4-max-p", models)?.levels.length).toBe(3)
  // a model the catalog does not list has no levels
  expect(thinkingOf("sn-unknown", models)).toBeNull()
  expect(thinkingOf("", models)).toBeNull()
  expect(thinkingOf("sn-qwen4-max", [])).toBeNull()
})
