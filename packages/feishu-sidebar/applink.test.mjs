import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const source = readFileSync(new URL("./page/applink.js", import.meta.url), "utf8")
const buildLink = new Function(source + "\nreturn buildFeishuLink")()

test("opens a Magpie Web URL with a path as an appCenter AppLink", () => {
  const { link } = buildLink(" https://magpie.example.test/panels/magpie%20web/ ")
  const url = new URL(link)
  expect(url.origin + url.pathname).toBe("https://applink.feishu.cn/client/web_url/open")
  expect(Object.fromEntries(url.searchParams)).toEqual({
    mode: "appCenter",
    url: "https://magpie.example.test/panels/magpie%20web/",
  })
})

test("allows Magpie Web on the desktop computer over loopback HTTP", () => {
  for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
    const address = `http://${host}:3430`
    expect(new URL(buildLink(address).link).searchParams.get("url")).toBe(address + "/")
  }
})

test("does not generate a shareable link from a sign-in URL or an unencrypted remote console", () => {
  for (const address of [
    "https://magpie.example.test/?k=example-access-key",
    "https://user:secret@magpie.example.test/",
    "https://magpie.example.test/#token",
  ]) expect(buildLink(address)).toEqual({ error: "plainAddress" })

  expect(buildLink("http://magpie.example.test:3430")).toEqual({ error: "https" })
  for (const address of ["javascript:alert(1)", "https:///example.test", "magpie.example.test", ""]) {
    expect(buildLink(address)).toEqual({ error: "invalid" })
  }
})
