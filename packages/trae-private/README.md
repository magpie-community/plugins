# Private TRAE CLI provider (experimental)

An OpenCode-compatible provider for private TRAE deployments that use the CLI's
`/api/ide/v2/llm_raw_chat` protocol. The provider ID is `trae-private`. This is
separate from the public/SaaS `trae-cn` and `trae-global` providers; it does not
change them or ship a deployment host, application ID, credentials or model list.

## Install and configure

Install Magpie, your deployment's TRAE CLI, and Chrome/Edge (Chromium also works
on Linux). Install the plugin:

```sh
magpie plugin add @magpie-community/opencode-trae-private-auth
```

For a local checkout, use `magpie plugin add ./packages/trae-private` instead.

Set `TRAE_PRIVATE_APP_ID` in the environment of the process running Magpie to
the application ID confirmed for your deployment. There is **no default**. A
missing, empty or invalid value fails the chat request before any upstream
request is sent. Restart Magpie after changing its environment. An application
ID is protocol configuration, not an access token; do not put credentials in it.

In Magpie's provider page, enter the enterprise HTTPS address and select the
TRAE login method. An existing valid CLI login for that deployment can be reused.
Use a separate CLI directory for each additional account. The default is
`TRAE_HOME`, then `~/.trae`. The account retains its canonical absolute directory,
uid and deployment; changing the environment or replacing the directory's user
or deployment cannot silently redirect an existing account.

Each machine must sign in independently. Do not copy auth files, cookies or
browser profiles between machines. For Windows, set `TRAE_PRIVATE_CLI` to a native
`traecli.exe`; `.cmd` and `.bat` wrappers are deliberately not executed through a
shell. Remote/headless hosts need the CLI and login/browser arrangement on the
host where the plugin runs; an already valid CLI login can be reused without
claiming that remote browser SSO works everywhere.

## Login and usage sessions

The CLI owns the access and refresh tokens in `<cli-home>/cli/auth.json`. The
plugin reads the access token but does not copy or exchange the CLI refresh token.
Magpie stores the access token, expiry and account binding. Same-account token
rotation is accepted; a changed uid, deployment or canonical directory requires
reconnection. A missing auth file means signed out. Partially written JSON is
retried asynchronously and reported as a temporary failure without marking the
account signed out.

Quota uses a separate web session. Chat authentication and quota-session capture
are reported separately: missing cookies do not mean that chat sign-in failed.
Choose the separate SSO/session-recapture method when a valid CLI login lacks a
usable quota session. It does not delete a valid CLI login first, although the
CLI can update its own files during SSO.

The plugin creates its own temporary debug-browser profile and reads only the
session cookie from that login. It neither reads nor terminates existing user
browser profiles. Session records are written under
`${XDG_CONFIG_HOME:-~/.config}/magpie/trae-private-sessions/`, separated by origin,
uid and canonical CLI directory. Cookies are filtered by host/domain boundary,
path, HTTPS and expiry before sending. Session cookies without an expiry are
retained for at most 12 hours. Old unbound cookie files and generic cookie
environment variables are not accepted. Windows permissions depend on the user's
ACLs; POSIX mode bits alone do not establish Windows access control.

Login URL discovery accepts HTTPS authentication links from the CLI, not arbitrary
first links. The plugin has a 30-second URL wait and a five-minute login lease,
with cleanup on cancellation, failure or expiry. macOS/Linux browser shims use
Python 3 from the host; no Python is installed automatically. Without it, the
JavaScript path can still open URLs parsed from CLI output, subject to that CLI's
actual behavior. Host UI cancellation integration still needs real verification.

## Models and request behavior

Models come from that account's `cli/models_cache.json`, not a built-in catalog.
The account-aware `provider.models(provider, { auth })` hook selects the account;
older hosts without account context use the default directory for listing. Each
chat request independently validates the selected account and its current model
snapshot. Unknown and explicitly non-raw-chat models are rejected. A last-good
catalog is reused only for a transient JSON parse failure, for at most one second,
and never across account/deployment changes or after file removal.

Declared positive context limits are respected. The expansion switch defaults
to off and can only raise a limit. **When a model has no declared context, the
compatibility fallback remains 1,000,000 tokens**, configurable with
`TRAE_PRIVATE_CONTEXT`. This is not a measured guarantee for an unknown deployment:
set a confirmed conservative value before use. The same variable is the optional
expansion target. Output defaults to 32,000; verify both limits with your service.

