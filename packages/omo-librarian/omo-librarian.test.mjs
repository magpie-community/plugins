import { expect, test } from "bun:test"
import { agent } from "./omo-librarian.agent.js"

test("says where OmO keeps the librarian agent's model", () => {
  expect(agent).toMatchObject({ id: "omo-librarian", config: "~/.omo/omo.jsonc", model: "agents.librarian.model" })
})
