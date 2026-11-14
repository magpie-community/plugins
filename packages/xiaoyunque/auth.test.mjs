import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { beginLogin } from "./auth.mjs"

async function fixture(context) {
  const directory = await mkdtemp(join(tmpdir(), "xyq-auth-test-"))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const controller = new AbortController()
  context.after(() => controller.abort())
  const login = await beginLogin({ directory, signal: controller.signal })
  const url = new URL(login.url)
  const callback = url.searchParams.get("callback")
  const payload = {
    type: "access_key", access_key: "fake-callback-key", uid: "fake-user", token_id: "token-1",
    expired_at: Math.floor(Date.now() / 1000) + 300,
    random_secret_key: url.searchParams.get("random_secret_key"), source: "pippit-tool-cli", callback_url: callback,
  }
  const send = (body = payload, address = callback, origin = "https://www.xiaoyunque.com") =>
    fetch(address, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) })
  return { directory, controller, login, url, callback, payload, send }
}

test("official browser login validates callback, saves only device identity, and reuses token selector", async (context) => {
  const setup = await fixture(context)
  assert.equal(setup.url.pathname, "/cli/pippit-tool-login")
  assert.equal(setup.url.searchParams.get("auth_protocol"), "1")
  assert.equal(setup.url.searchParams.get("device_id").length, 43)
  const pending = setup.login.callback()
  assert.equal((await setup.send()).status, 200)
  const saved = await pending
  assert.equal(saved.key, "fake-callback-key")
  assert.equal(saved.metadata.uid, "fake-user")
  const identity = await readFile(join(setup.directory, "xiaoyunque", "device.json"), "utf8")
  assert.ok(!identity.includes("fake-callback-key"))
  const next = await beginLogin({ directory: setup.directory, signal: setup.controller.signal })
  assert.equal(new URL(next.url).searchParams.get("token_id"), "token-1")
  assert.equal(new URL(next.url).searchParams.get("device_id"), setup.url.searchParams.get("device_id"))
})

test("login refuses wrong origin, state, secret, callback and unknown fields", async (context) => {
  const setup = await fixture(context)
  assert.equal((await setup.send(undefined, undefined, "https://evil.example")).status, 403)
  assert.equal((await setup.send(undefined, setup.callback + "&state=wrong")).status, 400)
  for (const body of [
    { ...setup.payload, random_secret_key: "wrong" }, { ...setup.payload, callback_url: "http://127.0.0.1:1" },
    { ...setup.payload, unknown: "extra" }, { ...setup.payload, expired_at: 1 },
  ]) assert.equal((await setup.send(body)).status, 400)
})

test("official security query fields and PNA preflight are accepted, replay is refused", async (context) => {
  const setup = await fixture(context)
  const address = setup.callback + "&a_bogus=allowed&msToken=allowed"
  const preflight = await fetch(address, { method: "OPTIONS", headers: {
    origin: "https://xyq.jianying.com", "access-control-request-method": "POST",
    "access-control-request-headers": "content-type",
  } })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get("access-control-allow-private-network"), "true")
  assert.equal((await setup.send(undefined, address)).status, 200)
  assert.equal((await setup.send(undefined, address)).status, 409)
  await setup.login.callback()
})

test("callback cancellation closes listener", async (context) => {
  const setup = await fixture(context)
  const pending = setup.login.callback(undefined, { signal: setup.controller.signal })
  setup.controller.abort(new Error("cancelled"))
  await assert.rejects(pending, /cancelled/)
  await assert.rejects(setup.send())
})

test("oversized callback is rejected", async (context) => {
  const setup = await fixture(context)
  assert.equal((await setup.send({ ...setup.payload, access_key: "x".repeat(70_000) })).status, 413)
})
