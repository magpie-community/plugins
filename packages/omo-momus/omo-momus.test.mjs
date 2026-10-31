import { expect, test } from "bun:test"
import { agent } from "./omo-momus.agent.js"

test("says where OmO keeps the momus agent's model", () => {
  expect(agent).toMatchObject({ id: "omo-momus", config: "~/.omo/omo.jsonc", model: "agents.momus.model" })
})
