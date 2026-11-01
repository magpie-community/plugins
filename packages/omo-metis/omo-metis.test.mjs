import { expect, test } from "bun:test"
import { agent } from "./omo-metis.agent.js"

test("says where OmO keeps the metis agent's model", () => {
  expect(agent).toMatchObject({ id: "omo-metis", config: "~/.omo/omo.jsonc", model: "agents.metis.model" })
})
