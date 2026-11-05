// The China site's account API is on agent.minimaxi.com and on
// agent.minimax.cn, with the same tokens. When agent.minimaxi.com can't be
// reached at all (a TLS error: youyo.p_10001's "unable to get issuer
// certificate", plugins#757), the call goes once to agent.minimax.cn. An
// HTTP answer from agent.minimaxi.com — a 401, a 404, a 5xx, a business
// error in its body, a redirect — is the answer, and is never sent again.
//
// agent.minimaxi.com is played by a TLS server whose leaf was issued by an
// intermediate the client has never seen (testdata/leaf.pem, served alone),
// so its fetch fails the way the reporter's did; agent.minimax.cn by the
// usual fake.
import "./nonet.mjs"
import { afterEach, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { MiniMaxCodeAuthPlugin, MiniMaxCodeGlobalAuthPlugin, _internal } from "./index.mjs"
import { fakeMiniMax, json } from "./fake.mjs"

const td = join(import.meta.dir, "testdata")
let f, tls
afterEach(() => {
  tls?.stop(true)
  tls = undefined
  f?.close()
})

const auth = { type: "oauth", access: "tok", refresh: "r", expires: Date.now() + 3600_000, accountId: "a@example.com" }
const china = () => _internal.SITES["minimax-code"]

// a TLS server whose chain the client can't verify; seen counts what
// reached it over TLS (nothing should)
function untrusted() {
  const seen = []
  tls = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    tls: { cert: readFileSync(join(td, "leaf.pem"), "utf8"), key: readFileSync(join(td, "leaf.key"), "utf8") },
    fetch(req) {
      seen.push(new URL(req.url).pathname)
      return new Response("reached", { status: 500 })
    },
  })
  return { origin: `https://127.0.0.1:${tls.port}`, seen }
}

function account(f) {
  f.route("GET /v1/api/user/info", () => json({ statusInfo: { code: 0 }, data: { userInfo: { realUserID: "u-42", userEmail: "a@example.com" } } }))
  f.route("POST /matrix/api/v1/user/get_user_extra_info", () => json({ statusInfo: { code: 0 }, data: { workspaces: [] } }))
  f.route("POST /matrix/api/v1/commerce/get_membership_info", () => json({ base_resp: { status_code: 0 }, data: {} }))
}

test("the account card is read from agent.minimax.cn when agent.minimaxi.com's chain doesn't verify", async () => {
  f = fakeMiniMax()
  account(f)
  const bad = untrusted()
  china().agent = bad.origin
  const hooks = await MiniMaxCodeAuthPlugin({ client: {} })
  const u = await hooks.auth.usage(async () => auth)
  expect(u.error).toBeUndefined()
  expect(u.user).toBe("a@example.com")
  expect(f.seen.some((r) => r.path === "/v1/api/user/info")).toBe(true)
  expect(bad.seen).toEqual([])
})

test("the check-in is claimed on agent.minimax.cn when agent.minimaxi.com can't be reached", async () => {
  f = fakeMiniMax()
  const bad = untrusted()
  china().agent = bad.origin
  f.route("GET /minimax-cloud/api/v1/signin/status", () => json({ base_resp: { status_code: 0 }, data: { days: Array.from({ length: 7 }, (_, i) => ({ day_no: i + 1, points: 10, status: i === 0 ? 2 : 1, is_today: i === 0 })) } }))
  f.route("POST /minimax-cloud/api/v1/signin/claim", () => json({ base_resp: { status_code: 0 }, data: { claim_result: 1, points: 10 } }))
  const hooks = await MiniMaxCodeAuthPlugin({ client: { auth: { set: async () => {} } } })
  const c = await hooks.auth.checkin(async () => ({ ...auth, realUserID: "u-42" }))
  expect(c).toEqual({ outcome: "claimed", credit: 10, streak: 1 })
  expect(bad.seen).toEqual([])
  expect(f.seen.filter((r) => r.path === "/minimax-cloud/api/v1/signin/status").length).toBe(1)
})

test("a call both hosts fail names both", async () => {
  f = fakeMiniMax()
  const bad = untrusted()
  china().agent = bad.origin
  china().agentFallback = bad.origin.replace("127.0.0.1", "localhost")
  const hooks = await MiniMaxCodeAuthPlugin({ client: {} })
  const u = await hooks.auth.usage(async () => auth)
  expect(u.error).toMatch(/127\.0\.0\.1:\d+ couldn't be reached \(.+\), nor localhost:\d+ \(.+\)/)
  expect(u.signIn).toBe("kept")
})

// Each answer agent.minimaxi.com gives is the answer: the fallback host
// sees nothing.
for (const [name, reply] of [
  ["a 401", () => json({ error: "invalid access token" }, 401)],
  ["a 404", () => new Response("not found", { status: 404 })],
  ["a 502", () => new Response("bad gateway", { status: 502 })],
  ["a business error", () => json({ statusInfo: { code: 0 }, base_resp: { status_code: 1004, status_msg: "denied" } })],
  ["a redirect to another site", () => new Response(null, { status: 307, headers: { Location: "https://agent.minimax.io/v1/api/user/info" } })],
]) {
  test(`${name} from agent.minimaxi.com is not sent to agent.minimax.cn`, async () => {
    f = fakeMiniMax()
    const fb = fakeMiniMax()
    try {
      // fb is agent.minimax.cn; f plays agent.minimaxi.com
      china().agent = f.origin
      china().agentFallback = fb.origin
      f.route("GET /v1/api/user/info", reply)
      f.route("POST /oauth2/token", () => json({ error: "invalid_grant" }, 400))
      account(fb)
      const hooks = await MiniMaxCodeAuthPlugin({ client: {} })
      await hooks.auth.usage(async () => auth)
      expect(f.seen.some((r) => r.path === "/v1/api/user/info")).toBe(true)
      expect(fb.seen.filter((r) => r.path !== "/oauth2/token")).toEqual([])
    } finally {
      fb.close()
    }
  })
}

test("the international site has no fallback host", async () => {
  f = fakeMiniMax()
  const bad = untrusted()
  _internal.SITES["minimax-code-global"].agent = bad.origin
  const hooks = await MiniMaxCodeGlobalAuthPlugin({ client: {} })
  const u = await hooks.auth.usage(async () => auth)
  expect(u.error).toBeDefined()
  expect(u.error).not.toMatch(/nor /)
  expect(f.seen.filter((r) => r.path === "/v1/api/user/info")).toEqual([])
})
