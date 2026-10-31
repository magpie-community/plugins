import { expect, test } from "bun:test"
import { agent } from "./omo-sisyphus-junior.agent.js"

test("says where OmO keeps the sisyphus-junior agent's model", () => {
  expect(agent).toMatchObject({ id: "omo-sisyphus-junior", config: "~/.omo/omo.jsonc", model: "agents.sisyphus-junior.model" })
})
