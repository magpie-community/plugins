# Validation

Date: 2026-11-07 (Asia/Hong_Kong).

## Package checks

`bun test packages/nowledge-mem-agent`: **28 passed, 0 failed** on Bun 1.3.5/macOS. Tests use `bun:test` next to the source.

Full repository validation with the reviewer's **Bun 1.4.2**, under an isolated child home: **6614 passed, 9 skipped, 0 failed**, 479 files, 212.01 seconds. The older local Bun does not honor the repository's test exclusions and was not used as the full-suite result.

Coverage includes connection/switch/disconnection, original purposes and Remote mode, manual edits, partial failures, first-provider activation, legacy empty placeholders, journal/backend binding, locks, private atomic writes, malformed selections, emergency-restore pause, remote polling backoff, and incompatible REST responses.

The redirect case uses two HTTP servers on different hosts (`127.0.0.1` and `localhost`); it checks rejection, zero visits to the target and no received credential. The provider-reference test leaves its connection fingerprint unchanged so only the external reference protects it. The default-mode test changes Default during Background's restoration and checks Remote remains enabled. Poll-clock/file-read injection tests the quiet period without sleeping.

## Mutation checks

Each guard was removed alone, the package suite run in a fresh process, then the original source restored:

| Removed guard | Result |
| --- | --- |
| `redirect: 'error'` | 1 failing test |
| Quiet-period early return | 2 failing tests |
| `!referenced` before provider removal | 1 failing test |
| `defaultRestored` before disabling Remote | 1 failing test |

Restored source: 28 passed. `bun scripts/check.mjs nowledge-mem-agent` validates registry syntax/classification; it skips loading Agent hooks.

## Actual Magpie host smoke

`MAGPIE_BIN=/Applications/magpie.app/Contents/MacOS/magpie node packages/nowledge-mem-agent/tests/magpie-smoke.mjs` passed with Magpie **0.1.3212**.

Every child process receives its own HOME/USERPROFILE, XDG config/cache/data and AppData roots in a private temporary directory. Guards reject the real caller/account home and escaped directories; known agent-home overrides are removed. The caller's environment is not mutated. Account discovery is disabled. The descriptor is loaded unchanged; tilde paths resolve in the sandbox home.

Confirmed: Agent registration, sandboxed `connect`, dynamic gateway address/key, Bun-host synchronization of three purposes, model change, full disconnect recovery and `0600` selection file. Fake Nowledge and vendor endpoints received **zero model calls**. No live agent configuration is used.

## Nowledge contract evidence

Actual provider create/remove contract last run: **Nowledge Mem 0.10.115 on 2026-11-07**. The independent native `magpie:<id>` instance, context/output metadata, key masking, first-provider auto-activation and preserved Remote mode were checked. The temporary provider was removed and original assignments restored.

For this revision, `node tests/nowledge-contract.mjs --read-only` also passed against the running **0.10.115** service: version from OpenAPI metadata, required purpose fields and an existing `provider_type: magpie` confirmed with **no writes**. The opt-in mutating mode refuses enabled/configured backends.

The provider management routes are not present in that version's public OpenAPI. They were checked against its official installed client assets and live service; the exact routes and evidence are in README. An incompatible config or a backend that coerces the native type stops before purpose writes, with a visible error and retained journal.

## Limits

No actual paid inference, multi-turn tool use, long-context compaction, Windows desktop detection or subsequent Nowledge release is claimed as verified. macOS desktop data-directory detection was checked; other platforms retain PATH-based CLI detection. Uninstall before disconnecting can stop the bridge before restore: keep its journal and use the documented recovery CLI. External references can prevent clearing an originally empty default. These limits are explicit in README.

No user credentials, provider keys or Nowledge data are part of this package. No runtime dependencies or install scripts.
