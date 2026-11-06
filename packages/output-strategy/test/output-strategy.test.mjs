import { describe, expect, test } from "bun:test"

import {
  ANTISLOP_BOUNDARIES,
  OUTPUT_STYLE_CATALOG,
  OUTPUT_STYLE_IDS,
  SAFETY_BOUNDARIES,
  SHARED_BOUNDARIES,
  outputStyleMeta,
} from "../catalog.js"
import {
  OUTPUT_STYLE_MARKER,
  applyOutputStyles,
  buildOutputStylesInstruction,
  hasMediaBlocks,
} from "../apply.js"
import { onRequest } from "../output-strategy.middleware.js"

const ALL_STYLES = [
  "terse-prose",
  "less-code",
  "ponytail",
  "i-have-adhd",
  "terse-cjk",
  "antislop-ui",
  "antislop-copy",
]

function chat(content = "Fix the bug") {
  return { model: "test", messages: [{ role: "user", content }] }
}

function injectedText(body) {
  if (typeof body.instructions === "string") return body.instructions
  if (typeof body.system === "string") return body.system
  if (Array.isArray(body.system)) return body.system.map((block) => block.text).join("\n")
  return body.messages.map((message) => message.content).filter((content) => typeof content === "string").join("\n")
}

describe("catalog", () => {
  test("exports the seven styles in deterministic catalog order", () => {
    expect(OUTPUT_STYLE_IDS).toEqual(ALL_STYLES)
    expect(Object.keys(OUTPUT_STYLE_CATALOG)).toEqual(ALL_STYLES)
    for (const id of ALL_STYLES) {
      expect(outputStyleMeta(id)).toBe(OUTPUT_STYLE_CATALOG[id])
      expect(OUTPUT_STYLE_CATALOG[id].id).toBe(id)
      expect(OUTPUT_STYLE_CATALOG[id].label.length).toBeGreaterThan(0)
      expect(OUTPUT_STYLE_CATALOG[id].instruction.length).toBeGreaterThan(0)
    }
  })

  test("uses complete current upstream rules without host commands or frontmatter", () => {
    const caveman = OUTPUT_STYLE_CATALOG["terse-prose"].instruction
    expect(caveman).toContain("Existing comments in files you edit are payload too")
    expect(caveman).toContain("Harness asks for a status line or confirmation")
    expect(caveman).not.toContain("---\nname:")
    expect(caveman).not.toContain("/caveman")
    expect(caveman).not.toContain("Caveman mode:")
    expect(caveman).not.toContain("not tracked by this host")

    const ponytail = OUTPUT_STYLE_CATALOG.ponytail.instruction
    expect(ponytail).toContain("the calibration real hardware needs")
    expect(ponytail).toContain("shortcut: <the limit>, <when to upgrade>")
    expect(ponytail).not.toContain("/ponytail")
    expect(ponytail).not.toContain("## Levels")

    const adhd = OUTPUT_STYLE_CATALOG["i-have-adhd"].instruction
    expect(adhd).toContain("Never omit relevant items when completeness matters")
    expect(adhd).toContain("Authorization: Bearer ${token}")
    expect(adhd).not.toContain("---\nname:")
  })

  test("uses OmniRoute's current antislop full text", () => {
    expect(OUTPUT_STYLE_CATALOG["antislop-ui"].instruction).toBe(
      "Antislop UI filter, not a style guide. Every visual technique must pass a purpose test: it serves hierarchy, identity, or readability, and the reason is written down. Technique without purpose is removed. Color and decoration are accents, not defaults: no blue-purple gradient wash, no glass on every surface (max 1-2 elements), no glow everywhere (max 1-2 focus accents), no large shadow on every component. Radius follows one system, not pills everywhere. Palette capped at 2-3 core colors plus 1 accent. No template layout (hero plus identical card grid, bento mosaic, fake terminal hero, Trusted-By bar, 3 pricing columns). Composition follows content needs, not the AI default order.",
    )
    expect(OUTPUT_STYLE_CATALOG["antislop-copy"].instruction).toBe(
      "Antislop copy and human filter. Copy uses specific language, not AI defaults. Never use the em dash character. No generic CTAs (Get Started, Learn More, Try Now, Explore, Discover). No buzzwords (AI Powered, Seamless, Revolutionary, Cutting Edge, Next Generation). No chatbot closers (Hope this helps, Let me know if). No signposting announcements (Let's dive in, Here's what you need to know). No fake-candid openers (Honestly?, Real talk). Name the actor: We rewrote pricing, never pricing was updated. No forced rule-of-three trios, no not-just-X-its-Y formulas, no aphorism formulas. Never invent facts, names, numbers, or quotes. UI holds up for real people: text contrast meets WCAG AA (4.5:1 normal, 3:1 large), checked across the whole area. Never outline none without a visible focus-visible replacement. All controls reachable by keyboard (Tab, Enter or Space, Escape closes dialogs). No mouse-only patterns, no color-only status (pair with text or icon). Data views ship perceivable empty, loading, and error states. Mobile reflows with intent: no horizontal overflow, 200 percent zoom never clips text, focused input never hidden under the on-screen keyboard, tap targets at least 44px.",
    )
  })

  test("keeps shared, coding-safety and antislop boundaries", () => {
    expect(SHARED_BOUNDARIES).toContain("Code blocks, file paths, commands, errors, URLs: keep exact")
    expect(SAFETY_BOUNDARIES).toContain("input validation at trust boundaries")
    expect(ANTISLOP_BOUNDARIES).toContain("No fabricated statistics")
    expect(OUTPUT_STYLE_CATALOG["less-code"].boundaries).toBe(SAFETY_BOUNDARIES)
    expect(OUTPUT_STYLE_CATALOG.ponytail.boundaries).toBe(SAFETY_BOUNDARIES)
    expect(OUTPUT_STYLE_CATALOG["antislop-ui"].boundaries).toBe(ANTISLOP_BOUNDARIES)
    expect(OUTPUT_STYLE_CATALOG["antislop-copy"].boundaries).toBe(ANTISLOP_BOUNDARIES)
  })
})

