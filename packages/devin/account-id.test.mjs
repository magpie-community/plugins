import { expect, test } from "bun:test"
import { _internal } from "./index.mjs"

test("uses Devin organization or team identity for account slots", () => {
  expect(_internal.accountIdOf({ user: "same@example.com", orgId: "org-a", teamId: "team-a" })).toBe("org-a")
  expect(_internal.accountIdOf({ user: "same@example.com", teamId: "team-b" })).toBe("team-b")
  expect(_internal.accountIdOf({ user: "other@example.com" })).toBe("other@example.com")
  expect(_internal.accountIdOf({})).toBe("Devin")
})
