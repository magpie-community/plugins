// The browser launch arguments and the document.cookie reader. These are the
// pure pieces of the browser layer — everything else needs a process or a
// profile directory, which the e2e (fake-browser) suite covers.
import "./nonet.mjs"
import { describe, expect, test } from "bun:test"
import { browserArgs, readConsoleCookie } from "./lib/browser.mjs"

describe("browserArgs", () => {
  test("the profile travels as --user-data-dir (the kill sweep's anchor)", () => {
    const args = browserArgs("C:\\p\\moss-browser", 0, "https://platform.mosi.cn/", { cdp: false, login: true })
    expect(args[0]).toBe("--user-data-dir=C:\\p\\moss-browser")
    // the login window never carries a debug port: the WAF refuses CDP windows
    expect(args.join(" ")).not.toContain("remote-debugging")
  })

  test("a CDP session binds the debug port to loopback only", () => {
    const args = browserArgs("/tmp/profile", 9222, "https://platform.mosi.cn/", { headless: true })
    expect(args).toContain("--remote-debugging-port=9222")
    expect(args).toContain("--remote-debugging-address=127.0.0.1")
    expect(args[0]).toBe("--headless=new")
  })

  test("the headless renewal keeps the privacy switches, the login window does not", () => {
    const renewal = browserArgs("/p", 0, "https://platform.mosi.cn/", { headless: true }).join(" ")
    const login = browserArgs("/p", 0, "https://platform.mosi.cn/", { cdp: false, login: true }).join(" ")
    expect(renewal).toContain("--disable-background-networking")
    expect(renewal).toContain("--disable-sync")
    expect(login).not.toContain("--disable-sync")
    expect(login).not.toContain("--disable-background-networking")
  })
})

describe("readConsoleCookie", () => {
  test("reads the session value from a document.cookie string, url-decoded", () => {
    expect(readConsoleCookie("moss_studio_prod_access_token=a%2Fb")).toBe("a/b")
    expect(readConsoleCookie("other=1; moss_studio_prod_access_token=tok")).toBe("tok")
  })

  test("accepts the alternate deployment cookie name and refuses unknown cookies", () => {
    expect(readConsoleCookie("moss_studio_access_token=zzz")).toBe("zzz")
    expect(readConsoleCookie("session=abc")).toBe("")
    expect(readConsoleCookie("")).toBe("")
  })
})
