import { expect, test } from "bun:test"
import { agent } from "./omo-deep-high.agent.js"

test("says where OmO keeps the deep-high category's model", () => {
  expect(agent).toMatchObject({ id: "omo-deep-high", config: "~/.omo/omo.jsonc", model: "categories.deep-high.model" })
})
