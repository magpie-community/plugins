// The organization an account's models are asked under (#232, ReneXiong):
// Zed's default organization can be one without a subscription while
// another (the personal one, on a Student plan) has one. Zed's editor lets
// the user switch to it (title_bar.rs → user.rs set_current_organization);
// the plugin has no switcher, so it picks the one with a plan, and moves a
// sign-in saved under the wrong one when Zed answers 402.
import { afterEach, expect, test } from "bun:test"
import crypto from "node:crypto"
import { ZedAuthPlugin, _internal } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => {
  globalThis.fetch = real
  _internal.tokens.clear()
  _internal.lists.clear()
  _internal.picked.clear()
})

// the reporter's /client/users/me, as the issue gives it sanitized: the
// personal organization has the Student plan, the default one none
const reporter = (over = {}) => ({
  user: { legacy_user_id: 77, github_login: "rene" },
  organizations: [
    { id: "org-personal", name: "rene", is_personal: true },
    { id: "org-team", name: "Some Team", is_personal: false },
  ],
  default_organization_id: "org-team",
  plans_by_organization: { "org-personal": "zed_student" },
  plan: { plan_v3: "zed_student" },
  ...over,
})

const orgs = (...ids) => ids.map((id) => ({ id, name: id, is_personal: id.startsWith("personal") }))

test("the reporter's account: the personal organization with the Student plan, not the default without one", () => {
  expect(_internal.orgOf(reporter())).toBe("org-personal")
  // and its plan is that organization's, not the account's in its place
  expect(_internal.planOf(reporter(), "org-team")).toBe("")
  expect(_internal.planOf(reporter(), "org-personal")).toBe("zed_student")
})

test("a default organization with a plan is kept, as Zed picks it", () => {
  const me = { organizations: orgs("personal", "biz"), default_organization_id: "biz", plans_by_organization: { personal: "zed_pro", biz: "zed_business" } }
  expect(_internal.orgOf(me)).toBe("biz")
})

test("an organization the sign-in saved is kept while it has a plan, over the default", () => {
  const me = { organizations: orgs("personal", "biz"), default_organization_id: "biz", plans_by_organization: { personal: "zed_pro", biz: "zed_business" } }
  expect(_internal.orgOf(me, "personal")).toBe("personal")
  // it lost its plan: the default, which has one
  me.plans_by_organization = { biz: "zed_business" }
  expect(_internal.orgOf(me, "personal")).toBe("biz")
  // it is gone from the account
  expect(_internal.orgOf({ ...me, organizations: orgs("biz") }, "personal")).toBe("biz")
})

test("with the default unsubscribed: the personal organization with a plan first, then any with one", () => {
  const me = { organizations: orgs("team-a", "team-b", "personal"), default_organization_id: "team-a", plans_by_organization: { "team-b": "zed_business", personal: "zed_pro" } }
  expect(_internal.orgOf(me)).toBe("personal")
  me.plans_by_organization = { "team-b": "zed_business", personal: "zed_free" }
  expect(_internal.orgOf(me)).toBe("team-b")
})

test("an organization with Zed's hosted models turned off isn't picked over one that has them", () => {
  const me = {
    organizations: orgs("team-a", "team-b"),
    default_organization_id: "team-a",
    plans_by_organization: { "team-a": "zed_business", "team-b": "zed_business" },
    configuration_by_organization: { "team-a": { is_zed_model_provider_enabled: false } },
  }
  expect(_internal.orgOf(me)).toBe("team-b")
})

test("no organization with a plan: what Zed picks, the saved one first", () => {
  const me = { organizations: orgs("personal", "team"), default_organization_id: "team", plans_by_organization: { personal: "zed_free" } }
  expect(_internal.orgOf(me)).toBe("team")
  expect(_internal.orgOf(me, "personal")).toBe("personal")
  expect(_internal.orgOf({ organizations: orgs("a", "b") })).toBe("a")
  // a reply without organizations names the plan of the account itself
  expect(_internal.planOf({ plan: { plan_v3: "zed_pro" } }, "")).toBe("zed_pro")
})