describe("instruction building", () => {
  test("returns an empty instruction for no selection or only unknown ids", () => {
    expect(buildOutputStylesInstruction()).toBe("")
    expect(buildOutputStylesInstruction([])).toBe("")
    expect(buildOutputStylesInstruction(["unknown"])).toBe("")
    expect(buildOutputStylesInstruction("terse-prose")).toBe("")
  })

  test("combines selections in catalog order, not option order", () => {
    const instruction = buildOutputStylesInstruction(["antislop-copy", "terse-prose", "ponytail"])
    const terse = instruction.indexOf(OUTPUT_STYLE_CATALOG["terse-prose"].instruction)
    const ponytail = instruction.indexOf(OUTPUT_STYLE_CATALOG.ponytail.instruction)
    const antislop = instruction.indexOf(OUTPUT_STYLE_CATALOG["antislop-copy"].instruction)
    expect(terse).toBeGreaterThan(-1)
    expect(ponytail).toBeGreaterThan(terse)
    expect(antislop).toBeGreaterThan(ponytail)
  })

  test("deduplicates selected styles, marker and shared boundaries", () => {
    const instruction = buildOutputStylesInstruction(["ponytail", "less-code", "ponytail", "antislop-ui", "antislop-copy"])
    expect(instruction.split(OUTPUT_STYLE_MARKER)).toHaveLength(2)
    expect(instruction.split(SHARED_BOUNDARIES)).toHaveLength(2)
    expect(instruction.split(SAFETY_BOUNDARIES)).toHaveLength(2)
    expect(instruction.split(ANTISLOP_BOUNDARIES)).toHaveLength(2)
    expect(instruction.indexOf(OUTPUT_STYLE_CATALOG["less-code"].instruction)).toBeLessThan(
      instruction.indexOf(OUTPUT_STYLE_CATALOG.ponytail.instruction),
    )
  })

  test("accepts id entries without interpreting levels", () => {
    const instruction = buildOutputStylesInstruction([{ id: "terse-cjk" }])
    expect(instruction).toContain(OUTPUT_STYLE_CATALOG["terse-cjk"].instruction)
  })
})

