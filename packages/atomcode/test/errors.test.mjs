import { test } from "node:test";
import assert from "node:assert/strict";

import {
  FAILURE,
  annotateError,
  classifyError,
  isCredentialFailure,
  isTransientFailure,
  keptResponseHeaders,
} from "../errors.mjs";

test("classifyError separates credential, entitlement and generic 403s", () => {
  assert.equal(
    classifyError({ status: 403, message: "session token expired" }).category,
    FAILURE.CREDENTIAL_FORBIDDEN,
  );
  assert.equal(
    classifyError({ status: 403, message: "CodingPlan quota exhausted" }).category,
    FAILURE.ENTITLEMENT_FORBIDDEN,
  );
  const generic = classifyError({ status: 403, message: "Forbidden" });
  assert.equal(generic.category, FAILURE.FORBIDDEN);
  assert.equal(generic.refresh, false);
  assert.equal(generic.signInExpired, false);
});

test("classifyError maps transport, HTTP, signing and account-change failures", () => {
  assert.equal(
    classifyError(new TypeError("fetch failed")).category,
    FAILURE.NETWORK,
  );
  assert.equal(
    classifyError(Object.assign(new Error("aborted"), { name: "AbortError" })).category,
    FAILURE.TIMEOUT,
  );
  assert.equal(classifyError({ status: 401 }).category, FAILURE.UNAUTHORIZED);
  assert.equal(classifyError({ status: 429 }).category, FAILURE.RATE_LIMIT);
  assert.equal(classifyError({ status: 503 }).category, FAILURE.SERVER);
  assert.equal(
    classifyError(new Error("invalid X-AtomCode signature")).category,
    FAILURE.SIGNING,
  );
  assert.equal(
    classifyError(new Error("client version requires upgrade")).category,
    FAILURE.VERSION,
  );
  const changed = classifyError(new Error("auth.toml changed accounts"));
  assert.equal(changed.category, FAILURE.CLI_ACCOUNT_CHANGED);
  assert.equal(changed.signInExpired, true);
});

test("failure predicates are conservative", () => {
  assert.equal(isCredentialFailure({ status: 401 }), true);
  assert.equal(isCredentialFailure({ status: 403, message: "invalid token" }), true);
  assert.equal(isCredentialFailure({ status: 403, message: "usage limit" }), false);
  assert.equal(isTransientFailure({ status: 500 }), true);
  assert.equal(isTransientFailure({ status: 403 }), false);
});

test("annotateError fixes an incorrect expired mark and attaches status", () => {
  const entitlement = annotateError(
    Object.assign(new Error("quota exhausted"), {
      status: 403,
      signIn: "expired",
    }),
  );
  assert.equal(entitlement.category, FAILURE.ENTITLEMENT_FORBIDDEN);
  assert.equal(entitlement.signIn, undefined);

  const unauthorized = annotateError(new Error("no"));
  assert.equal(unauthorized.category, FAILURE.UNKNOWN);

  const credential = annotateError({ message: "invalid token", status: 403 });
  assert.equal(credential instanceof Error, true);
  assert.equal(credential.signIn, "expired");
});

test("403 entitlement responses are cloned with the kept sign-in header", async () => {
  const original = Response.json(
    { message: "quota exhausted" },
    { status: 403 },
  );
  const marked = keptResponseHeaders(original, {
    category: FAILURE.ENTITLEMENT_FORBIDDEN,
  });
  assert.notEqual(marked, original);
  assert.equal(marked.headers.get("x-magpie-sign-in"), "kept");
  assert.deepEqual(await marked.json(), { message: "quota exhausted" });

  const credential = new Response("{}", { status: 403 });
  assert.equal(
    keptResponseHeaders(credential, { category: FAILURE.CREDENTIAL_FORBIDDEN }),
    credential,
  );
  const ordinary = new Response("{}", { status: 401 });
  assert.equal(keptResponseHeaders(ordinary, { category: FAILURE.UNAUTHORIZED }), ordinary);
});
