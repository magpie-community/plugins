import { expect, test } from "bun:test"
import { agent } from "./omo-artistry.agent.js"

test("says where OmO keeps the artistry category's model", () => {
  expect(agent).toMatchObject({ id: "omo-artistry", config: "~/.omo/omo.jsonc", model: "categories.artistry.model" })
})