describe("Chat Completions and Anthropic injection", () => {
  test("prepends a system message to an ordinary chat request", () => {
    const original = chat()
    const result = applyOutputStyles(original, ["terse-prose"])
    expect(result.applied).toBe(true)
    expect(result.appliedStyles).toEqual(["terse-prose"])
    expect(result.body.messages).toHaveLength(2)
    expect(result.body.messages[0].role).toBe("system")
    expect(result.body.messages[0].content.startsWith(`${OUTPUT_STYLE_MARKER}\n`)).toBe(true)
    expect(result.body.messages[1]).toEqual(original.messages[0])
    expect(original.messages).toHaveLength(1)
  })

  test("merges into a leading string system message in place", () => {
    const body = {
      messages: [
        { role: "system", content: "  Existing rules.  ", name: "rules" },
        { role: "user", content: "Hello" },
      ],
    }
    const result = applyOutputStyles(body, ["terse-prose"])
    expect(result.body.messages).toHaveLength(2)
    expect(result.body.messages[0].name).toBe("rules")
    expect(result.body.messages[0].content.startsWith("  Existing rules.\n\n")).toBe(true)
    expect(body.messages[0].content).toBe("  Existing rules.  ")
  })

  test("merges into a later string system message without creating messages[0]", () => {
    const body = {
      messages: [
        { role: "user", content: "Hello" },
        { role: "system", content: "Later rule" },
      ],
    }
    const result = applyOutputStyles(body, ["terse-prose"])
    expect(result.body.messages[0].role).toBe("user")
    expect(result.body.messages).toHaveLength(2)
    expect(result.body.messages[1].content).toContain(OUTPUT_STYLE_MARKER)
  })

  test("uses Anthropic top-level string system instead of messages[0]", () => {
    const body = { ...chat(), system: "Anthropic rules" }
    const result = applyOutputStyles(body, ["terse-prose"])
    expect(result.body.messages).toEqual(body.messages)
    expect(result.body.messages[0].role).toBe("user")
    expect(result.body.system.startsWith("Anthropic rules\n\n")).toBe(true)
    expect(result.body.system).toContain(OUTPUT_STYLE_MARKER)
  })

  test("appends an Anthropic top-level text block without changing existing blocks", () => {
    const block = { type: "text", text: "Anthropic rules", cache_control: { type: "ephemeral" } }
    const body = { ...chat(), system: [block] }
    const result = applyOutputStyles(body, ["antislop-ui"])
    expect(result.body.system).toHaveLength(2)
    expect(result.body.system[0]).toBe(block)
    expect(result.body.system[1].type).toBe("text")
    expect(result.body.system[1].text).toContain(OUTPUT_STYLE_MARKER)
    expect(body.system).toHaveLength(1)
  })

  test("uses a system message for an empty chat messages array", () => {
    const result = applyOutputStyles({ messages: [] }, ["terse-prose"])
    expect(result.applied).toBe(true)
    expect(result.body.messages).toHaveLength(1)
    expect(result.body.messages[0].role).toBe("system")
    expect(result.body.messages[0].content).toContain(OUTPUT_STYLE_MARKER)
  })

  test("uses top-level system for Anthropic without an existing system", () => {
    const result = applyOutputStyles(chat(), { styles: { "terse-prose": true }, protocol: "anthropic" })
    expect(result.applied).toBe(true)
    expect(result.body.system).toContain(OUTPUT_STYLE_MARKER)
    expect(result.body.messages).toHaveLength(1)
    expect(result.body.messages[0].role).toBe("user")
  })

  test("does not treat a marker in a user message as an injected system marker", () => {
    const result = applyOutputStyles(chat(OUTPUT_STYLE_MARKER), ["terse-prose"])
    expect(result.applied).toBe(true)
  })
})

describe("Responses injection", () => {
  const instructions = "You are Codex, a coding assistant.\nFollow the existing base instructions exactly."
  const allOn = { styles: Object.fromEntries(ALL_STYLES.map(id => [id, true])) }

  test("keeps Codex instructions byte-identical with every style on", () => {
    for (const input of [
      "Fix the bug",
      [{ role: "user", content: [{ type: "input_text", text: "Fix it" }] }],
    ]) {
      const body = { input, instructions, model: "gpt-5" }
      const result = applyOutputStyles(body, allOn)
      expect(result.applied).toBe(true)
      expect(result.body.instructions).toBe(instructions)
      expect(Buffer.from(result.body.instructions).equals(Buffer.from(instructions))).toBe(true)
      expect(result.body.input[0].role).toBe("developer")
      expect(result.body.input[0].content[0].text).toContain(OUTPUT_STYLE_MARKER)
      if (Array.isArray(input)) expect(result.body.input.at(-1)).toBe(input[0])
      else expect(result.body.input[1]).toEqual({ role: "user", content: input })
      expect(body.input).toEqual(input)
    }
  })

  test("uses a separate developer input item rather than creating instructions", () => {
    const result = applyOutputStyles({ messages: [], input: "Fix it" }, ["terse-prose"])
    expect(result.body.instructions).toBeUndefined()
    expect(result.body.system).toBeUndefined()
    expect(result.body.input[0].role).toBe("developer")
    expect(result.body.input[1]).toEqual({ role: "user", content: "Fix it" })
  })
})

