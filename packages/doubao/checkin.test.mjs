// The hooks as magpie calls them: check-in, the board's usage reading, and the
// account's info — against a local server that answers the way Doubao does.
// Nothing reaches doubao.com; the cookie is a made-up string.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { DoubaoAuthPlugin, _internal } from "./index.mjs"

let server
let got = []
let answer = null
let stateDir

const realFetch = globalThis.fetch
const HOST = "https://www.doubao.com"

// Every request the plugin makes lands here instead, whatever host it named.
function routeToFake() {
  globalThis.fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    if (!url.startsWith(HOST + "/")) throw new Error("no network in tests: " + url)
    return realFetch(`http://127.0.0.1:${server.port}/${url.slice(HOST.length + 1)}`, init)
  }
}

const COOKIE = "sessionid=abc; sessionid_ss=def; passport_csrf_token=csrf1"

// getAuth, as the host gives it: the same object every call.
const auth = (extra = {}) => async () => ({ type: "api", key: COOKIE, ...extra })

async function hooks() {
  return DoubaoAuthPlugin({ client: { app: { log: async () => {} } }, directory: process.cwd() })
}

// A campaign detail body with or without a check-in task.
function detail({ checkedIn = false, days = 3, credits = 1200, task = true, milestones = [], tasks = [] } = {}) {
  return {
    code: 0,
    data: {
      progress: { total_amount: credits },
      tasks: task
        ? [{
            campaign_code: "daily_signin",
            task_kind: "daily_signin",
            task_status: checkedIn ? 3 : 1,
            title: "每日签到",
            daily_checkin: {
              checked_in_today: checkedIn,
              continuous_days: days,
              last_checkin_date: "2026-10-31",
              reward: { reward_amount: 200 },
            },
          }, ...tasks]
        : tasks,
      milestones,
    },
  }
}

beforeAll(() => {
  stateDir = mkdtempSync(join(tmpdir(), "doubao-state-"))
  // The ledger lives where this env var says, so a test never touches the
  // real ~/.config/magpie/doubao-state.json.
  process.env.MAGPIE_DOUBAO_STATE = join(stateDir, "state.json")
  // The built-in auto check-in attaches to a real desktop client over CDP.
  // Point it at a port nothing listens on and forbid launching a GUI, so the
  // suite is deterministic on a developer machine that happens to run Doubao.
  process.env.DOUBAO_CDP_PORT = "9"
  process.env.DOUBAO_CLIENT_AUTOLAUNCH = "0"
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      got.push({ path: url.pathname, headers: Object.fromEntries(req.headers), body: await req.text() })
      if (answer) return answer(req, url)
      return Response.json({ code: 0, data: {} })
    },
  })
})

afterAll(() => {
  server?.stop(true)
  globalThis.fetch = realFetch
  rmSync(stateDir, { recursive: true, force: true })
  delete process.env.MAGPIE_DOUBAO_STATE
  delete process.env.DOUBAO_CDP_PORT
  delete process.env.DOUBAO_CLIENT_AUTOLAUNCH
})

beforeEach(() => {
  routeToFake()
  got = []
  answer = null
  rmSync(process.env.MAGPIE_DOUBAO_STATE, { force: true })
})

afterEach(() => {
  globalThis.fetch = realFetch
})

// ---------------------------------------------------------------------------
// checkin
// ---------------------------------------------------------------------------

