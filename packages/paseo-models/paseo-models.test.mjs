import { expect, test } from "bun:test"
import { agent, connect } from "./paseo-models.agent.js"

const KEY = "agents.providers.claude.additionalModels"

test("says where Paseo keeps its providers", () => {
  expect(agent).toMatchObject({ id: "paseo-models", config: "~/.paseo/config.json", format: "json" })
})

test("adds magpie's models to Paseo's claude provider and nothing else", () => {
  const out = connect({
    models: [
      { id: "zcode/GLM-5.3", name: "GLM-5.3 · ZCode", context: 1000000, efforts: ["low", "high", "max"] },
      { id: "zcode/GLM-5-Turbo", name: "GLM-5-Turbo", context: 200000, efforts: [] },
    ],
  })
  expect(Object.keys(out)).toEqual([KEY])
  expect(out[KEY]).toEqual([
    {
      id: "zcode/GLM-5.3[1m]",
      label: "GLM-5.3 · ZCode",
      thinkingOptions: [
        { id: "low", label: "low", isDefault: false },
        { id: "high", label: "high", isDefault: true },
        { id: "max", label: "max", isDefault: false },
      ],
    },
    { id: "zcode/GLM-5-Turbo", label: "GLM-5-Turbo" },
  ])
})

test("keeps only the levels Claude Code supports and defaults to the last without high", () => {
  const [m] = connect({ models: [{ id: "x/y", context: 0, efforts: ["minimal", "low", "medium", "ultra"] }] })[KEY]
  expect(m.thinkingOptions).toEqual([
    { id: "low", label: "low", isDefault: false },
    { id: "medium", label: "medium", isDefault: true },
  ])
})

test("writes nothing while magpie has no models", () => {
  expect(connect({ models: [] })).toEqual({})
})