describe("skip behavior", () => {
  test("no selection and unknown selections return the original body", () => {
    const body = chat()
    expect(applyOutputStyles(body, []).body).toBe(body)
    expect(applyOutputStyles(body, []).skippedReason).toBe("no_styles")
    expect(applyOutputStyles(body, ["missing"]).applied).toBe(false)
    expect(applyOutputStyles(body, null).applied).toBe(false)
  })

  test("unknown request shapes pass through", () => {
    for (const body of [{ model: "test" }, { contents: [{ parts: [{ text: "Hello" }] }] }, { input: 42 }, null, "body"]) {
      const result = applyOutputStyles(body, ["terse-prose"])
      expect(result.applied).toBe(false)
      expect(result.body).toBe(body)
      expect(result.skippedReason).toBe("no_messages")
    }
  })

  test("an existing marker leaves every request shape byte-identical", () => {
    const bodies = [
      { ...chat(), system: `Rules\n\n${OUTPUT_STYLE_MARKER}\nexisting` },
      { ...chat(), system: [{ type: "text", text: `${OUTPUT_STYLE_MARKER}\nexisting` }] },
      { input: "Fix it", instructions: `Codex rules\n\n${OUTPUT_STYLE_MARKER}\nexisting` },
      { input: [{ role: "developer", content: `${OUTPUT_STYLE_MARKER}\nexisting` }, { role: "user", content: "Fix it" }] },
      { ...chat(), instructions: `Old rules\n\n${OUTPUT_STYLE_MARKER}\nmore` },
    ]
    for (const body of bodies) {
      const serialized = JSON.stringify(body)
      const result = applyOutputStyles(body, ["ponytail"])
      expect(result.applied).toBe(false)
      expect(result.skippedReason).toBe("already_applied")
      expect(result.body).toBe(body)
      expect(JSON.stringify(result.body)).toBe(serialized)
    }
  })

  test("does not overwrite non-string Responses instructions", () => {
    const instructions = [{ type: "input_text", text: "Existing rules" }]
    const body = { input: [{ role: "user", content: "Fix it" }], instructions }
    const result = applyOutputStyles(body, ["terse-prose"])
    expect(result.applied).toBe(false)
    expect(result.skippedReason).toBe("unsupported_instructions_shape")
    expect(result.body.instructions).toBe(instructions)
  })

  test("does not overwrite a non-string non-array system object", () => {
    const system = { type: "text", text: "Proxy system" }
    const body = { ...chat(), system }
    const result = applyOutputStyles(body, ["terse-prose"])
    expect(result.applied).toBe(false)
    expect(result.skippedReason).toBe("unsupported_system_shape")
    expect(result.body.system).toBe(system)
  })

  test("a marker in instructions leaves a chat-shaped body unchanged", () => {
    const body = { ...chat(), instructions: `Old rules\n\n${OUTPUT_STYLE_MARKER}\nmore` }
    const result = applyOutputStyles(body, ["terse-prose"])
    expect(result.applied).toBe(false)
    expect(result.body).toBe(body)
  })

  test("media remains detectable but cannot turn injection off", () => {
    for (const part of [
      { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } },
      { type: "input_audio", input_audio: { data: "AA==", format: "wav" } },
      { type: "file", file: { file_data: "AA==" } },
    ]) {
      const body = { messages: [{ role: "user", content: [{ type: "text", text: "Inspect" }, part] }] }
      const result = applyOutputStyles(body, ["terse-prose"])
      expect(result.applied).toBe(true)
      expect(result.body.messages[0].role).toBe("system")
    }
  })

  test("skips Anthropic images, documents and images nested in tool results", () => {
    for (const content of [
      [{ type: "image", source: { type: "base64", data: "AA==" } }],
      [{ type: "document", source: { type: "base64", data: "AA==" } }],
      [{ type: "tool_result", content: [{ type: "image", source: { data: "AA==" } }] }],
    ]) {
      const body = { messages: [{ role: "user", content }] }
      expect(applyOutputStyles(body, ["terse-prose"]).applied).toBe(true)
    }
  })

  test("skips Responses input_image and input_file", () => {
    for (const part of [{ type: "input_image", image_url: "data:image/png;base64,AA==" }, { type: "input_file", file_data: "AA==" }]) {
      const body = { input: [{ role: "user", content: [part] }] }
      expect(applyOutputStyles(body, ["terse-prose"]).applied).toBe(true)
    }
  })

  test("detects Gemini inlineData and fileData without treating Gemini as an injectable shape", () => {
    for (const key of ["inlineData", "inline_data", "fileData", "file_data"]) {
      const body = { contents: [{ parts: [{ [key]: { data: "AA==" } }] }] }
      expect(hasMediaBlocks(body)).toBe(true)
      expect(applyOutputStyles(body, ["terse-prose"]).skippedReason).toBe("no_messages")
    }
  })

  test("text-only turns and tool schemas mentioning image still inject", () => {
    const body = {
      ...chat(),
      tools: [{ type: "function", function: { name: "image", parameters: { properties: { image_url: { type: "string" } } } } }],
    }
    const result = applyOutputStyles(body, ["terse-prose"])
    expect(result.applied).toBe(true)
    expect(result.body.tools).toBe(body.tools)
  })
})

