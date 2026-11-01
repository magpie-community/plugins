import { expect, test } from "bun:test"
import { agent } from "./omo-multimodal-looker.agent.js"

test("says where OmO keeps the multimodal-looker agent's model", () => {
  expect(agent).toMatchObject({ id: "omo-multimodal-looker", config: "~/.omo/omo.jsonc", model: "agents.multimodal-looker.model" })
})
