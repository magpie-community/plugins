import { expect, test } from "bun:test"
import { agent } from "./omo-sisyphus.agent.js"

test("says where OmO keeps the sisyphus agent's model", () => {
  expect(agent).toMatchObject({ id: "omo-sisyphus", config: "~/.omo/omo.jsonc", model: "agents.sisyphus.model" })
})
