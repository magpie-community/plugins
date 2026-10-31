# Post-merge follow-up for Agent Office 0.2.0

[PR #551 was approved and merged](https://github.com/magpie-community/plugins/pull/551#issuecomment-6542153594). This follow-up addresses its nonblocking cold-scan performance and test-coverage notes. Version remains 0.2.0; no Release/tag or npm publication is performed here. The maintainer notes that the package owner's first npm publication must be manual.

## Image-heavy initial scans

`readAppended` now buffers fragments through each read chunk and sends complete records directly to the reader. Only fragments still unfinished at the captured EOF pass through `framePart`. A fragment index remembers earlier ticks, so unfinished input is not walked again. Newline completion and committed-EOF resets clear both framing state and index.

Reproduce using synthetic logs, without real agent sessions or model calls:

```sh
bun scripts/bench-scan.mjs 100 1 1
```

The third argument adds a 1 MiB base64 image after every 30 approximately 4 KiB text records. Three separate-process comparisons on this Mac, with identical benchmark generation and the pre-fix/current scanner:

| Trial | Before initial scan | After initial scan |
| --- | ---: | ---: |
| 1 | 926.863 ms | 91.509 ms |
| 2 | 769.519 ms | 69.433 ms |
| 3 | 761.180 ms | 68.780 ms |

Initial/reset reads still require O(file size) I/O and JSON parsing. This removes redundant lexical traversal of completed records; it is not a constant-time first scan or a cross-machine speed guarantee. Timings are evidence, not test thresholds.

`cold-scan.test.mjs` counts actual large-string iterator traversal used by the lexical framer. Complete image records spanning multiple read chunks cause zero such traversal. Only the unfinished EOF text is framed, with zero revisits on unchanged ticks and only new fragments on appended ticks. Restoring eager chunk framing makes both tests fail.

## Mutation gaps closed

The targeted scanner suite passes 13 tests. Each isolated broken temporary scanner caused its intended regression to fail:

| Broken behavior | Regression evidence |
| --- | --- |
| Ignore inode/birthtime identity | New inode fixture preserves first 64 bytes and the previous-offset last 64 bytes, alters equal-length middle text and grows. Fresh-reader equivalence fails if identity is ignored. |
| Disable `ExtendedTail` replay | Appending non-whitespace before the newline invalidates a previously committed EOF assistant record. Correct replay removes its usage; disabled replay disagrees with a fresh scanner. |
| Always rebuild Codex title cursor | Long index with exact append/probe offsets: expected 423 bytes, broken scanner reads 311,705. Unchanged ticks must read zero. |
| Re-read unchanged summary on every append | Summary marker is counted independently of usage parsing: expected zero parses, broken scanner performs one. A changed-summary positive control proves the counter is active. |

Full plugin suite: **167 passed, 0 failed**, 14 files. The original incremental byte, partial image/UTF-8, quoted-brace, interrupted-read, daily usage and metadata tests remain enabled. Temporary mutation copies were removed; no real logs were used.

## Mac WebKit CSP evidence

[The maintainer did not reproduce the refusal on Linux WebKit build 2336](https://github.com/magpie-community/plugins/pull/551#issuecomment-6541781777). The earlier README statement was too broad and is narrowed to this observed environment:

- macOS **15.7.9**, build **24G830**, arm64.
- Playwright **1.56.1**, WebKit `browser.version()` **26.0**, installed build **2215**.
- Bun **1.4.4** local HTTP server; parent embeds `sandbox="allow-scripts"`; plugin loads only its own `app.js`.
- Native Safari and native WKWebView were not automated. Platform versus engine-version causality has not been isolated.

Reproduce and collect current versions, actual CSP headers, execution markers and console errors:

```sh
OFFICE_PLAYWRIGHT=/path/to/playwright/index.mjs bun test/webkit-csp.mjs
```

The diagnostic accepts either scheme-less outcome; the explicit-source control must execute. It creates an ephemeral localhost server and closes browser/server in `finally`. No account, model, bridge mock or external network is needed.

Captured actual headers at one run's port 50299:

```text
default-src 'none'; script-src 127.0.0.1:50299/_magpie/plugin/tok/;
default-src 'none'; script-src http://127.0.0.1:50299/_magpie/plugin/tok/;
```

The first policy returned HTTP 200 but blocked the script before a request reached the server. Exact console message:

```text
Refused to load http://127.0.0.1:50299/_magpie/plugin/tok/app.js?policy=scheme-less because it does not appear in the script-src directive of the Content Security Policy.
```

The explicit policy returned HTTP 200, requested/executed the script and logged `APP_EXECUTED`. Both frames had opaque document origin `"null"` (their URL origin was the HTTP origin), and neither produced a `pageerror`. This supports the specific Mac test observation and does not contradict the maintainer's Linux result. The existing normalization flag remains opt-in and test-only.
