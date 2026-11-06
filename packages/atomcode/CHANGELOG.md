# Changelog

All notable changes to this project are documented here. The format follows
Keep a Changelog and the project uses semantic versioning.

## 0.3.0 - 2026-11-03

### Added

- Magpie-native `auto_claim` and `auto_version` provider switches, both on by
  default. The legacy `autoClaim` and `autoVersion` options still override them.
- A loopback-only, read-only diagnostics page at
  `http://127.0.0.1:3478/` (configurable), with token-gated state and offline
  signature checks. It never calls AtomGit and is not started under OpenCode.
- Crash-tolerant state under Magpie's plugin directory for last-good model
  metadata, quota snapshots, version provenance, redacted errors and self-check
  results. The file contains no access token, refresh token, full user id,
  email, prompt or raw upstream response.
- A custom `auth.toml` path prompt for the AtomCode CLI sign-in method, accepting
  absolute paths and `~/...`, with renewals written back only to that file.
- A shared failure vocabulary that separates credential failures from plan,
  entitlement and quota failures across models, usage and check-in.

### Changed

- The package now ships from `magpie-community/plugins` as
  `@magpie-community/opencode-atomcode-auth`, with separate OpenCode 1.x and
  2.x entry points.
- Minimum Magpie version is now `0.1.2629`, which provides native provider
  switches and page services.
- The AtomCode diagnostics page is now a focused troubleshooting workspace with
  a local-status summary, quota-first layout, model catalog, progressive
  technical details and a human-readable redacted report.
- The default per-account concurrency is now 8 instead of 4. Controlled live
  probes at 4, 8 and 12 simultaneous short requests all returned HTTP 200 with
  no 429 or 5xx responses; 8 keeps additional parallel headroom while remaining
  conservative. Magpie's provider setting can still override it.
- Usage failures after a successful read now return the persisted stale quota
  snapshot with `stale: true` instead of replacing the account's windows with
  an empty result.
- Live model discovery falls back first to the account's last successful disk
  cache, then to the built-in snapshot.
- Only 401 and explicit credential/session 403 responses trigger a refresh.
  Quota and entitlement 403 responses keep the sign-in and add
  `x-magpie-sign-in: kept`.
- Quota rows are separated by explicit unit and window span, so a token window
  is not misreported as a call-count window.
- The diagnostics workspace now uses flat backgrounds and solid status colors
  to match Magpie's settings pages.

### Fixed

- Restarting or briefly losing the CodingPlan endpoint no longer hides known
  quota windows or the previous model catalog.
- Exhausted claim slots now produce `ineligible`; ordinary upstream failures
  remain `failed`.
- A missing native switch value now matches the settings UI's enabled default.
- The published package uses an explicit file list, so editor backup/upload
  sidecars cannot enter the npm tarball.
- Upstream legacy `window_token_*` fields that contain call counts are no longer
  mislabeled as token quotas. Token-only rows are inferred from token-specific
  fields without call counters; `current_usage` also requires an explicit unit.
- The embedded diagnostics page now loads inside Magpie's
  `sandbox="allow-scripts"` plugin frame, including its styles, scripts, images,
  token-gated API preflights and requests. Each page response uses a fresh CSP
  script nonce. Host and token checks remain loopback-only, and CORS never uses
  a wildcard origin.
- CLI-backed renewals preserve each existing TOML scalar's type, including the
  official CLI's string-valued `user.id`, and keep unmanaged fields such as
  `token_type`. A renewal can no longer make the official CLI reject auth.toml.

### Security

- Diagnostics bind only to `127.0.0.1`, validate `Host` and `Origin`, require a
  random per-process token for APIs, and serve a restrictive CSP.
- Persisted diagnostics state is schema-filtered, atomically written with
  `0600` permissions, and excludes credentials and account identifiers.

## 0.2.0 - 2026-11-02

### Added

- Second sign-in method that reuses the official AtomCode CLI's
  `~/.atomcode/auth.toml`, validates private regular-file permissions, re-reads
  shared state before use, and atomically writes renewals back.
- Live model metadata for `deepseek-flash`, reasoning-effort variants, and
  model-level output-token limits.
- Token-oriented quota windows alongside every call-count window.
- Opt-in live smoke test capped at nine requests, with automatic claiming
  disabled and no token, prompt, or response-content output.
- Isolated tarball install/import CI smoke and release publication workflow for
  npm trusted publishing with provenance.

### Changed

- Package name and layout are migration-ready for
  `@magpie-community/opencode-atomcode-auth` under
  `magpie-community/plugins/packages/atomcode`.
- Minimum Magpie version is now `0.1.2563`; OpenCode loading remains supported
  but is explicitly experimental pending a real host-contract test.
- Endpoint overrides are restricted to the exact `acs.atomgit.com` and
  `api.gitcode.com` hosts on HTTPS port 443.
- Request bodies are normalized to replayable bytes, buffered with a 64 MiB
  cap, and signed after stream-usage serialization.
- Unknown quota values stay unknown instead of being reported as zero.

### Fixed

- A caller-owned `URL` can no longer be mutated between validation and dispatch
  to redirect signed traffic.
- Refresh results are cached by old and new refresh token, so persistence
  failures or a gap between renewal and save cannot trigger a second rotation.
- Gateway 401/403 responses force one refresh and retry; CLI-backed accounts
  persist the new credentials before the retry.
- Usage/check-in/claim work shares one request budget and one claim lock, with a
  bounded 18-second quota path.
- `auth.usage` returns `signIn: "expired"` on upstream credential failures.
- `remaining_days: null` no longer triggers a false plan re-claim.
- Special model names such as `__proto__` cannot alter the model result object's
  prototype.
- Upstream error bodies, invalid option values, emails, bearer tokens, and long
  secrets are redacted from logs and user-facing errors.

### Security

- OAuth, CodingPlan, and version response bodies remain bounded and redirects
  are refused.
- CLI auth files reject symlinks, non-regular files, and permissions wider than
  `0600`.
- The published package keeps zero runtime dependencies.
