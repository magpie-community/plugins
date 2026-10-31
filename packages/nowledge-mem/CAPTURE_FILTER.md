# Capture filtering

These options change only the copy sent to `POST /threads/import`. They do not
edit inference requests, recalled context, system prompts, tool declarations,
tool execution or replies shown to the user. No model is called to classify or
rewrite the conversation. Existing MCP configuration is independent.

## Configuration

In Magpie's plugin **Options**, merge these fields into the existing connection
settings (do not replace the Server URL, API key, Space or profile):

```json
{
  "capture": true,
  "captureFilter": "human",
  "captureCindy": false
}
```

`captureFilter` accepts only `"off"` (default, existing behavior) or `"human"`.
`captureCindy` accepts a boolean, default `false`. Invalid values fail validation;
they do not silently select a more aggressive mode. The existing page preserves
advanced options that it does not display. Capture itself still defaults off.

Human mode keeps text from user and assistant messages and excludes tool results
even when `captureTools` is true. It preserves assistant commentary attached to a
completed tool call, all final text parts, attachment captions, repeated real
utterances, code indentation and long text. It does not synthesize image/file
placeholders or import attachment bytes. The existing protocol parser excludes
structured thinking/reasoning; this option does not try to recognize reasoning
from prose or remove arbitrary `<think>` examples.

The first retained user message supplies the title, cached after a successful
import for the lifetime of the bounded in-process title cache. A transcript with no retained user text is skipped rather than written
as an assistant-only Thread. The source remains `magpie`; Space and Agent/profile
metadata, Thread identity, occurrence indices and existing credential checks are
preserved. Filtering runs *after* the original settlement and credential checks:
a secret in a removed tool argument or Cindy note still blocks capture.

## Optional Cindy cleanup

Set `"captureCindy": true` only to opt into cleaning Cindy's known host notes.
It is effective only with `"captureFilter": "human"` and Magpie's host-derived
`ctx.agent === "cindy"`. A plain `pi`, `omp`, unknown or other agent is not
assumed to be Cindy. The gateway does not inspect launch environment variables,
permission files, databases or local transcripts. It never treats an API key or
a user-authored marker as authentication.

Magpie's [Cindy adapter](https://github.com/yetone/magpie/blob/main/internal/agent/cindy.go)
uses its Cindy agent key for the imported endpoints.
A manually configured provider may report a different agent. In that case the
cleanup remains inactive; use the native integration rather than forcing a
weaker text-only identity guess. Existing local/magpie-key origin restrictions
still apply, including to remotely forwarded requests.

Only complete, recognized *leading* templates are removed: UI language, current
and legacy client notes, directory grants, WeChat channel headers, Side Chat
notes, and explicitly delimited handoff/rebuild/fork notes. Unknown or incomplete
templates stop cleanup and stay verbatim. Fenced/quoted examples, notes later in
user text and all assistant text stay untouched. Exactly matching raw templates
pasted at the beginning of a Cindy user message cannot be distinguished from
host notes; quote or fence such examples, or disable this option.

WeChat display names and explicit ownership survive as `metadata.cindy_origin`;
group/non-owner speech also keeps a short speaker label. Recognized channel and
client headers lose their transport chat/user/device IDs. This is not a general
PII scrubber and does not remove identifiers from genuine dialogue.

Recognition is bounded to 32 stacked prefixes, 64 Ki UTF-16 code units per
multiline wrapper and 8192 code units for a single-line template. Unrecognized or
oversized suffixes stay intact. These scan bounds do not truncate dialogue;
the original 512 KiB UTF-8 serialized-message import limit still applies.

## What the gateway cannot know

`human` means a conservative user/assistant **wire-text projection**, not proof
that every `role=user` text was typed by a human. In particular, it cannot recover
OMP's native `attribution=agent`, a skill's original `details.prompt`, Pi entry
IDs/timestamps or Cindy's parent-session header and creation boundary when those
are absent from the request. Internal continuations already flattened into user
text stay intact. Literal user `/skill:...` commands are retained, but expanded
skills cannot be reconstructed into their original drafts.

