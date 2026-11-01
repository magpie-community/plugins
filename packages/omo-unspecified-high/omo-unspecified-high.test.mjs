import { expect, test } from "bun:test"
import { agent } from "./omo-unspecified-high.agent.js"

test("says where OmO keeps the unspecified-high category's model", () => {
  expect(agent).toMatchObject({ id: "omo-unspecified-high", config: "~/.omo/omo.jsonc", model: "categories.unspecified-high.model" })
})
