import { expect, test } from "bun:test"
import { agent } from "./omo-writing.agent.js"

test("says where OmO keeps the writing category's model", () => {
  expect(agent).toMatchObject({ id: "omo-writing", config: "~/.omo/omo.jsonc", model: "categories.writing.model" })
})
