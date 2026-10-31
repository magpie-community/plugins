import { expect, test } from "bun:test"
import { agent } from "./omo-ultrabrain.agent.js"

test("says where OmO keeps the ultrabrain category's model", () => {
  expect(agent).toMatchObject({ id: "omo-ultrabrain", config: "~/.omo/omo.jsonc", model: "categories.ultrabrain.model" })
})
