import { expect, test } from "bun:test"
import { agent } from "./omo-deep-low.agent.js"

test("says where OmO keeps the deep-low category's model", () => {
  expect(agent).toMatchObject({ id: "omo-deep-low", config: "~/.omo/omo.jsonc", model: "categories.deep-low.model" })
})
