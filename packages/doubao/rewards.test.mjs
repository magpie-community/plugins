// The claim engine's two pure decisions — "may I click this label" and "which
// stage is the client in" — plus its behaviour when no client is reachable.
// The DOM-driven parts run inside the webview and are exercised live; these
// tests pin the rules that must never drift.
import { describe, expect, test } from "bun:test"

import { claimRewards, mayClick, DAILY_SIGNIN_LABELS } from "./lib/rewards.mjs"
import { diagnoseClient, installInfo, stageLabel } from "./lib/client-status.mjs"

describe("mayClick", () => {
  test("claim-shaped labels pass", () => {
    for (const t of ["立即签到", "签到", "领取奖励", "领取 100 额度", "领取 1,000 额度", "额外领 200 点额度"]) {
      expect([t, mayClick(t)]).toEqual([t, true])
    }
  })

  test("work-first labels never pass", () => {
    for (const t of ["去完成", "立即参与", "立即领", "用豆包试试看", "复制链接", "去下载"]) {
      expect([t, mayClick(t)]).toEqual([t, false])
    }
  })

  // The hero banner's CTA reads 立即领取 and pays nothing; the reward cards read
  // 领取奖励. They must not be confused.
  test("the hero banner's 立即领取 is not a claim", () => {
    expect(mayClick("立即领取")).toBe(false)
  })

  test("a daily-only whitelist excludes milestone claims", () => {
    expect(mayClick("立即签到", DAILY_SIGNIN_LABELS)).toBe(true)
    expect(mayClick("额外领 200 点额度", DAILY_SIGNIN_LABELS)).toBe(false)
  })

  test("empty and whitespace labels are refused", () => {
    expect(mayClick("")).toBe(false)
    expect(mayClick("   ")).toBe(false)
    expect(mayClick(undefined)).toBe(false)
  })
})

describe("claimRewards without a reachable client", () => {
  test("reports cdp-not-reachable instead of throwing", async () => {
    const r = await claimRewards({ port: 9, autoLaunch: false, timeoutMs: 500 })
    expect(r.clientFound).toBe(false)
    expect(r.error).toBe("cdp-not-reachable")
    expect(r.clicked).toEqual([])
    expect(r.clickedCodes).toEqual([])
  })
})

describe("diagnoseClient", () => {
  test("names one of the four stages, with a port and an actionable fix", async () => {
    const d = await diagnoseClient({ port: 9 })
    expect(["not-installed", "not-running", "running-no-debug", "ready"]).toContain(d.stage)
    expect(d.port).toBe(9)
    expect(typeof d.hint).toBe("string")
    expect(d.hint.length).toBeGreaterThan(0)
    if (d.stage === "ready") expect(d.fix).toBeNull()
    else expect(typeof d.fix).toBe("string")
    // Every stage has a human label, so a panel row never shows raw English.
    expect(stageLabel(d.stage)).not.toBe(d.stage)
  })

  test("installInfo survives a machine with no Doubao at all", () => {
    const i = installInfo({ fresh: true })
    expect(typeof i.installed).toBe("boolean")
    expect(typeof i.browser.installed).toBe("boolean")
    if (!i.installed) {
      expect(i.appPath).toBeNull()
      expect(i.version).toBe("")
    }
  })
})
