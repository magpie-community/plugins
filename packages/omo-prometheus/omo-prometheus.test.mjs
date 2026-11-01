import { expect, test } from "bun:test"
import { agent } from "./omo-prometheus.agent.js"

test("says where OmO keeps the prometheus agent's model", () => {
  expect(agent).toMatchObject({ id: "omo-prometheus", config: "~/.omo/omo.jsonc", model: "agents.prometheus.model" })
})