A Side Chat note is cleaned as a note; inherited parent messages are **not**
trimmed or deduplicated by text. No parent Mem Thread binding is inferred. Use the
native Pi/OMP integration for exact lifecycle capture, branch scoping and selected
Thread continuation. A gateway request carrying only an opaque previous-response
reference still cannot supply missing history. Capture remains best-effort,
not a durable queue; this change does not repair backend distillation, browser
DOM extraction, native worker scheduling or old saved data.

## Regression sources and coverage

All fixtures are synthetic. Public reports motivate invariants here; these tests
do **not** claim to reproduce or fix the reports' other integrations end to end.

| Source | Reused scenario / invariant | Gateway boundary |
|---|---|---|
| [OMP PR #782](https://github.com/nowledge-co/community/pull/782) at `66fee750ca16c087d50c960b514dba3e626233e5` | `fixtures/dialogue-projection.json` adapts the expected dialogue; wire test matches its role/text oracle, including commentary, literal skills, captions, complete long text and repeated occurrences | Native attribution filtering, original-skill reconstruction and native message IDs are not asserted |
| [Pi/Cindy PR #785](https://github.com/nowledge-co/community/pull/785) at `594b1520fb7a187f1deddc660a4602665d85ff3b` | `fixtures/cindy-context.json` is copied unchanged; known prefix recognition, stacked notes, CRLF, indentation, incomplete/quoted examples, speaker attribution and transport-ID removal | Explicit option + Magpie `cindy` identity replaces native launcher markers; no fork-boundary inference |
| [community #200](https://github.com/nowledge-co/community/issues/200) | Recognized Cindy preambles do not become the title; the acknowledged title stays stable | Not an LLM title generator or universal preamble detector |
| [community #544](https://github.com/nowledge-co/community/issues/544) and [nowledge-mem #182](https://github.com/nowledge-co/nowledge-mem/issues/182) | Structured reasoning is excluded while all final text parts and commentary survive across Chat, Responses, Anthropic and Gemini shapes | Not a browser selector fix |
| [community #756](https://github.com/nowledge-co/community/issues/756), [#698](https://github.com/nowledge-co/community/issues/698) | Bounded prefix recognition, unchanged UTF-8 import cap, long CJK/emoji text kept below the cap | No native transcript scanning, new workers or Working Memory compressor |
| [nowledge-mem #161](https://github.com/nowledge-co/nowledge-mem/issues/161) | Capture filtering leaves inference requests, tools, recalled content and live output unchanged | Not a backend cache-routing fix |
| [community #459](https://github.com/nowledge-co/community/issues/459) | An unsuccessful import is not recorded as an acknowledged filtered replay; a later event can succeed | No new retry worker or persistent delivery guarantee |

Additional negative tests retain inherited Side Chat history and ambiguous OMP
user text, and enforce opt-in, source restrictions, secrets in removed content,
unsettled tools, incomplete output and package/default contracts.

Run the focused suite with either runtime:

```sh
node --test packages/nowledge-mem/capture-filter.test.mjs
HOME=$(mktemp -d) bun test packages/nowledge-mem
```

The tests stub Mem's HTTP endpoints and inspect outbound request bodies. They
prove filtering/transport contracts, not real-Mem persistence or live-host capture.

## Changing policy and returning to upstream

External message IDs use the original normalized message text and occurrence index,
so changing filtering or Cindy cleanup preserves IDs for retained messages and the
legacy off-mode ID format. Existing Threads are not automatically migrated; the
result of reimporting changed content depends on the receiving service. Identical
utterances at different positions remain distinct.

Run only one capture owner for a given session. Do not enable both original and
forked gateway plugins, or native capture plus gateway capture, for the same
traffic. Keep your existing MCP tools; this option does not register them.

A temporary fork can return to upstream after the PR is merged **and the installed
upstream artifact actually includes these options**, not merely after a merge
notification. Preserve the connection/options, disable the temporary plugin,
install/update the upstream package, and validate one new synthetic session in a
disposable Space before resuming real captures. Confirm one Thread, clean text,
correct origin/Space and one successful append. If native lifecycle/Side Chat
accuracy remains required, keep the native capture path instead. This document
does not automatically install, publish, migrate or change any live configuration.
