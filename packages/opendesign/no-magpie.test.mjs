// The device authorization names this computer, never magpie (#357):
// `vela login` 0.1.7 sends {cliVersion, host: os.Hostname(), profile} and
// stops when the name can't be read, so the plugin does the same.
import { test, expect, afterEach } from "bun:test"
import { hostname } from "node:os"
import { _internal as I } from "./index.mjs"

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

function record() {
  const sent = []
  globalThis.fetch = async (input, init) => {
    const headers = [...new Headers(init?.headers)].map(([k, v]) => `${k}: ${v}`).join("\n")
    sent.push({ text: `${input}\n${headers}\n${String(init?.body ?? "")}`, body: JSON.parse(String(init?.body ?? "{}")) })
    return Response.json({ deviceId: "d1", deviceSecret: "s1", userCode: "ABC123", activationUrl: "https://open-design.ai/cloud/cli/activate?deviceId=d1", pollIntervalSeconds: 2 }, { status: 201 })
  }
  return sent
}

test("the device authorization sends this computer's name and nothing naming magpie", async () => {
  expect(I.startDevice).toBeFunction()
  const sent = record()
  await I.startDevice()
  expect(sent.length).toBe(1)
  expect(sent[0].body.host).toBe(hostname())
  expect(sent[0].text.toLowerCase()).not.toContain("magpie")
})

test("a computer whose name can't be read stops, as the CLI does, and sends nothing", async () => {
  for (const host of [() => "", () => { throw new Error("no name") }]) {
    const sent = record()
    await expect(I.startDevice({ host })).rejects.toThrow("computer's name")
    expect(sent.length).toBe(0)
  }
})
