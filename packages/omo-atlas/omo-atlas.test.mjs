import { expect, test } from "bun:test"
import { agent } from "./omo-atlas.agent.js"

test("says where OmO keeps the atlas agent's model", () => {
  expect(agent).toMatchObject({ id: "omo-atlas", config: "~/.omo/omo.jsonc", model: "agents.atlas.model" })
})