Chat and quota use HTTPS, preserve a deployment's path prefix, reject ambiguous
URLs and refuse redirects. Streaming and collected JSON responses are supported;
omitting `stream` returns JSON. Tool-call fragments, missing call IDs, empty
arguments and usage after a finishing frame are handled. A finish followed by EOF
can complete; an uncompleted truncated stream fails. Sampling fields are forwarded
but a deployment may ignore them. Reasoning effort must be in the model catalog.

The final serialized UTF-8 request budget defaults to 9 MiB. Old-turn images may
be replaced with text placeholders and old tool output shortened. Current-turn
images/results and tool-call pairing are retained; irreducible requests fail with
413 instead of silently dropping the current input.

## Configuration

| Variable | Purpose / default |
| --- | --- |
| `TRAE_PRIVATE_APP_ID` | Required deployment application ID; no default |
| `TRAE_HOME` | Default CLI directory before account binding; otherwise `~/.trae` |
| `TRAE_PRIVATE_CLI` | CLI executable path; otherwise user's `.local/bin` and PATH |
| `TRAE_PRIVATE_BROWSER` | Chrome/Edge/Chromium executable path; otherwise discovery |
| `TRAE_PRIVATE_NO_AUTO_REFRESH=1` | Disable CLI-triggered renewal |
| `TRAE_PRIVATE_NO_LOGIN_BROWSER=1` | Disable plugin debug browser; quota capture may be unavailable |
| `TRAE_PRIVATE_CONTEXT` | Positive integer context fallback/expansion target; 1,000,000 |
| `TRAE_PRIVATE_OUTPUT` | Positive integer output limit; 32,000 |
| `TRAE_PRIVATE_BODY_BUDGET` | Positive integer serialized UTF-8 bytes; 9 MiB |
| `TRAE_PRIVATE_TOOL_RESULT_KEEP` | Historical tool-output characters retained; 20,000 |
| `TRAE_PRIVATE_USER_AGENT` | Compatibility default identifies codex_exec 0.201.1 on macOS/arm64; override for the deployment |
| `TRAE_PRIVATE_PROTOCOL_VERSION` | Compatibility default `0.201.1-tob-alpha.1` |
| `TRAE_PRIVATE_IDE_VERSION_CODE` | Compatibility default `20260206` |
| `TRAE_PRIVATE_IDE_VERSION` | Compatibility default `99.99.99` |
| `TRAE_PRIVATE_ORIGINATOR` | Compatibility default `codex_exec` |
| `XDG_CONFIG_HOME` | Magpie configuration root, otherwise `~/.config` |

Protocol headers must be nonempty printable ASCII, at most 512 characters.
Compatibility protocol defaults are not a claim of universal deployment support.
This package currently uses these environment variables, not a separate JSON
plugin-options surface.

## Renewal can incur charges

Within two hours of token expiry, Magpie's refresh hook can run
`traecli exec --skip-git-repo-check --json 'reply with: ok'` in an empty temporary
working directory to let the CLI renew its own token. **This can contact the
service, issue a model request and incur charges.** It is not a free refresh API.
Set `TRAE_PRIVATE_NO_AUTO_REFRESH=1` if this is not acceptable, and renew through
your organization's CLI workflow. Calls for the same directory are coalesced;
different directories are independent. Identity is checked before and after
renewal. Hosts that do not call Magpie's refresh hook do not proactively use this
path.

## Verification and limitations

The tests use constructed fixtures, mock browsers/processes and blocked external
I/O. They cover account/cookie isolation, half-written files, protocol translation,
request budgets and login cleanup, including cancellation while a browser starts.
They are not captured production stream fixtures.

**Real enterprise SSO, CLI renewal, Windows/Linux browser integration and target
deployment calls have not been validated by this test suite.** Validate the CLI,
IdP flow, two-account isolation, quota capture, protocol headers and actual limits
on your target installation. Any live chat or renewal test may incur charges.

Run from the repository root:

```sh
bun test packages/trae-private/isolated.test.mjs
bun scripts/check.mjs trae-private
```

The discoverable test starts a separate Bun process for the three fixture suites
and explicitly preloads the filesystem/network/process guards. This keeps their
global mocks out of other packages. Do not import the case files into the shared
monorepo test process or bypass the preload. The wrapper checks both exit status
and the expected nonzero test count.

`node packages/trae-private/scripts/setup-machine.mjs` only checks file presence;
it does not read credential contents, run the CLI, contact the service, prove
login validity or modify configuration.

MIT licensed. This package continues the private-deployment provider discussed
in [PR #235](https://github.com/magpie-community/plugins/pull/235); TRAE CLI and
browser binaries are not redistributed.