// a fake cloud.zed.dev: /client/users/me answers me; a model token names
// the organization it was minted for, and /models and /completions refuse
// one minted for an organization without a plan with Zed's 402
function cloud(me) {
  const seen = []
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(String(url)).pathname
    const auth = init.headers?.Authorization ?? ""
    if (path === "/client/users/me") {
      seen.push(path)
      return Response.json(me)
    }
    if (path === "/client/llm_tokens") {
      const org = JSON.parse(init.body).organization_id
      seen.push(path + " " + org)
      return Response.json({ token: "tok-" + org })
    }
    const org = auth.replace(/^Bearer tok-/, "")
    seen.push(path + " " + org)
    if (!me.plans_by_organization?.[org]) return Response.json({ code: "payment_required", message: "Organization does not have an active subscription." }, { status: 402 })
    if (path === "/models") return Response.json({ models: [{ provider: "anthropic", id: "claude-sonnet-5", display_name: "Claude Sonnet 5", max_token_count: 1000, max_output_tokens: 100 }] })
    if (path === "/completions") {
      const lines = [
        { status: "started" },
        { event: { type: "message_start", message: { id: "m", type: "message", role: "assistant", content: [], model: "claude-sonnet-5", usage: { input_tokens: 1, output_tokens: 0 } } } },
        { event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
        { event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } } },
        { event: { type: "content_block_stop", index: 0 } },
        { event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } } },
        { event: { type: "message_stop" } },
        { status: "stream_ended" },
      ]
      return new Response(lines.map((l) => JSON.stringify(l)).join("\n") + "\n", { headers: { "x-zed-server-supports-status-messages": "true" } })
    }
    return new Response("", { status: 404 })
  }
  return seen
}

// a sign-in saved before #232: under the default organization, which has no plan
const savedUnder = (org, uid = "77") => ({
  type: "oauth",
  access: "plain-access-" + uid,
  refresh: JSON.stringify({ userId: uid, systemId: "", org, plan: "zed_student", planName: "Student", login: "rene" }),
  expires: 0,
  accountId: "rene",
})

test("sign-in: the model token is minted for the organization with the plan, and that one is saved", async () => {
  const seen = cloud(reporter())
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 })
  const ct = crypto.publicEncrypt({ key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from("plain-access-s")).toString("base64url")
  const out = await _internal.signedInWith(privateKey, "78", ct, "sys")
  expect(out.type).toBe("success")
  expect(JSON.parse(out.refresh)).toMatchObject({ org: "org-personal", plan: "zed_student", planName: "Student" })
  expect(seen).toEqual(["/client/users/me", "/client/llm_tokens org-personal", "/models org-personal"])
})

test("a sign-in saved under the unsubscribed default: the 402 moves it, the list is read, and the move is saved", async () => {
  const seen = cloud(reporter())
  const saved = []
  const hooks = await ZedAuthPlugin({ client: { auth: { set: async (x) => saved.push(x.body) } } })
  const a = savedUnder("org-team")
  const models = await hooks.provider.models({ models: {} }, { auth: a })
  expect(Object.keys(models)).toEqual(["claude-sonnet-5"])
  expect(seen).toEqual(["/client/llm_tokens org-team", "/models org-team", "/client/users/me", "/client/llm_tokens org-personal", "/models org-personal"])
  expect(saved.length).toBe(1)
  expect(JSON.parse(saved[0].refresh)).toMatchObject({ userId: "77", org: "org-personal", plan: "zed_student", login: "rene" })
  // the next request goes under it, even when the save didn't reach the sign-in
  expect(_internal.stateOf(a).org).toBe("org-personal")
  expect(_internal.stateOf(saved[0]).org).toBe("org-personal")
})

test("a request under the unsubscribed default: moved once, answered under the organization with the plan", async () => {
  const seen = cloud(reporter())
  const s = _internal.stateOf(savedUnder("org-team", "79"))
  const res = await _internal.complete(s, "https://cloud.zed.dev/v1/messages", {
    method: "POST",
    body: JSON.stringify({ model: "claude-sonnet-5", stream: false, max_tokens: 10, messages: [{ role: "user", content: "hi" }] }),
  })
  expect(res.status).toBe(200)
  expect((await res.json()).content).toEqual([{ type: "text", text: "hi" }])
  expect(seen).toEqual(["/client/llm_tokens org-team", "/completions org-team", "/client/users/me", "/client/llm_tokens org-personal", "/completions org-personal"])
})

test("no organization with a plan: the 402 is answered, after one read of the account", async () => {
  const me = reporter({ plans_by_organization: {} })
  const seen = cloud(me)
  const s = _internal.stateOf(savedUnder("org-team", "80"))
  const res = await _internal.complete(s, "https://cloud.zed.dev/v1/messages", {
    method: "POST",
    body: JSON.stringify({ model: "claude-sonnet-5", stream: false, max_tokens: 10, messages: [{ role: "user", content: "hi" }] }),
  })
  expect(res.status).toBe(402)
  expect(seen).toEqual(["/client/llm_tokens org-team", "/completions org-team", "/client/users/me"])
})

test("the plan card: the organization with the plan, picked again and saved, not the account's plan shown over the wrong one", async () => {
  cloud(reporter())
  const saved = []
  const hooks = await ZedAuthPlugin({ client: { auth: { set: async (x) => saved.push(x.body) } } })
  const u = await hooks.auth.usage(async () => savedUnder("org-team", "81"))
  expect(u.plan).toBe("Student")
  expect(saved.length).toBe(1)
  expect(JSON.parse(saved[0].refresh)).toMatchObject({ org: "org-personal", plan: "zed_student" })
})
