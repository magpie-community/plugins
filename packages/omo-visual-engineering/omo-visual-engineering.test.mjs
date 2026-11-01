import { expect, test } from "bun:test"
import { agent } from "./omo-visual-engineering.agent.js"

test("says where OmO keeps the visual-engineering category's model", () => {
  expect(agent).toMatchObject({ id: "omo-visual-engineering", config: "~/.omo/omo.jsonc", model: "categories.visual-engineering.model" })
})
