import { expect, test } from "bun:test"
import { agent } from "./omo-plan-reviewer.agent.js"

test("says where OmO keeps the plan-reviewer agent's model", () => {
  expect(agent).toMatchObject({ id: "omo-plan-reviewer", config: "~/.omo/omo.jsonc", model: "agents.plan-reviewer.model" })
})
