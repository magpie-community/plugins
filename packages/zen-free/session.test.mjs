import assert from "node:assert/strict";
import test from "node:test";
import { opencodeID, realSessionID, sessionID } from "./provider.mjs";

const SHAPE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

// Decode an id the way OpenCode's identifier.ts lays it out.
function decode(id, descending) {
  let value = BigInt(`0x${id.slice(4, 16)}`);
  if (descending) value = ~value & 0xffffffffffffn;
  return { time: Number(value / 0x1000n), counter: Number(value % 0x1000n) };
}

test("a made-up session id is OpenCode's: descending, the time it was made, a small counter", () => {
  const before = Date.now();
  const id = sessionID(new Headers({ "x-session-id": "conversation-a" }), {});
  const after = Date.now();
  assert.match(id, SHAPE);
  assert.ok(realSessionID(id), id);
  const { time, counter } = decode(id, true);
  // OpenCode keeps 48 bits, so the time is Date.now() modulo 2^36.
  const wrap = 2 ** 36;
  assert.ok(time >= before % wrap && time <= after % wrap, `${time} not in ${before}..${after}`);
  assert.ok(counter >= 1 && counter < 16, `counter ${counter}`);
});

test("one conversation keeps one session, another gets its own", () => {
  const a1 = sessionID(new Headers({ "x-session-id": "conversation-b" }), {});
  const a2 = sessionID(new Headers({ "x-session-id": "conversation-b" }), {});
  const b = sessionID(new Headers({ "x-session-id": "conversation-c" }), {});
  assert.equal(a1, a2);
  assert.notEqual(a1, b);
  const body = { messages: [{ role: "user", content: "first question" }] };
  assert.equal(sessionID(new Headers(), body), sessionID(new Headers(), body));
});

test("OpenCode's own session id is passed through, a hash cut to its shape is not", () => {
  const real = "ses_ecc5d8f28ffe9Cy14V8Em7lI2u";
  assert.equal(sessionID(new Headers({ "x-opencode-session": real }), {}), real);
  // 0.1.4 sent this for "x-session-id: session_123"; Zen answers it 403.
  const hashed = "ses_e9283da055b15JwOAra76bwUx4";
  assert.equal(realSessionID(hashed), false);
  const sent = sessionID(new Headers({ "x-opencode-session": hashed }), {});
  assert.notEqual(sent, hashed);
  assert.ok(realSessionID(sent), sent);
});

test("ids made in one millisecond count up, as OpenCode's do", () => {
  const now = 1_790_000_000_000;
  const first = opencodeID("msg", false, now);
  const second = opencodeID("msg", false, now);
  assert.equal(decode(first, false).counter, 1);
  assert.equal(decode(second, false).counter, 2);
  assert.ok(second > first);
});
