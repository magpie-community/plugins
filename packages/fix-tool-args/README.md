# fix-tool-args

magpie gateway middleware: repairs tool-call arguments a vendor streams as
invalid JSON, before the agent client parses them.

Some models — small and free ones especially; xfyun `spark-x2.6` is the
confirmed case — drop the quotes around a string value while streaming a
tool call's arguments:

```
{"pattern":**/*fd86512e*}
```

A strict client (pi-ai, which DeepSeek Harness embeds) parses that at
`message_stop`, throws `tool input is invalid JSON`, classifies it
`MALFORMED_RESPONSE` — which is not retryable — and **the whole turn is
lost**, tool call and text alike. The failure is intermittent (a sampling
artifact), so it surfaces as random lost turns in long sessions.

This middleware holds a tool call's argument fragments as they stream,
and at the chunk carrying `finish_reason` emits them as one whole call:

- the joined arguments, when they already parse as a JSON object;
- else a conservative repair, when the repair parses:
  - a bare **key** (a run in an object's key slot that a `:` follows)
    is quoted: `{pattern:**/*x*}` → `{"pattern":"**/*x*"}`;
  - a bare **value** (a run in a value slot that starts like no JSON
    value) is quoted up to the next structural character — colons and
    internal spaces belong to it: `{"path":C:/x y}` → `{"path":"C:/x y"}`;
  - a `,` directly before `}` or `]` is dropped (trailing comma);
  - a raw control character inside a string is escaped (the same fix
    pi-ai's own `repairJson` applies client-side);
- else the arguments as they came: genuinely broken input is handed over
  unchanged, and the client sees the failure it would have seen without
  the middleware. It never invents values.

Everything else passes untouched: text and reasoning deltas, `[DONE]`,
usage, choices the middleware did not hold fragments for. The emitted
finish chunk keeps the original `finish_reason`, and each held call keeps
the `id` and `name` its first fragment gave. Clients merge fragments by
index, so one whole-argument fragment per call is exactly what a
well-behaved vendor would have sent. A stream cut before `finish_reason`
leaves its fragments held — the client could not have parsed them anyway.

All hooks are wrapped: a throw inside the middleware is logged by magpie
and the event passes as it was (fail-open).

## Install

```sh
magpie plugin add @magpie-community/middleware-fix-tool-args
```

## Options

| option | default | what |
|---|---|---|
| `mode` | `"repair"` | `"off"` passes every event untouched |

## Where it sits

It repairs what the vendor streams. It does not touch request history:
arguments that reached the client in a past turn are the client's, and a
model reading its own broken call back sees what it sent.

## Provenance

Built against the real failure of one xfyun spark-x2.6 session
(`{"pattern":**/*fd86512e*}` streamed in two fragments), verified
end-to-end through a real magpie gateway with a real spark-x2.6 upstream
(the corrupt case repaired, an untouched stream byte-equivalent), with
unit cases for bare keys, bare values, trailing commas, parallel calls,
empty arguments, unreparable input and garbage events.

## License

MIT
