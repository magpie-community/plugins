import { expect, test } from "bun:test"
import { agent } from "./omo-oracle.agent.js"

test("says where OmO keeps the oracle agent's model", () => {
  expect(agent).toMatchObject({ id: "omo-oracle", config: "~/.omo/omo.jsonc", model: "agents.oracle.model" })
})
