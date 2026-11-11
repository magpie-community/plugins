# LMM OAuth for OpenCode and Magpie

<img src="https://raw.githubusercontent.com/TokenNotIncluded/opencode-lmm-auth/main/assets/icon.svg" alt="LMM for OpenCode and Magpie" width="128" height="128" />

An independently versioned OAuth provider plugin for official **OpenCode 2.1.4**
(`@opencode/cli`) and Magpie. The native V2 `/server` entry uses the official
`@opencode/plugin@2.1.4` contract. The default entry serves Magpie and provides
limited legacy OpenCode **1.18.34** support: authorized catalog listing, OAuth
login and reconnect remain available, but **all legacy inference and automatic
OAuth refresh are disabled, including inference with valid credentials**.
Local fixture verification and independent acceptance are separate; this preview
does not imply production acceptance.
[中文](README.zh-CN.md).

Sign in to [LMM](https://api.lmm.best) through OpenCode's native OAuth menu; no API
key needs to be copied. The Magpie and V2 integrations implement catalog-advertised
OpenAI chat, OpenAI Responses and Anthropic Messages transports with explicit
model/group routing, refresh-token rotation and streaming/cancellation. OAuth
login uses PKCE S256, issuer-bound discovery and state/issuer callback checks.
These transport features are unavailable on legacy 1.18.34; real Magpie and V2
application verification in this round is **NOT_RUN**.

## Install in Magpie

Install the package from npm, or use the tagged GitHub repository directly:

```sh
magpie plugin add @tokennotincluded/opencode-lmm-auth
magpie plugin login lmm
magpie provider test lmm
```

The repository is tagged `magpie-plugin` and keeps the built entry at its root,
so a GitHub install is also available when a local npm registry policy blocks
the package:

```sh
magpie plugin add github:TokenNotIncluded/opencode-lmm-auth
```

Magpie stores the OAuth grant in its private `plugin-auth.json`; no API key is
copied. After sign-in, the provider's account-scoped catalog is available to
agents as `lmm/<model>`. Each model keeps the LMM catalog's protocol, limits,
capabilities and configured price. The same package can be installed from
Settings → Plugins.

## Install in official OpenCode 2.1.4

Use a reviewed, built package directory (for example, the directory installed
from its reviewed npm tarball), and merge this into `opencode.json`:

```jsonc
{
  "plugins": [{
    "package": "/ABSOLUTE/PATH/opencode-lmm-auth",
    "options": {"issuer": "https://api.lmm.best"}
  }]
}
```

Point `package` at the directory containing `package.json` and `server.js`.
OpenCode 2.1.4 resolves its server entry first: npm package resolution uses the
`./server` export, and directory resolution uses the root `server.js` wrapper.
Both load `dist/opencode-v2.js`. The default `dist/index.js` remains the legacy
Magpie/v1 entry. V2 uses plural `plugins`; the singular `plugin` example below
belongs to OpenCode 1.18.34.

```sh
opencode auth login lmm --method oauth
```

Complete browser sign-in and consent within three minutes, with the browser and
OpenCode server on the same machine for the loopback callback. Select an LMM
model after connecting. The native host owns account selection, credential
persistence and refresh. The plugin supplies account-bound models and the host's
bundled chat, Responses and Anthropic transports; catalog access is refreshed on
credential events and every 60 seconds. Revoked credentials remove LMM models;
reconnect with the same login command. The V2 integration registers the official
session retry hook with `retry: false` for LMM. This describes the implementation;
real V2 application retry behavior was **NOT_RUN** in this verification round.

The issuer option is optional and defaults to `https://api.lmm.best`. A trusted
alternative HTTPS issuer must register the same OAuth client; changing issuer
requires a fresh login. This source preview must be built with
`npm ci --ignore-scripts` and `npm run build`; the packaged artifact already includes
both built entries. Neither runtime entry imports the development SDK packages.
The legacy SDK peer is optional, so V2 installations do not pull it in.

## Install in legacy OpenCode 1.18.34

**Legacy inference is disabled for every account, even with fresh, valid
credentials. Automatic OAuth refresh is also disabled.** This host has no
account-conditioned credential write and no supported plugin control that
reliably disables its automatic paid request retries. The plugin refuses these
operations before refresh exchange, credential PUT or inference I/O. It does not
make legacy persistence atomic or change the host's retry policy.

For catalog access and OAuth login/reconnect, clone this repository at a reviewed
commit and merge its built default entry into your `opencode.json`:

```jsonc
{
  "plugin": ["file:///ABSOLUTE/PATH/opencode-lmm-auth/dist/index.js"]
}
```

Run `opencode auth login --provider lmm`, then select **Sign in with LMM (OAuth)**. Complete browser sign-in and consent within three minutes.
The browser and OpenCode server must run on the same machine for the loopback
callback. Restart OpenCode after connecting to load the authorized catalog.
Models may appear under `/models`, but attempts to invoke them return an explicit
assistant error. Expired or revoked credentials require the same CLI login command;
reconnect restores catalog access only and does not enable legacy inference.
Use Magpie or the V2 integration for inference, subject to their separate acceptance.
The package includes the built `dist/index.js`, so npm and GitHub installs do
not run a build step. A local file install remains available for development.

The API server must register public OAuth client `lmm-opencode` and enable its
issuer, CLI feature flags and group allowlists. The Pi client cannot substitute
for the OpenCode registration.

135 exact model capability profiles from models.dev are bundled, with source
URLs and explicit limits. Only matching entries from your authorized LMM catalog
are advertised; the catalog supplies billing groups and current prices. Unknown
models or unsupported pricing are omitted. Additional verified profiles can be
merged under `provider.lmm.models` with context/output limits, capability booleans
and `options.lmmApi` (`openai-completions`, `openai-responses` or
`anthropic-messages`). The supported Magpie/V2 transports choose the matching SDK
per catalog model; these catalog settings do not enable legacy inference.

A trusted alternative issuer can be supplied with the plugin tuple
`["file:///…/dist/index.js", {"issuer":"https://YOUR-ISSUER"}]`; it must register
the same client. Issuer changes require a fresh CLI login.

## Credentials and limitations

OpenCode owns the persisted OAuth access and refresh credentials. V2 accesses
them through the official integration connection API. Magpie owns its
account-scoped `plugin-auth.json`; the plugin never writes a second credential
file. For legacy OpenCode 1.18.34, the plugin reads the native
`$XDG_DATA_HOME/opencode/auth.json` (default `~/.local/share/opencode/auth.json`)
during configuration because that host passes a deep copy to `auth.loader`;
the provider model hook also keeps the package compatible with Magpie, which
asks for each account's models before loading its request transport. The `refresh`
field is a versioned JSON envelope containing the actual refresh token, trusted
issuer/resource and granted scopes. It is still a secret; never paste or log it.
The credential-free rotation journal is under
`~/.local/state/opencode-lmm-auth/refresh/`. Do not delete its markers to retry a
failed refresh. The journal fences reuse of the same refresh token by cooperating plugin processes;
it does not provide an account-conditioned compare-and-set (CAS) or atomic account
selection/persistence. Legacy automatic refresh is refused before exchange or save.
Magpie's explicit account-auth hook and native `auth.refresh` field-return contract
remain in place; hook/SDK checks do not establish a broader host CAS guarantee.
A lost response, crash or failed host save requires a fresh login: V2 uses
`opencode auth login lmm --method oauth`; legacy v1 uses
`opencode auth login --provider lmm`.

Static USD per-million-token rows with a complete `native_cost` use the exact
account-adjusted LMM rates. Dynamic and expression-based rows
are also exposed when the bundled exact models.dev profile has a non-zero vendor
reference cost (a host-provided exact cost may override it); their name and
`lmmPricingBasis` option say **LMM variable billing**, and the reference cost is
never presented as an LMM quote. Rows with unknown pricing or without a safe
reference cost remain unavailable instead of being shown as free. Prices already
include group/trust multipliers and are not locked quotes.
Configure no API keys for this provider;
the plugin strips alternate credential headers and refuses redirects, URL
credentials, unsupported endpoints, unknown models and group substitutions.
There is no credential fallback, cross-group retry, MCP or marketplace support.

Removing credentials from OpenCode does not itself revoke the server's grant.
Server revocation uses the registered client's `/api/oauth2/revoke` endpoint;
server revocation/billing behavior is covered by the backend tests. This preview
does not add a dedicated OpenCode revoke UI.

## Verify

```sh
npm test
npm run typecheck
npm run build
npm run pack:check
# New, private retained evidence directory outside the temporary fixture HOME:
install -d -m 700 "${XDG_STATE_HOME:-$HOME/.local/state}/lmm-api"
evidence=$(mktemp -d "${XDG_STATE_HOME:-$HOME/.local/state}/lmm-api/plugin-opencode-v2-XXXXXXXX")
chmod 700 "$evidence"
OPENCODE_V2_BIN=/absolute/path/to/native/opencode-2.1.4 \
  LMM_V2_TEST_OUTPUT="$evidence" npm run test:v2
# Legacy checks require the legacy binary, not OpenCode 2.1.4:
OPENCODE_BIN=/path/to/opencode-1.18.34 npm run test:host
OPENCODE_BIN=/path/to/opencode-1.18.34 npm run test:integration
# Magpie loading check in an isolated home (no real credentials are touched):
sb=$(mktemp -d)
env HOME="$sb" XDG_CONFIG_HOME="$sb/.config" XDG_CACHE_HOME="$sb/.cache" \
  magpie plugin add @tokennotincluded/opencode-lmm-auth
env HOME="$sb" XDG_CONFIG_HOME="$sb/.config" XDG_CACHE_HOME="$sb/.cache" \
  magpie plugin --json
```

Real Magpie and V2 application checks in this verification round are **NOT_RUN**.
Unit/hook contract checks do not replace those application checks or establish
host-wide CAS or retry guarantees.

When run, `test:v2` is designed to pack the current built files, install that actual
tarball with `--omit=dev --ignore-scripts` in an isolated HOME, and run the native
official 2.1.4 host. Its intended coverage is OAuth PKCE, persisted
rotation/restart, all three native protocol session streams, revocation refusal
and reconnect against local synthetic TLS services. `LMM_V2_TEST_OUTPUT` preserves that exact tarball, its
SHA256, package metadata, install logs, redacted host logs and result JSON
outside the deleted fixture HOME. Use the exact native binary to avoid wrapper
updates. Fixture success does not verify production grants or billing.

The development graph still has four high npm audit entries rooted in the
pinned legacy `@opencode-ai/plugin@1.18.34`: its `effect`/`toml` and `zod`
dependencies. The suggested downgrade to 0.9.11 breaks the supported API and is
not applied. The legacy SDK is used only for types and is an optional peer;
check the isolated installed graph separately from the development audit.

The legacy host smoke verifies unauthenticated loading and the native OAuth menu.
`npm run test:integration` starts the real OpenCode 1.18.34 binary with an
isolated native credential store and trusted local TLS fixture. This round
verified PKCE OAuth callback/token persistence, restart and authorized model
catalog listing. For models advertising each of the three protocols, the actual
host returned an explicit **assistant error**, with no successful text or
`AbortError`; the fixture received **zero inference requests and zero refresh
exchanges**, and the native credential slot remained unchanged. It also verified
expired/revoked credential refusal and actual native CLI PKCE reconnect restoring
the catalog. This is refusal coverage, not complete streamed inference success;
reconnect does not enable legacy inference. No paid inference is performed by this
test. Live production OAuth/inference acceptance is separate and depends on the
deployed server revision.

Reference APIs: [OpenCode 1 plugins](https://opencode.ai/docs/plugins/),
[OpenCode providers](https://opencode.ai/docs/providers/),
[official V2 plugin SDK](https://github.com/anomalyco/opencode/tree/v2.1.4/packages/plugin),
[2.1.4 plugin loading](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/core/src/config/plugin/source.ts),
[2.1.4 login](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/cli/src/commands/handlers/auth/login.ts).
The standalone callback, HTTP and refresh-journal primitives were adapted from
this project's AGPL Pi provider. This package retains AGPL-3.0-only; see LICENSE.

Windows refresh uses an exclusive, fsynced marker file. Concurrency and process-crash replay are fenced; sudden-power-loss directory durability is weaker than the directory-fsync path on Linux/macOS. Never remove marker files to retry.

OpenCode 1.18.34 does not list an unconnected model-less provider in its TUI `/connect` dialog. Use the native CLI login command above. Revoked or unavailable credentials remove LMM models; fresh credentials can restore catalog listing. All legacy LMM inference and automatic refresh remain disabled, while OAuth login/reconnect and other providers remain available.
