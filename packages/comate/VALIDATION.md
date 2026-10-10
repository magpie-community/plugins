# Comate review revision evidence

This revision addresses [PR #77's review](https://github.com/magpie-community/plugins/pull/77#issuecomment-6096525186)
from `bf497abf901f24b2c6c830470c0c5898c099ca30`. It remains a draft.
The market entry has been withdrawn pending real-client acceptance and the
first publication by a community npm owner. Nothing was published or deployed.

## Review disposition

1. Removed `packaging/` and `PACKAGING.md`. npm is the distribution channel;
   an absolute checkout path is documented only for development.
2. Host integration requires explicit `MAGPIE_HOST` or `MAGPIE_CHECKOUT`.
   Neighbouring checkouts are ignored. The npm payload excludes all tests
   and `host-process.mjs`.
3. No dependency on the rejected gateway change `7d8e0c6`. The integration
   check uses unmodified upstream Magpie. The plugin's non-stream collection
   still rejects a failed task with 502 after partial text. Upstream Magpie's
   existing partial-text and reasoning-only error rules remain unchanged.
4. Real Codex and Claude Code tool turns are **blocked**, not passed; see
   the conditions and procedure below. Fixture responses cannot satisfy this.
5. Aliases belong to each plugin instance and credential/local endpoint.
   Refresh replaces them, failed discovery clears that credential's map,
   and an existing loader uses the credential current at request time.
6. Removed all seed IDs: their account-independent provenance was not
   established. Positive numeric `limit.context`, `limit.input` and
   `limit.output` in a live record are preserved. The real endpoint's limit
   schema and values still need confirmation. Missing values stay unknown
   (`0`), with no inference from a display name or a fabricated fallback.
7. Native Windows remains **unverified**. Windows paths have fixture coverage
   only. Linux also has no live desktop acceptance evidence. No market claim
   of Windows support is made.

## Checks performed in the Linux cloud environment

Recorded on 2026-10-10. Node `v24.19.0`, npm `11.9.0`, Bun `1.4.3`.
The preconfigured `go-cli` checkout was not modified. Tools and target
repositories were installed/checked out into separate directories.

| Check | Result |
| --- | --- |
| `node --test` in `packages/comate`, no host opt-in | 42 passed, 1 skipped, 0 failed |
| Same suite with explicit `MAGPIE_HOST` and `MAGPIE_BUN` | 43 passed, 0 skipped, 0 failed |
| `bun test` at repository root, temporary HOME, no host opt-in | 1080 passed, 1 skipped, 0 failed across 107 files |
| `bun scripts/check.mjs` | All 16 provider packages passed |
| New regression files against old `bf497ab` code | All 9 failed as expected; all 9 pass with this revision |
| `npm pack --dry-run --json` | Six entries: LICENSE, README.md, discovery.mjs, index.mjs, package.json, protocol.mjs; no host helper, tests, ZIP or installers |
| `git diff --check` | Passed |
| `scripts/new-to-npm.sh` | Expected failure: only `@magpie-community/opencode-comate-auth` is not yet on npm; requires a community npm owner, outside this task's authorization |

The opt-in integration ran against [yetone/magpie at
`61c40b80bb17f8a451a25037b8561760715fb13d`](https://github.com/yetone/magpie/commit/61c40b80bb17f8a451a25037b8561760715fb13d),
with a clean working tree. It uses the production Bun plugin host and a
**synthetic loopback Comate service**, including tool history and failed-task
checks. It does not execute the Go gateway or either real agent client.

The general hook checker now permits an empty catalog only when the plugin
has a matching `provider.models` hook. This allows an account-dependent live
catalog before sign-in without adding a fictional model to satisfy the check.

Reproduce the independent checks from a source checkout:

```sh
cd packages/comate
node --test
MAGPIE_HOST=/absolute/path/to/unmodified/magpie/internal/plugin/host.js \
  MAGPIE_BUN=/absolute/path/to/bun node --test
cd ../..
pr77_test_home=$(mktemp -d)
env HOME="$pr77_test_home" bun test
bun scripts/check.mjs
npm pack --dry-run --json --workspace @magpie-community/opencode-comate-auth
git diff --check
```

For the regression comparison, copy `models.test.mjs` and
`host-process.test.mjs` into a temporary directory with `index.mjs`,
`protocol.mjs`, `discovery.mjs` and `host-process.mjs` from `bf497ab`; run
`node --test models.test.mjs host-process.test.mjs` there. Every new test
fails on that baseline for the behavior it covers.

## Real-client status and exact missing conditions

| Client or acceptance item | Version / model ID | Result |
| --- | --- | --- |
| Codex CLI | `0.159.0-alpha.3`; Comate model ID unavailable | Version/help checked; no real Comate turn run |
| Claude Code | `2.1.296`; Comate model ID unavailable | Installed in an isolated tools directory and version/help checked; no real Comate turn run |
| Comate desktop/local service | Not installed or signed in here | No live model list, context limits, or tool execution available |
| Native Windows | No Windows runtime or desktop session | Not run |

The cloud has no Comate settings or service-discovery files at its normal
locations, and no configured Comate service. Only file existence and relevant
environment-variable presence were checked; no login token was read, printed
or transferred. Installing client executables does not supply the missing
Comate desktop service. The user's offline Mac was not accessed or authorized
for this task.

The previously reported final full live run passed Chat Completions and then
failed a Responses required-tool case with 502. It is historical failure
evidence, not a pass for this revision or proof of real Codex/Claude Code
continuation. This revision makes no all-client or all-platform pass claim.

To complete acceptance, an authorized operator needs a working desktop
machine running signed-in Comate, its reachable IPv4 loopback service,
unmodified upstream Magpie with this plugin revision, and both clients.
Use the existing desktop sign-in locally; do not send its license to the
cloud. A separate native Windows run is required for Windows acceptance.

## Procedure for the authorized desktop operator (not yet executed)

1. Record the plugin commit, OS, Comate app version, `magpie --version`,
   `bun --version`, `codex --version` and `claude --version`. Install this
   checkout's package in Magpie and use **Comate account (this computer)**.
   Keep the normal upstream gateway behavior.
2. Refresh the account's live model list. Record the exact model ID used
   (including any suffix) and its display name. Inspect only model metadata
   from `/list-model` locally: establish the context field name, units and
   value and whether an output limit is separate. Do not copy credentials,
   settings files or raw HTTP headers into the evidence. If no context
   value is supplied, record that fact and obtain authoritative account
   limits before marking this item complete.
3. Route Codex and Claude Code to this local Magpie instance through Magpie's
   normal agent settings, selecting `comate/<exact live model ID>`. Ensure
   there is no fallback to another provider. Check Magpie's local request
   trace for the selected Comate route; a successful turn on another
   provider does not count.
4. Create an empty scratch directory and a fresh unpredictable challenge
   file outside the clients' prompt. For example, run this Python code in
   the scratch directory (works on Windows as well):

   ```python
   from pathlib import Path
   import secrets
   Path("challenge.txt").write_text(secrets.token_hex(16) + "\n")
   ```

5. Run both clients in that scratch directory. These POSIX command examples
   use flags checked against the versions above; on Windows pass the same
   arguments from PowerShell. `COMATE_TEST_MODEL` is the non-secret exact
   model selector recorded in step 2, not an old seed or guessed alias.

   ```sh
   COMATE_TEST_MODEL='comate/<exact live model ID>'
   codex exec --json --sandbox read-only --skip-git-repo-check \
     -m "$COMATE_TEST_MODEL" \
     'Use your file or shell tool to read challenge.txt. Wait for the tool result, then reply with exactly its contents. Do not guess or delegate.' \
     > codex-turn.jsonl

   claude -p --model "$COMATE_TEST_MODEL" --tools Read --allowedTools Read \
     --output-format stream-json --verbose \
     'Use Read to read challenge.txt. Wait for the tool result, then reply with exactly its contents. Do not guess or delegate.' \
     > claude-turn.jsonl
   ```

6. A pass requires a real client tool-call event, successful local execution,
   a correlated result sent back through Magpie to Comate, and a subsequent
   assistant response matching the fresh file contents. Record model ID,
   client version, tool name, correlation ID, final result and any API error
   for **each attempt**. A plain text answer without a tool event, a fixture,
   a failed 502 or a turn on another provider is not a pass. Repeat with a
   new challenge to check continuation reliability; retain failures too.
7. Run the same procedure on native Windows, checking the actual discovery
   of `%APPDATA%\Comate\User\settings.json` and
   `~/.comate/zulu-serve.pid` locally. Record versions and behavior, with
   account names, credentials and private paths redacted from shared logs.

After these results are reviewed, restore the market entry and have a
community npm owner perform the first publication and configure trusted
publishing as described in the repository README. Until then the expected
`on-npm` failure is a release prerequisite, not permission to publish here.
