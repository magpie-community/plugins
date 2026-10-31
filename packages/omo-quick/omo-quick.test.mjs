import { expect, test } from "bun:test"
import { agent } from "./omo-quick.agent.js"

test("says where OmO keeps the quick category's model", () => {
  expect(agent).toMatchObject({ id: "omo-quick", config: "~/.omo/omo.jsonc", model: "categories.quick.model" })
})
