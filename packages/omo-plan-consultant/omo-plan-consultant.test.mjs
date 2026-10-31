import { expect, test } from "bun:test"
import { agent } from "./omo-plan-consultant.agent.js"

test("says where OmO keeps the plan-consultant agent's model", () => {
  expect(agent).toMatchObject({ id: "omo-plan-consultant", config: "~/.omo/omo.jsonc", model: "agents.plan-consultant.model" })
})
