# gumloop

Gumloop ([gumloop.com](https://www.gumloop.com)) with your API key, in
[OpenCode](https://opencode.ai) and [magpie](https://usemagpie.ai). Gumloop serves
an OpenAI-compatible chat completions API at `https://ws.gumloop.com/api/v1`; this
plugin signs every request with your key and user id, so agents reach its models
like any other provider, with magpie's multi-account fallback.

**Provider id:** `gumloop`

## Sign-in

Gumloop → Settings → Connectors → **Gumloop API Key**: create a key, and copy the
**User ID** shown on the same page. `magpie plugin login gumloop` (or the sign-in
button in the app) asks for:

| Prompt | Required | Used for |
| --- | --- | --- |
| API key | yes | `Authorization: Bearer <key>` |
| User ID | yes | `x-auth-key: <user id>` |
| Account email | no | names the account in magpie |
| Credits left | no | starts the credit estimate (see below) |

The key and user id are checked against `GET api.gumloop.com/api/v1/models` before
they are kept. They are stored as `{ "type": "api", "key", "metadata": { "userId", … } }`
in magpie's `plugin-auth.json` (permissions 600). A key Gumloop refuses marks the
account for sign-in again.

## Models

The models your account can use, listed per account from `GET /models`: active,
unrestricted chat models that call tools. Gumloop's own router (`gumloop-chew`),
image, voice, transcription and classifier models are left out. Context is the
model's short window where Gumloop gives one, since every call bills the whole
context.

Model ids use the account catalog's names, such as `gumloop/glm-5.3`.
The plugin translates these to the chat endpoint's route IDs (for example,
`accounts/fireworks/models/glm-5p3`). Older aliases such as `glm-5p3` still work.

MiniMax M3 is temporarily omitted: on 2026-11-11 Gumloop's route rejected even
minimal requests with `Extra inputs are not permitted, field: 'provider'`.
MiniMax M3.1 Flash is supported. Muse and MiniMax M3.1 Flash require a nonempty
system or developer message; if none is supplied, the plugin adds "You are a
helpful assistant." Existing nonempty instructions are preserved.

Requests are rewritten the way Gumloop takes them: `max_completion_tokens` becomes
`max_tokens`, `reasoning_effort` becomes `reasoning.effort`, streams ask for their
usage, and a model's output cap is learned from its first refusal. Set
`{"cache1h": true}` in the plugin's options to opt into a 1-hour Anthropic prompt
cache TTL on Claude requests.

## Credits

Gumloop's API has no balance endpoint, so the usage card is an **estimate**:

- each call is priced from its token usage at list price (OpenRouter's prices,
  re-read every 12 hours; Fireworks-hosted models at the standard Fireworks
  endpoint price, excluding spot tiers; Z.AI and Gemma use their provider
  endpoints; built-in
  prices when OpenRouter can't be reached), at $0.005 a credit, rounded up to a
  whole credit per call, as Gumloop bills;
- the result is taken off the balance you gave, from when you gave it.

Prices and rounding are estimates, not a reconciliation with Gumloop's invoice.
Provider discounts, routing changes and unavailable live long-context rates can
make the estimate differ. Models with no known price are counted as unpriced,
not as free calls.

Spend on gumloop.com itself (flows, Gumball) shows only when you calibrate again.
A stream stopped mid-way never reports its usage; the card counts those so you
know to recalibrate. An out-of-credits refusal sets the estimate to 0 and sends the
request to the next account.

Only HTTP 402 or HTTP 403 with a structured `credit_limit_exceeded` code is
treated as exhausted credits. Other chat 403s check `GET /models` with the same
credentials: HTTP 200 keeps the sign-in, HTTP 401/403 marks it expired, and a
network failure or other status leaves the original refusal unchanged.

To calibrate, sign in again with the credits gumloop.com shows (bottom left), or
set them in the plugin's options, applied once per value:

```sh
magpie plugin options gumloop '{"balance": {"<user id or email>": 7142}, "allowance": 20000}'
```

`balance` is a number for every account or an object keyed by user id or email.
Each distinct `options.balance` number is applied once; if you top up back to the
same number as before, sign in again with the balance prompt (which timestamps
each calibration) or pass a different number.
`allowance` (optional, same forms) is the plan's monthly credits; with it the card
shows used / allowance instead of what is left.

In magpie, the estimate is kept in `gumloop-ledger.json` in magpie's config
directory. In OpenCode, it is kept in memory for the session so project folders
are never written to.

Ledger updates use a filesystem ticket lock (Lamport's bakery algorithm) and
re-read the latest data before changing it. Each attempt has a unique
`gumloop-ledger.json.lock.<pid>.<uuid>.json` record. A complete record is
published by atomic rename, first announcing ticket selection, then its ticket.
Contenders enter in ticket/name order and remove only their own records on
release. There is no reusable shared lock pathname that competing recoverers
could accidentally unlink after a new owner acquires it.

After a host crash, the next update removes that owner's records and unfinished
lock temporary files only when `process.kill(pid, 0)` reports `ESRCH` (no such
process). Age never permits removal. A reused PID or a permission failure is
treated as possibly alive; an unreadable or invalid published record also
prevents acquisition. Normal process exit attempts cleanup, but recovery does
not depend on exit handlers running. This requires a coherent local filesystem;
network filesystems and simultaneous hosts using the old lock protocol are
not supported.

Acquisition waits up to two seconds in 10 ms intervals. Windows sharing errors
on reads, renames and cleanup are retried with bounded two-second deadlines;
the mutation callback itself is never retried. Waiting blocks the plugin host's
JavaScript thread. A timeout or unrecoverable filesystem error skips that
estimate update without failing the chat, so the estimate may be too high.
A host killed before its ledger rename may likewise lose its final update;
the previous complete ledger remains available and later requests recover.

Short-lived hosts may terminate immediately after receiving a completion.
The plugin therefore finishes accounting before releasing terminal SSE frames
or a JSON response within the existing 4-million-character parsing limit.
Ordinary SSE content still streams as it arrives; response bytes are preserved.
Complete ordinary lines are released even when the next line is partial.
SSE accounting finishes at `[DONE]`, or EOF when that marker is absent.
The tap retains at most 256 KiB of incomplete SSE line or terminal-tail bytes.
If that limit is exceeded, it records an unbilled estimate once before releasing
the held bytes, then passes through the remaining stream with backpressure.
It does not charge a provisional usage value from an oversized terminal tail.
Oversized JSON retains the existing pass-through and unbilled-estimate behavior.

## Install

```sh
magpie plugin add ./packages/gumloop
magpie plugin login gumloop
magpie provider test gumloop
magpie quota
```

In OpenCode, add the package under `plugin` and sign in with `opencode auth login`.
The package includes separate OpenCode 1.x and 2.x entrypoints; email and balance
remain optional in both login flows.

## Development

```sh
bun test
bun scripts/check.mjs gumloop    # in a magpie-community/plugins checkout
```

Thanks to [vwfactory-dsh](https://github.com/cjj66619/vwfactory-dsh), whose
Gumloop relay worked out the API, the request rewrites and the billing rules.

MIT. Not affiliated with Gumloop.
