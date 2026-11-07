import { test } from "bun:test";

test("agent message compatibility: offline protocol and ledger checks", async () => {
  await import("./test.mjs");
});
