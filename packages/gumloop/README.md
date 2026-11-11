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
system message; if none is supplied, the plugin adds "You are a helpful assistant."
Existing nonempty system instructions are preserved.

Requests are rewritten the way Gumloop takes them: `max_completion_tokens` becomes
`max_tokens`, `reasoning_effort` becomes `reasoning.effort`, streams ask for their
usage, and a model's output cap is learned from its first refusal. Claude requests
ask for the 1-hour prompt cache (Gumloop bills it at the 5-minute write price), so
a session idle for more than five minutes doesn't rewrite its whole context. Turn
that off with `{"cache1h": false}` in the plugin's options.

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

To calibrate, sign in again with the credits gumloop.com shows (bottom left), or
set them in the plugin's options, applied once per value:

```sh
magpie plugin options gumloop '{"balance": {"<user id or email>": 7142}, "allowance": 20000}'
```

`balance` is a number for every account or an object keyed by user id or email.
`allowance` (optional, same forms) is the plan's monthly credits; with it the card
shows used / allowance instead of what is left.

The estimate is kept in `gumloop-ledger.json` in magpie's config directory.

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
