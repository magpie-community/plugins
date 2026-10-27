import assert from "node:assert/strict";
import test from "node:test";
import { startOAuth } from "../src/oauth.ts";
import { fixture } from "./helpers.mjs";

test("browser OAuth uses PKCE S256, public registration, state and issuer checks", async (t) => {
  const f = await fixture(t);
  const login = await startOAuth(f.baseUrl, 1000);
  const authURL = new URL(login.url);
  assert.equal(authURL.searchParams.get("code_challenge_method"), "S256");
  const redirect = new URL(authURL.searchParams.get("redirect_uri"));
  redirect.searchParams.set("state", "wrong");
  redirect.searchParams.set("code", "wrong");
  assert.equal((await fetch(redirect)).status, 400);
  redirect.searchParams.set("state", authURL.searchParams.get("state"));
  redirect.searchParams.set("iss", "https://wrong.example");
  assert.equal((await fetch(redirect)).status, 400);
  const browser = await fetch(login.url);
  assert.equal(browser.status, 200);
  const response = await login.callback();
  assert.equal(response.type, "success");
  assert.equal(response.access, "test-access-0");
  assert.equal(response.refresh, "test-refresh-0");
  assert.equal(response.clientId, "test-public-client");
  assert.equal(f.state.grants, 1);
  assert.equal((await login.callback()).type, "failed");
  assert.equal(f.state.grants, 1);
});

test("declined consent and abandoned sign-ins finish without leaking tokens or callback listeners", async (t) => {
  const f = await fixture(t);
  f.state.decline = true;
  const declined = await startOAuth(f.baseUrl, 1000);
  await fetch(declined.url);
  assert.match((await declined.callback()).error, /declined/);
  const abandoned = await startOAuth(f.baseUrl, 40);
  assert.match((await abandoned.callback()).error, /timed out/);
  const redirect = new URL(abandoned.url).searchParams.get("redirect_uri");
  await assert.rejects(fetch(redirect));
});
