import { expect, test } from "bun:test"
import { entryOf, kindOf } from "./tagged-kind.mjs"

// The manifests #1200 lists from dist/tagged.json, cut to what decides.
test("an agent plugin that keeps a module of its own is an agent (#1200)", () => {
  const enhanced = { main: "./control/host.js", magpie: { agent: "./agent.js" } } // cursor-bridge-enhanced 0.2.17
  const deva = { main: "./index.mjs", magpie: { agent: "deva.agent.js" } }
  const kiki = { main: "./kiki.host.js", magpie: { agent: "./kiki.agent.js" } }
  const plain = { magpie: { agent: "./agent.js" } } // cursor-bridge 0.2.7
  for (const pj of [enhanced, deva, kiki, plain]) expect(kindOf(pj)).toBe("agent")
  // the file it loads is its module, as magpie's readTagged checks it
  expect(entryOf(kiki, "agent", true)).toBe("./kiki.host.js")
  expect(entryOf(plain, "agent", true)).toBe("./agent.js")
})

test("hooks alone are a hooks plugin, and their file is the one to find", () => {
  const pj = { magpie: { hooks: "./model-watch.hooks.js" } }
  expect(kindOf(pj)).toBe("hooks")
  expect(entryOf(pj, "hooks", true)).toBe("./model-watch.hooks.js")
})

test("a page stays a page when it also has a module and service", () => {
  for (const mg of [{ middleware: "m.js" }, { hooks: "h.js" }]) {
    expect(kindOf({ main: "index.mjs", magpie: mg })).toBe("")
    expect(kindOf({ exports: { ".": "./i.mjs" }, magpie: mg })).toBe("")
  }
  const page = { main: "server/index.mjs", magpie: { page: { file: "page/index.html", service: { port: 3489 } } } }
  expect(kindOf(page)).toBe("page")
  expect(entryOf(page, "page", true)).toBe("server/index.mjs")
  expect(kindOf({ main: "index.mjs" })).toBe("")
  expect(kindOf({ magpie: { middleware: "m.js" } })).toBe("middleware")
  expect(kindOf({ magpie: { page: { file: "p.html" } } })).toBe("page")
  // installed from npm, a provider loads npm's index file
  expect(entryOf({ main: "index.mjs" }, "", false)).toBe("index.js")
  expect(entryOf({ exports: { ".": { bun: "./b.mjs" } } }, "", true)).toBe("./b.mjs")
})
