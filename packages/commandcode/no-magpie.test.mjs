// magpie-community/plugins#352: Command Code was told "magpie" twice, as
// the Go catalog's User-Agent and as every /alpha/generate request's
// x-project-slug. Nothing that goes upstream names the app: the catalog is
// asked as the CLI asks it (Node's fetch, "node") and the slug is the
// working folder's name, as the CLI's (basename(cwd) || "root").
import { afterEach, expect, test } from "bun:test"
import { basename } from "node:path"
import { homedir } from "node:os"
import { CommandCodePlugin, _internal } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => {
  globalThis.fetch = real
  _internal.subsSeen.clear()
})

const finish = JSON.stringify({ type: "finish", finishReason: "stop", totalUsage: { inputTokens: 3, outputTokens: 1 } })

function record() {
  const sent = []
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined))
    const body = init.body == null ? "" : typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body)
    sent.push({ url, path: new URL(url).pathname, headers, body })
    const path = new URL(url).pathname
    if (path === "/alpha/generate") return new Response(JSON.stringify({ type: "text-delta", text: "hi" }) + "\n" + finish + "\n")
    if (path.endsWith("/models")) return Response.json({ data: [{ id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro" }] })
    if (path.startsWith("/provider/")) return Response.json({ choices: [] })
    return new Response("", { status: 404 })
  }
  return sent
}

// upstream is everything a request carries: its URL, every header's name
// and value, and its body
const upstream = (s) => [s.url, ...[...s.headers].flat(), s.body].join("\n")

async function chat(plan, dir) {
  const hooks = await CommandCodePlugin({ client: { auth: { set: async () => {} } } })
  const opts = await hooks.auth.loader(async () => ({ type: "api", key: "k", metadata: { plan } }))
  const headers = dir === undefined ? {} : { "x-magpie-work-dir": encodeURIComponent(dir), "x-magpie-work-git": "yes" }
  const res = await opts.fetch("https://api.commandcode.ai/provider/v1/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "deepseek/deepseek-v4-pro", messages: [{ role: "user", content: "hi" }] }),
  })
  await res.text()
}

test("no request to Command Code names magpie: Go, Provider API and the catalog (#352)", async () => {
  const sent = record()
  await chat("Go", "/Users/me/shop")
  await chat("Go")
  await chat("Pro", "/Users/me/shop")
  await _internal.goModels()
  expect(sent.some((s) => s.path === "/alpha/generate")).toBe(true)
  expect(sent.some((s) => s.path.endsWith("/models"))).toBe(true)
  for (const s of sent) expect(upstream(s)).not.toMatch(/magpie/i)
})

test("the project slug is the working folder's name, as the CLI's", async () => {
  const sent = record()
  await chat("Go", "/Users/me/shop")
  await chat("Go")
  const slugs = sent.filter((s) => s.path === "/alpha/generate").map((s) => s.headers.get("x-project-slug"))
  expect(slugs).toEqual(["shop", basename(homedir()) || "root"])
  expect(_internal.projectSlug("/")).toBe("root")
  expect(_internal.projectSlug("C:\\Users\\me\\proj")).toBe("proj")
  expect(_internal.projectSlug("/Users/me/café")).toBe("café")
  expect(_internal.projectSlug("/Users/me/项目")).toBe(encodeURIComponent("项目"))
})

test("the catalog is asked as the CLI's Node fetch asks it", async () => {
  const sent = record()
  await _internal.goModels()
  expect(sent.find((s) => s.path.endsWith("/models")).headers.get("user-agent")).toBe("node")
})
