# 0.2.0 review validation

[PR #551](https://github.com/magpie-community/plugins/pull/551) was approved at 3bf522f and merged on 2026-10-31. The results below record that repair. Nonblocking post-merge improvements and current validation are recorded in [follow-up validation](follow-up-validation.md). No release/tag is created or moved by these repairs.

## Review blockers

1. **CLI cross-site access**: pages/data/bridge require a per-run 256-bit capability URL. Host must match the actual loopback listener; writes require matching Origin and JSON. CSP does not interpolate Host. Tests exercise the original private-mode POST + script attack, forged Host/DNS rebinding, missing/guessed tokens and legitimate access.
2. **Text-off DOM residue**: rail signatures include titles/privacy state; hidden rail/list content refreshes; message nodes are removed; closed details are scrubbed. Browser tests switch text off with a panel open and assert no synthetic marker remains in DOM text or attributes.
3. **Hidden 3D resumes**: enabled state is separate from visibility; stale rAF generations are rejected; the app accepts anchors only from its active renderer. Tests cover mode switches, visibility and context restoration.
4. **DPR growth**: hidden canvases retain CSS dimensions and never reuse their buffer as CSS input. DPR-2 tests repeat hidden resizes.
5. **Early-return 3D tests**: tests now execute the bundled THREE scene, geometry, matrices, workers and animation; only GPU/DOM scheduling boundaries are stubbed.

## Other findings

- Today refreshes from private daily buckets at local midnight. Changed JSONL logs retain UTF-8-safe cursors and parse appended records. Grok usage.json uses the published vendor per-turn schema; sidecar-only edits invalidate cache.
- No-progress/idle labels update without new writes. No-progress sessions can be cleared until their next write. Rail/list labels agree; filters do not replay old error toasts.
- Bun requirement, occupied-port behavior, --port 0, Grok skill support and capability URL documentation are accurate.
- Nine-language scene/quality/fallback/role/venue text; focused camera shortcuts; wheel handling only consumes a zoom change; notification dots.
- Six-scene prop fitting avoids seating/walking routes. Overflow workers get distinct destinations; context loss, bounded orbit and touch pinch are covered.
- Shared InstancedMesh batches preserve articulated poses, colors and shadows. In the renderer fixture, 32 workers across seven statuses use 9 groups instead of 608 individual worker meshes. This is structural evidence, not a GPU benchmark.
- Quality adjusts DPR/shadows; context antialiasing is fixed. The three.js header documents the reproducible esbuild command.
- Undocumented CONFIG_DIR aliases removed; stream word boundaries preserved; redaction validates tool-name prefixes.

## Validation

`bun test`: **163 passed, 0 failed**, 13 files. Marketplace package tests also pass 163 tests; the marketplace check script passes.

Browser tests use actual magpie Web UI navigation, options bridge, theme and sandbox. Only live.js is replaced by synthetic data. No model calls or user prompt screenshots are needed.

DPR-2 window sizes 600×620, 820×650 and 1440×1000 give plugin CSS viewports 576×500, 788×594 and 1196×944. Checks cover menus, tag collisions, modes, hidden buffers, the No-progress clock, alert history and text-off scrubbing. The largest size also exercises six scenes and three quality settings.

**Chromium passed unchanged. Mac WebKit qualification:** the observed refusal is limited to Playwright 1.56.1 WebKit 26.0 build 2215 on macOS 15.7.9 (24G830, arm64). Its UI checks used explicit `OFFICE_NORMALIZE_WEBKIT_CSP=1`; host/path/sandbox were preserved. The maintainer reports no reproduction on Linux build 2336. This is not a general WebKit or native Safari/WKWebView result; see the [minimal repro and exact console error](follow-up-validation.md#mac-webkit-csp-evidence).

Synthetic narrow-frame evidence: [settings](qa-retina-settings.png), [text disabled](qa-retina-privacy.png).

## Practical limits

The first read and a reset/replacement replay are O(file size). Normal JSONL polling parses only appended complete records and performs at most 128 bytes of old-prefix/end checks; an unfinished record still requires buffering until complete. Arbitrary non-append middle edits preserving inode and both witnesses while growing are outside the append-only log contract. Compressed DSH retains its 8 MiB input limit and four-second throttle. Grok sidecars are capped at 32 MiB and usage is assigned to the recorded turn-end date. Stub-GPU tests do not replace device-specific performance testing.


## Follow-up review: incremental JSONL

[Follow-up review](https://github.com/magpie-community/plugins/pull/551#pullrequestreview-5722086970) confirmed the previous blockers fixed and identified growing-log replay as the remaining blocker.

The scanner now keeps the file identity, byte offset, UTF-8 decoder, JSON framing and resumable reader state. Normal ticks never replay historical events. No-change ticks do not read the log; metadata-only updates refresh sidecars without reading JSONL. Codex thread titles also retain a cursor. First reads, truncation/replacement and detected rewrites rebuild state. Prefix/end guards add at most 128 old bytes per growing file, catching common truncate-and-regrow without scanning history.

New regressions cover actual bytes read after appending to a 100 MiB file; every reader's batch/full equivalence and parse-call counts; midnight; usage corrections; pending tools; metadata replacement/removal and precedence; partial UTF-8; delayed newline; large image fragments; quoted braces; interrupted reads; and resets/source changes. An incomplete quoted string ending in `}` is never speculatively re-parsed each tick. A complete EOF record may be parsed twice when first completed (validation then reader), but not on later ticks or when its newline arrives.

Reproducible synthetic benchmark: `bun scripts/bench-scan.mjs 100 1` and `bun scripts/bench-scan.mjs 100 4`. One local run:

| Workload | First read | No-change read | Five append scans | Bytes per append scan |
| --- | ---: | ---: | ---: | ---: |
| One ~100 MiB log | 130.695 ms | 0.172 ms / 0 B | 0.097–0.388 ms | 4,003 new + 128 guard |
| Four ~100 MiB logs | 514.631 ms | 0.216 ms / 0 B | 0.257–0.656 ms | 16,012 new + 512 guards |

These are measurements on this machine, not CI speed thresholds. Deterministic tests assert byte and parse counts instead. Complete usage sidecars are not retained or re-aggregated on each append; only current day totals are retained by the reader. Gemini JSON documents and compressed DSH snapshots remain full-document reads when changed.


Follow-up validation at the incremental repair: full marketplace `HOME=$(mktemp -d) bun test` completed with **4115 passed, 4 skipped, 0 failed**, across 327 files. Package tests pass 163 tests across 13 files. The installed 0.2.0 scanner/readers were checked against the source SHA-256 hashes. CI passed for the incremental code commit; maintainer approval and merge followed at 3bf522f.
