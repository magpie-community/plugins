# Magpie integration

## Plugin contract

The package is a Magpie page plugin. Its manifest declares `page.file` as
`page/index.html`, a local service on port `3488` (configurable through the
`port` option), and one provider-menu action named `fingerprint`. Magpie sends
the action as `{ id, provider: { id, name } }` to the page frame. The page boot
document captures this event before navigating to the service, so the selected
provider is preserved across the service navigation.

A current Magpie release with `page.service` support is required. The service is bound to loopback. In a
desktop window it is reached at `http://127.0.0.1:<port>`; in `magpie web`,
Magpie supplies `magpie.service`, a tokenized reverse-proxy URL. The service
does not expose the gateway listener. Its authenticated API accepts its local
page and the opaque `Origin: null` used by Magpie's sandbox, and rejects unrelated origins.
The page CSP names the validated local listener and, when proxied, the HTTP(S)
origin supplied by the page launcher in every fetch directive (default, script,
style, image and connect). Opaque sandbox frames cannot reliably match `'self'`:
WebKitGTK, magpie's Linux window, matches nothing to it there, so a policy of
`'self'` alone loads no script and the page stays blank. The launcher origin changes
only the document policy; the API bearer token and Host/Origin checks still apply.

## UI integration

The service page reconnects to Magpie using the upstream page bridge, vendored
with its MIT notice. Magpie supplies live theme tokens and language through
`hello` and `theme` messages. The interface uses the upstream base control
styles and a small selection of Magpie's list, group and segmented-control CSS.
It adds no sidebar or duplicate application header inside the plugin frame.
Standalone mode keeps its own theme and language controls.

The iframe remains isolated: the bridge exchanges messages with its parent;
it does not access the parent DOM or load private host scripts. The pinned
upstream revision is documented in `THIRD_PARTY_NOTICES.md`.

## Gateway reads

The service reads `GET /v1/models` for the text model catalog and
`GET /v1/magpie/quotas?kept=1` for cached subscription account labels. The
`kept=1` form does not ask vendors for a fresh quota reading. Account rows are
projected to provider, user id, and display name (the account's alias, else
its user) only; upstream credentials, balances, and raw quota records are never
sent to the browser.

Gateway authentication uses `Authorization: Bearer <key>` when an API key is
configured. Loopback Magpie normally needs no key. A remote gateway must be
shared and requires its enabled gateway key. `X-Magpie-Account` can pin a
gateway request to one account id or signed-in user, but is only meaningful to
Magpie and is never forwarded upstream. A header value is ASCII, so a user that
isn't (`北冥`) is sent percent-encoded (`encodeURIComponent`), which Magpie
v0.1.2658 and later read back; an ASCII user is sent as it is.

## Job files

Each batch is saved as `jobs/<id>.json` under the data directory. A pinned
target keeps `account` (Magpie's id for the account: its user, an email or a
login, which routing matches and rests it by) and, when the catalog listed it,
`accountName`, in `config.targets[]` and `results[].target`. When every target
is pinned to the same account, `config.account` and `config.accountName` name
it too. Jobs saved before 0.2.2 have none of these fields and load as they were.

## Local development

```sh
bun run rebuild
bun start
```

The default gateway is `http://127.0.0.1:3425`. Set
`MAGPIE_FINGERPRINT_GATEWAY` (or `MAGPIE_ADDR`) when Magpie listens elsewhere.
Set `MAGPIE_FINGERPRINT_API_KEY` only when that gateway requires a key. The
service port is controlled by `MAGPIE_FINGERPRINT_PORT`; data defaults to
`~/.config/magpie/fingerprint`.

The standalone illustrative fixture is opt-in:

```sh
bun src/cli.ts --demo
```

Demo mode never calls a real gateway or model. Numeric first-release detection
uses the pinned `lmfpd-sdk` 0.2.0 request/analyze flow; the SDK has no public
tokenizer API. Each job retains its loaded reference snapshot and records
`builtAt`; remote data is not version-pinned or verified against a locally
pinned hash. Jobs use three common challenges per batch, bounded concurrency,
and explicit cancellation/limits.
The detector reports model-family evidence, not identity authentication.

## Options and persistence

Plugin options accept `port`, `gateway`, `apiKey`, `dataDir`, and `bankSource`.
Keep the API key in the service environment when possible. `MAGPIE_FINGERPRINT_DATA_DIR`
overrides persistence; `MAGPIE_FINGERPRINT_BANK_SOURCE` can point to a local bank
directory for fully offline scoring. Each batch retains its loaded detector instance.

Opening/refreshing the page reads only the configured gateway and local history.
`POST /api/bank/download` is the explicit download/refresh action; a valid
`POST /api/jobs` also loads data if none is usable. Cached snapshots have no
background refresh, including after the SDK default 24-hour TTL. Downloads use
`https://lm.ikale.io/data/`, falling back to
`https://cdn.jsdmirror.com/npm/lmfpd-data@latest/`. These hosts see the client IP
but receive no provider credentials, model ids, prompts or replies. A custom
`bankSource` replaces these defaults.

Jobs are stored as atomic JSON files with owner-only permissions. The current limit
is 200 batches, 24 targets per batch, three concurrent targets and three concurrent
samples per target. The batch deadline is 10–900 seconds. Restarted unfinished jobs
become `interrupted`; already received raw replies remain available.

The SDK's `requestSample` does not accept a transport or external abort signal.
A second loopback-only listener provides one-shot, authenticated, job-bound sample
URLs. It forwards only the prescribed model/protocol to the configured gateway,
adds session/account headers, records provenance, and binds upstream fetches to
the job controller. It cannot be reached through the page service proxy.

The page's relative asset/API URLs also work under Magpie's remote proxy prefix.
Exports provide JSON text and clipboard/manual-copy fallback because Magpie's
iframe sandbox can block downloads. Standalone browser users can download a file.

## Multiple Magpie hosts

Desktop and `magpie web` can share a listener when their service protocol and
configuration match. The remaining host takes over if the owner exits. Different
configurations or unrelated applications on the port are rejected. The public
health digest uses HMAC-SHA256 with an owner-only, random per-install key; the
gateway API key still participates in matching. If the install cannot persist
that key, processes refuse to share a listener. After upgrading, turn Fingerprint
off and back on once to release an older listener.

For OpenAI-compatible chat streams, a clean EOF after an explicit `stop` is
normalized with `[DONE]` when the gateway omitted that sentinel. The raw response
text is unchanged, and provenance records `streamNormalization: chat-done-after-stop`.
Incomplete finishes, errors, and disconnected streams are never repaired.