describe("auth.checkin", () => {
  test("no cookie is a failure that names the reason", async () => {
    const h = await hooks()
    const r = await h.auth.checkin(async () => ({ type: "api", key: "" }))
    expect(r.outcome).toBe("failed")
    expect(r.message).toContain("Cookie")
  })

  // A client that is not reachable yet must NOT settle the day (that would
  // silently skip today's credit): the answer stays retryable so the host comes
  // back in 30 minutes. Only after the daily cap does it settle.
  test("an unchecked account with no reachable client stays retryable, then settles at the cap", async () => {
    const h = await hooks()
    answer = (req, url) => {
      if (url.pathname.includes("/detail/")) return Response.json(detail({ checkedIn: false, days: 3 }))
      return Response.json({ code: 0, data: { reward_amount: 200, continuous_days: 4 } })
    }
    const first = await h.auth.checkin(auth())
    expect(first.outcome).toBe("failed")
    expect(first.message).toContain("客户端")
    // No `until`: a failed answer is what makes the host retry.
    expect(first.until).toBeUndefined()

    let last = first
    for (let i = 0; i < 3; i++) last = await h.auth.checkin(auth())
    expect(last.outcome).toBe("ineligible")
    expect(Date.parse(last.until)).toBeGreaterThan(Date.now())
  })

  // Verified live 2026-11-01: since the campaign moved into the desktop client,
  // the check-in endpoint answers 710010702 "系统错误" to every external caller.
  // The plugin therefore never posts it — the claim happens inside the client.
  // What is retried here is *reaching the client*, not hammering the endpoint.
  test("a client that never becomes reachable settles the day after four tries, without posting checkin", async () => {
    const h = await hooks()
    answer = (req, url) => {
      if (url.pathname.includes("/detail/")) return Response.json(detail({ checkedIn: false }))
      throw new Error("the check-in endpoint must never be posted from outside the client")
    }
    let last
    for (let i = 0; i < 4; i++) last = await h.auth.checkin(auth())
    expect(last.outcome).toBe("ineligible")
    expect(last.message).toContain("客户端")
    expect(Date.parse(last.until)).toBeGreaterThan(Date.now())
    expect(got.filter((g) => g.path.includes("/checkin"))).toHaveLength(0)
  })

  test("an already-checked day is done, and claims nothing", async () => {
    const h = await hooks()
    answer = (req, url) => {
      if (url.pathname.includes("/detail/")) return Response.json(detail({ checkedIn: true, days: 5 }))
      throw new Error("checkin must not be posted when the day is already signed")
    }
    const r = await h.auth.checkin(auth())
    expect(r.outcome).toBe("done")
    expect(r.streak).toBe(5)
    expect(got.filter((g) => g.path.includes("/checkin"))).toHaveLength(0)
  })

  // The page's reward cards carry data-reward-code, and the detail API's
  // campaign_code is the same string (verified live 2026-11-02). Keeping the
  // code on the parsed milestone is what lets the claim engine target that
  // card instead of scanning page-wide text.
  test("milestones keep the campaign code the page cards use", async () => {
    answer = () => Response.json(detail({
      checkedIn: true,
      credits: 900,
      milestones: [
        { campaign_code: "points_milestone_500", task_kind: "points_milestone", task_status: 2, milestone_threshold: 500, reward_summaries: [{ reward_amount: 200 }], title: "累计 500 点额度" },
        { campaign_code: "points_milestone_2000", task_kind: "points_milestone", task_status: 1, milestone_threshold: 2000, reward_summaries: [{ reward_amount: 300 }], title: "累计 2000 点额度" },
      ],
    }))
    const st = await _internal.fetchDoubaoStatus(COOKIE, "acct-code", "uid-1")
    expect(st.auth).toBe(true)
    expect(st.milestones[0]).toMatchObject({ code: "points_milestone_500", threshold: 500, status: 2, reward: 200 })
    expect(st.milestones[1]).toMatchObject({ code: "points_milestone_2000", status: 1, reward: 300 })
    expect(_internal.claimableCredit(st)).toBe(200)
  })

  // "已签到" must not settle the day when credit is already earned and only
  // waits to be collected — that would silently drop the grant until tomorrow.
  test("a signed day with an unclaimed milestone stays open and goes to the client", async () => {
    const h = await hooks()
    answer = () => Response.json(detail({
      checkedIn: true,
      credits: 900,
      milestones: [
        { campaign_code: "points_milestone_500", task_kind: "points_milestone", task_status: 2, milestone_threshold: 500, reward_summaries: [{ reward_amount: 200 }], title: "累计 500 点额度" },
      ],
    }))
    const r = await h.auth.checkin(auth())
    expect(r.outcome).not.toBe("done")
    // Earned-but-uncollected credit is never written off: the answer stays
    // retryable until the client is reachable (or the daily cap is reached).
    expect(r.outcome).toBe("failed")
    expect(r.message).toContain("客户端")
    expect(r.until).toBeUndefined()
  })

  test("a summary of the milestone grant lands in diffClaims", () => {
    const before = { checkin: { checkedIn: false, rewardAmount: 200 }, milestones: [{ code: "points_milestone_500", threshold: 500, status: 2, reward: 200, title: "累计 500 点额度" }] }
    const after = { checkin: { checkedIn: true, rewardAmount: 200 }, milestones: [{ code: "points_milestone_500", threshold: 500, status: 3, reward: 200, title: "累计 500 点额度" }] }
    const got = _internal.diffClaims(before, after)
    expect(got).toHaveLength(2)
    expect(got.reduce((s, g) => s + g.credit, 0)).toBe(400)
  })

  test("claimed/idempotent replies are no longer reachable — external callers never get a claim", async () => {
    const h = await hooks()
    answer = (req, url) => {
      if (url.pathname.includes("/detail/")) return Response.json(detail({ checkedIn: false }))
      return Response.json({ code: 0, data: { idempotent: true } })
    }
    // The point is that an outside POST can never produce `claimed`: without a
    // reachable client the answer is retryable, never a fake success.
    expect((await h.auth.checkin(auth())).outcome).toBe("failed")
  })

  test("an account with no campaign task is ineligible, and still settles", async () => {
    const h = await hooks()
    answer = () => Response.json(detail({ task: false }))
    const r = await h.auth.checkin(auth())
    expect(r.outcome).toBe("ineligible")
    expect(Date.parse(r.until)).toBeGreaterThan(Date.now())
  })

  test("a dead session is failed, and remembered for the day", async () => {
    const h = await hooks()
    answer = () => Response.json({ code: 710012001, msg: "登录已过期" })
    const r = await h.auth.checkin(auth())
    expect(r.outcome).toBe("failed")
    expect(r.message).toContain("失效")

    // a second call spends no request at all: the ledger already knows
    got = []
    const again = await h.auth.checkin(auth())
    expect(again.outcome).toBe("failed")
    expect(got).toHaveLength(0)
  })

  test("403 is read as a dead session too", async () => {
    const h = await hooks()
    answer = () => new Response("{}", { status: 403 })
    expect((await h.auth.checkin(auth())).message).toContain("失效")
  })

  test("an html login page is a dead session, not an empty task list", async () => {
    const h = await hooks()
    answer = () => new Response("<html>请重新登录</html>", { status: 200, headers: { "content-type": "text/html" } })
    expect((await h.auth.checkin(auth())).message).toContain("失效")
  })

  test("a 500 stays retryable: it is not the credential's fault", async () => {
    const h = await hooks()
    answer = () => new Response("", { status: 500 })
    const r = await h.auth.checkin(auth())
    expect(r.outcome).toBe("failed")
    expect(r.until).toBeUndefined()
  })

  test("a network error says the request failed, not that the session did", async () => {
    const h = await hooks()
    globalThis.fetch = () => Promise.reject(new Error("ECONNRESET"))
    const r = await h.auth.checkin(auth())
    expect(r.outcome).toBe("failed")
    expect(r.message).toContain("ECONNRESET")
  })

  test("the cookie goes upstream whole, never split or trimmed", async () => {
    const h = await hooks()
    answer = () => Response.json(detail({ checkedIn: true }))
    await h.auth.checkin(auth())
    expect(got[0].headers.cookie).toBe(COOKIE)
  })

  test("a bare jwt is sent as sessionid, the cookie the session lives in", async () => {
    const h = await hooks()
    answer = () => Response.json(detail({ checkedIn: true }))
    await h.auth.checkin(auth({ key: "eyJhbGciOi.payload.sig" }))
    expect(got[0].headers.cookie).toBe("sessionid=eyJhbGciOi.payload.sig")
  })

  test("the browser's own headers go with it", async () => {
    const h = await hooks()
    answer = () => Response.json(detail({ checkedIn: true }))
    await h.auth.checkin(auth())
    expect(got[0].headers["user-agent"]).toContain("DoubaoDesktop")
    expect(got[0].headers.referer).toContain("doubao.com")
  })
})

