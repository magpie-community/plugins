import { expect, test } from "bun:test"
import { agent } from "./omo-hephaestus.agent.js"

test("says where OmO keeps the hephaestus agent's model", () => {
  expect(agent).toMatchObject({ id: "omo-hephaestus", config: "~/.omo/omo.jsonc", model: "agents.hephaestus.model" })
})
