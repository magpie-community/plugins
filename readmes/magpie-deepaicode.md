# magpie-deepaicode

A magpie provider plugin that makes **DeepAI Code** models available to every agent as
`deepaicode/<model>`. It talks to DeepAI directly (`https://api.deepai.org/deepai_code`)
and sends the **real device fingerprint** for the daily Theos grant, exactly like the
official desktop app does.

> Status: v0.2.1 — 61 unit tests green; real-account regression on 2026-11-06/07:
> chat, streaming, tool calls and image input all work; quota and check-in read live values.
> Upstream thinking arrives in `reasoning`; magpie renders it natively (PROTOCOL.md §4).

## Install

```bash
magpie plugin add magpie-deepaicode            # npm
magpie plugin add github:aqiu817/magpie-deepaicode
magpie plugin add ./magpie-deepaicode          # a local folder
```

In the app: **Plugins → Add plugin** → paste the folder path or package name.

## Sign in

`magpie plugin login deepaicode` offers three methods:

| Method | Needs | Notes |
|---|---|---|
| **Sign in with DeepAI** (recommended) | a DeepAI account | opens `desktop_auth`, listens on a random `127.0.0.1` port for the callback, exchanges the code; falls back to pasting the `code` if it cannot listen |
| **Read desktop credentials** | the DeepAI Code desktop app signed in once | reads `~/.deepai-code/userdata/secrets/deepai-account.bin` (plaintext JSON); in the key prompt type **`auto`** (or paste a key to use that instead) |
| **Paste API key** | a DeepAI API key (UUID form) | validated against `/theos` before it is saved |

`auto` is a sentinel meaning "read the desktop credentials" (magpie requires a non-empty
key prompt for `api` methods).

> Terminal note: after the plugin's questions magpie reads one more key from stdin. When the
> plugin returns a key itself (desktop / browser), that extra value is ignored — type anything.
> The in-app flow shows the plugin's own prompts.

## Use

```
deepaicode/glm-5.3-flash          # free models (8 of 14 as of 2026-11-06)
deepaicode/claude-opus-5-5        # premier models spend Theos
deepaicode/gpt-6-astra            # Responses-only model
```

The catalog is fetched dynamically (`/deepai_code/models`), with a 2026-11-06 snapshot as
fallback. `theosPerRequest == "0"` becomes magpie's `free: true`; premier prices
(3/10/15/25/50) become `rate`.

`gpt-6-astra` uses a per-model npm override (`@ai-sdk/openai`) so magpie sends it to the
Responses endpoint.

## Quota and check-in

- Quota = `/theos` + `/get_usage_summary` for the signed-in account. Results are cached
  in-process (success 10 min; other errors 10 min) so the panel's refresh rate (as fast as
  5 s) does not translate into upstream requests.
- Check-in = one `/theos` call, which triggers and locks the daily grant; `refresh_at`
  changes identify a freshly claimed grant.
- If upstream answers `403 "restarted its check-in too many times today"` (its daily
  guard against repeated check-in restarts), the plugin stops calling `/theos` for 6 hours
  and shows a neutral "resumes tomorrow" note instead of an error. Nothing is broken;
  chatting is unaffected.

The daily free Theos is issued **once per (machine fingerprint, account) per day**, and the
fingerprint is the real device id (SMBIOS UUID / `MachineGuid` / IOPlatformUUID /
`/etc/machine-id`), hashed the same way the desktop app does it. Multiple accounts on one
machine share that device's single daily grant — this is DeepAI's own device quota design,
and the plugin does not attempt to circumvent it.

## Options

Pass as the plugin's `options` (Plugins → installed → options, or
`magpie plugin options deepaicode '<json>'`):

| Option | Default | Meaning |
|---|---|---|
| `baseOrigin` | `https://api.deepai.org` | upstream origin |
| `laneVersion` | `"auto"` | `X-DeepAI-Code-Theos` lane: probe `/models` (unauthenticated) for the accepted value and cache it; set an explicit value like `"4"` to pin it |
| `secretDir` | `""` | desktop credentials dir (empty = auto-detect) |
| `lang` | `zh` | UI language (`zh` \| `en`) |
| `debug` | `false` | verbose `console.error` logging — field **names** only, never values |

## Troubleshooting

**Your own DeepAI account fails to sign in** — run the probe first; it shows the status
code and the upstream's own words (masked key):

```bash
node scripts/probe.mjs --secret-dir ~/.deepai-code
```

If the probe times out while magpie itself reaches upstream, a system proxy is set and
Node's `fetch` ignores it by default — rerun with `NODE_USE_ENV_PROXY=1` (Node 24+).
magpie's Bun host honors `HTTPS_PROXY` too.

**On networks with poisoned DNS (some ISP resolvers):** the plugin's own requests go out
of magpie's process, and magpie's in-app proxy setting does **not** cover them. Give the
magpie process a proxy explicitly — Bun's `fetch` reads it natively:

```bash
HTTP_PROXY=http://127.0.0.1:7897 HTTPS_PROXY=http://127.0.0.1:7897 NO_PROXY=localhost,127.0.0.1 magpie
```

(Verified on a Linux ARM64 board where the system resolver returned bogus AAAA/A records
for `api.deepai.org`; with the env vars set, sign-in and quota worked immediately.)

| Probe output | Likely cause | What to do |
|---|---|---|
| `403` / `email_unverified` | e-mail not verified | click the verification link DeepAI sent you |
| `401` | key invalid (re-login rotates it) | sign in to the desktop app again, or paste the new key |
| `302`/`401` right after a successful web login | stale credential | re-read the desktop credential file |
| `426` "This version … no longer supported" | upstream raised the lane version | `laneVersion: "auto"` (the default since 0.2.1) re-probes it automatically; older plugin versions need an update |
| `400` "This request is not one DeepAI Code sends." | old plugin (pre-0.2.1) tripping the upstream client check — on Node hosts it was the default `user-agent: node` | update the plugin to 0.2.1+ |
| `403` "restarted its check-in too many times today" | DeepAI's daily guard: the account's check-in flow was (re)started too often today — e.g. fingerprint changes or repeated sign-ins | nothing is broken; it self-heals at the next daily reset. Chat keeps working |

**No thinking output in the agent** — verified working: magpie renders the upstream's
`reasoning` natively (PROTOCOL.md §4 #8).

## Security

- The DeepAI key is sent **only** to the configured origin; request URLs are rebuilt from
  the configured base, never from the incoming URL.
- Redirects are refused (`redirect: "error"`): an invalid key must not be turned into a
  fake `200` by following the sign-in redirect.
- Keys never appear in logs or error messages; `debug` logs field names only; the probe
  masks keys.
- Response bodies for non-streaming calls are size-limited; streaming bodies are passed
  through untouched.
- The plugin reads the desktop credential file read-only and never writes credentials
  anywhere except magpie's own auth store.
- The machine fingerprint is the real device id — the plugin does not derive per-key
  fingerprints or otherwise work around DeepAI's daily device quota.

## Development

```bash
npm test                                  # node --test (54 tests)
node scripts/smoke.mjs                    # models/usage/checkin/loader against upstream
node scripts/probe.mjs                    # masked protocol forensics
```

Protocol facts and evidence levels: [PROTOCOL.md](./PROTOCOL.md).
Chinese README: [README.zh-CN.md](./README.zh-CN.md).

## License

MIT. Protocol knowledge was first mapped with the help of DeepAICode2API (MIT); see
[NOTICE](./NOTICE).
