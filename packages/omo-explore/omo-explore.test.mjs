import { expect, test } from "bun:test"
import { agent } from "./omo-explore.agent.js"

test("says where OmO keeps the explore agent's model", () => {
  expect(agent).toMatchObject({ id: "omo-explore", config: "~/.omo/omo.jsonc", model: "agents.explore.model" })
})