// ---------------------------------------------------------------------------
// usage — the board's card
// ---------------------------------------------------------------------------

describe("auth.usage", () => {
  test("the card carries the plan, a balance window, and the sign-in state", async () => {
    const h = await hooks()
    answer = () => Response.json(detail({ checkedIn: false, credits: 1200 }))
    const u = await h.auth.usage(auth())
    expect(u.plan).toBe("Web 体验额度")
    expect(u.signIn).toBe("kept")
    const credits = u.windows.find((w) => w.name === "体验额度")
    expect(credits.balance).toBe(1200)
    expect(credits.unit).toBe("credits")
    // the daily task rides beside it, so the board shows both readings
    expect(u.windows.some((w) => w.name === "今日签到")).toBe(true)
  })

  test("a signed day shows the task as used", async () => {
    const h = await hooks()
    answer = () => Response.json(detail({ checkedIn: true }))
    const u = await h.auth.usage(auth())
    expect(u.windows.find((w) => w.name === "今日签到").used).toBe(100)
  })

  test("an unsigned day shows it as open", async () => {
    const h = await hooks()
    answer = () => Response.json(detail({ checkedIn: false }))
    const u = await h.auth.usage(auth())
    expect(u.windows.find((w) => w.name === "今日签到").used).toBe(0)
  })

  test("a dead session is reported, never thrown", async () => {
    const h = await hooks()
    answer = () => Response.json({ code: 710012001, msg: "登录已过期" })
    const u = await h.auth.usage(auth())
    expect(u.signIn).toBe("expired")
    expect(u.error).toBeTruthy()
    expect(u.windows).toEqual([])
  })

  test("no cookie answers an error rather than an empty card", async () => {
    const h = await hooks()
    const u = await h.auth.usage(async () => ({ type: "api", key: "" }))
    expect(u.error).toBe("not signed in")
  })

  test("a reached balance of zero is a reading, not a failure", async () => {
    const h = await hooks()
    answer = () => Response.json(detail({ credits: 0 }))
    const u = await h.auth.usage(auth())
    const w = u.windows.find((x) => x.name === "体验额度")
    expect(w.balance).toBe(0)
    expect(u.error).toBeUndefined()
  })

  test("the card names when it rolls over", async () => {
    const h = await hooks()
    answer = () => Response.json(detail({}))
    const u = await h.auth.usage(auth())
    expect(Date.parse(u.until)).toBeGreaterThan(Date.now())
  })
})

