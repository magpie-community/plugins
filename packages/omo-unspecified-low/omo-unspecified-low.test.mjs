import { expect, test } from "bun:test"
import { agent } from "./omo-unspecified-low.agent.js"

test("says where OmO keeps the unspecified-low category's model", () => {
  expect(agent).toMatchObject({ id: "omo-unspecified-low", config: "~/.omo/omo.jsonc", model: "categories.unspecified-low.model" })
})