describe("prompt-cache stability and result metadata", () => {
  test("keeps the same system blocks across turns, regardless of user wording", () => {
    const originalBlocks = [
      { type: "text", text: "Claude Code rules", cache_control: { type: "ephemeral" } },
      { type: "text", text: "Environment", cache_control: { type: "ephemeral" } },
    ]
    const turns = ["Fix the bug", "Delete the obsolete file", "Explain the next step"]
    for (const text of turns) {
      const result = applyOutputStyles({ system: originalBlocks, ...chat(text) }, { styles: { ponytail: true } })
      expect(result.applied).toBe(true)
      expect(result.body.system.slice(0, -1)).toEqual(originalBlocks)
      expect(result.body.system).toHaveLength(3)
      expect(result.body.system[2].text).toBe(buildOutputStylesInstruction(["ponytail"]))
    }
  })

  test("an image in history does not suppress a later system block", () => {
    const first = applyOutputStyles({ ...chat("Inspect"), system: "Rules" }, ["ponytail"])
    const withImage = applyOutputStyles({
      messages: [
        { role: "user", content: [{ type: "image", source: { data: "AA==" } }] },
        { role: "assistant", content: "Done" },
        { role: "user", content: "Next" },
      ],
      system: "Rules",
    }, ["ponytail"])
    expect(withImage.applied).toBe(true)
    expect(withImage.body.system).toBe(first.body.system)
  })

  test("counts UTF-8 bytes rather than UTF-16 code units", () => {
    const result = applyOutputStyles(chat(), { styles: { "terse-cjk": true } })
    expect(result.applied).toBe(true)
    const instruction = result.body.messages[0].content
    expect(result.addedBytes).toBe(Buffer.byteLength(instruction, "utf8"))
    expect(result.addedBytes).toBeGreaterThan(instruction.length)
  })
})

describe("middleware interface and fail-open behavior", () => {
  test("onRequest returns a transformed body only when injection applies", () => {
    const body = chat()
    const result = onRequest(body, { options: { styles: ["terse-prose"] } })
    expect(result).not.toBe(body)
    expect(injectedText(result)).toContain(OUTPUT_STYLE_MARKER)
  })

  test("onRequest returns undefined for no selection and unknown shapes", () => {
    expect(onRequest(chat(), { options: { styles: [] } })).toBeUndefined()
    expect(onRequest(chat(), {})).toBeUndefined()
    expect(onRequest({ model: "test" }, { options: { styles: ["terse-prose"] } })).toBeUndefined()
  })

  test("onRequest leaves a previous Output Strategy block untouched", () => {
    const marked = applyOutputStyles(chat(), ["terse-prose"]).body
    const result = onRequest(marked, { options: { styles: ["ponytail"] } })
    expect(result).toBeUndefined()
    expect(injectedText(marked)).toContain("# caveman")
    expect(injectedText(marked)).not.toContain("Ponytail")
  })

  test("applyOutputStyles fails open on invalid bodies and thrown property access", () => {
    expect(applyOutputStyles(undefined, ["terse-prose"]).applied).toBe(false)
    const body = new Proxy({}, {
      get() {
        throw new Error("boom")
      },
    })
    expect(() => applyOutputStyles(body, ["terse-prose"])).not.toThrow()
    expect(applyOutputStyles(body, ["terse-prose"])).toEqual({ body, applied: false, skippedReason: "error" })
  })

  test("onRequest fails open when options access throws", () => {
    const ctx = new Proxy({}, {
      get() {
        throw new Error("boom")
      },
    })
    expect(onRequest(chat(), ctx)).toBeUndefined()
  })

  test("each catalog style can be injected through the public middleware interface", () => {
    for (const id of OUTPUT_STYLE_IDS) {
      const result = onRequest(chat(), { options: { styles: [id] } })
      expect(result).toBeDefined()
      expect(injectedText(result)).toContain(OUTPUT_STYLE_CATALOG[id].instruction)
    }
  })
})