// ---------------------------------------------------------------------------
// cooldown
// ---------------------------------------------------------------------------

describe("cooldown", () => {
  test("a 429 makes a cooldown, and the next call spends no request", async () => {
    const h = await hooks()
    answer = () => new Response("", { status: 429, headers: { "retry-after": "120" } })
    const first = await h.auth.checkin(auth())
    expect(first.outcome).toBe("failed")
    got = []
    const second = await h.auth.checkin(auth())
    expect(second.message).toContain("限流")
    expect(got).toHaveLength(0)
  })

  test("the cooldown is per account, not global", async () => {
    const h = await hooks()
    answer = () => new Response("", { status: 429, headers: { "retry-after": "120" } })
    await h.auth.checkin(auth({ uid: "u1" }))
    got = []
    // a different account is not punished for the first one's 429
    answer = () => Response.json(detail({ checkedIn: true }))
    const r = await h.auth.checkin(auth({ uid: "u2" }))
    expect(r.outcome).toBe("done")
    expect(got.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// getInfo
// ---------------------------------------------------------------------------

describe("auth.getInfo", () => {
  test("it answers the account's plan without a card", async () => {
    const h = await hooks()
    answer = () => Response.json(detail({ checkedIn: true }))
    const i = await h.auth.getInfo({ type: "api", key: COOKIE })
    expect(i.plan).toBe("Web 体验额度")
    expect(i.signIn).toBe("kept")
  })

  test("no cookie is an error, not an empty plan", async () => {
    const h = await hooks()
    const i = await h.auth.getInfo({ type: "api", key: "" })
    expect(i.error).toBe("not signed in")
  })
})

// ---------------------------------------------------------------------------
// config / provider — what the host is told about the models
// ---------------------------------------------------------------------------

describe("config and provider", () => {
  test("config registers the provider with an Anthropic-shaped npm package", async () => {
    const h = await hooks()
    const cfg = { provider: {} }
    await h.config(cfg)
    expect(cfg.provider.doubao.npm).toBe("@ai-sdk/anthropic")
    expect(cfg.provider.doubao.api).toContain("doubao.com")
    expect(Object.keys(cfg.provider.doubao.models).length).toBeGreaterThan(0)
  })

  test("a user's own models are kept, not overwritten", async () => {
    const h = await hooks()
    const cfg = { provider: { doubao: { models: { mine: { name: "Mine" } } } } }
    await h.config(cfg)
    expect(cfg.provider.doubao.models.mine).toBeDefined()
    expect(cfg.provider.doubao.models["doubao-auto"]).toBeDefined()
  })

  test("both modes are listed, and only one reasons", async () => {
    const h = await hooks()
    const m = h.provider.models
    expect(Object.keys(m)).toEqual(["doubao-auto", "doubao-2.1-lite", "doubao-2.1-pro", "doubao-2.1-pro-deep"])
    expect(m["doubao-auto"].reasoning).toBe(false)
    expect(m["doubao-2.1-pro-deep"].reasoning).toBe(true)
  })

  test("the concurrency the host queues by is declared", async () => {
    const h = await hooks()
    expect(h.auth.maxConcurrency).toBe(1)
  })

  test("every model says its limits and modalities, so an agent can plan", async () => {
    const h = await hooks()
    for (const m of Object.values(h.provider.models)) {
      expect(m.limit.context).toBeGreaterThan(0)
      expect(m.limit.output).toBeGreaterThan(0)
      expect(m.modalities.input).toEqual(["text"])
      expect(m.cost).toBeDefined()
    }
  })
})
