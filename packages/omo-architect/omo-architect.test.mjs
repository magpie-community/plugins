import { expect, test } from "bun:test"
import { agent } from "./omo-architect.agent.js"

test("says where OmO keeps the architect category's model", () => {
  expect(agent).toMatchObject({ id: "omo-architect", config: "~/.omo/omo.jsonc", model: "categories.architect.model" })
})
