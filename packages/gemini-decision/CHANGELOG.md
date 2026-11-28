# Changelog

## 0.1.2

- Fix the provider hook missing its `id`: magpie's plugin host only calls provider hooks whose id matches the provider, so the entire live models hook was dead code. `id: 'gemini-decision'` is now returned, and the host's `ctx.signal` is combined with the 10s timeout through `AbortSignal.any` so magpie can cancel the request.
- Move the test suite to `test/plugin.test.mjs` using `node:test` so CI's root `bun test` discovers and runs it (`test/run.mjs` stays as the npm-test entry). The package was previously the only one in the repo with no bun-discoverable test file.
- Fix non-PDF documents: Google's document block accepts `application/pdf` only. Inline text-like files (csv/txt/md/html/json/xml) now decode into text blocks; non-PDF file URLs are dropped instead of being sent to a guaranteed upstream rejection.
- Fix unknown audio formats being labelled `audio/mpeg`: an unknown `format` now carries no `mime_type`, matching the unknown-image-extension policy.
- README corrections: drop the outdated "byte-identical" passthrough claim (usage mapping re-serialises every 2xx body), remove the stale lobehub icon note, and state up front what this plugin adds over magpie's native gemini-decision-1 support (a separate key/project with its own quota, pooled keys, or a decisions-only concurrency cap).
- Registry summary now describes the separate-key/pooling value rather than repeating pricing.
- Expand the test suite from 34 to 42 cases: config-hook model facts (context/cost/modalities), provider-hook id, host-signal cancellation and timeout combination, the ignored `GEMINI_DECISION_BASE_URL` override, PDF-only document handling, and unknown-audio mime omission.

## 0.1.1

- Fix usage lost on the way back: map Google's `usage.total_input_tokens` to magpie's `usage.input_tokens`/`output_tokens` (output always 0 — decisions return native probabilities).
- Fix the live models hook: strip the `models/` prefix from Google's model names, paginate through `nextPageToken`, keep only `gemini-decision-*` models (embedding/chat models are no longer offered as this provider's models), and add a 10s `AbortSignal.timeout` per page fetch.
- Fix question-id sanitizing exceeding Google's 64-character limit: ids are now truncated with room left for the `_N` collision suffix, so suffixed ids always fit.
- Fix hardcoded mime types on URL media: image/video/document `mime_type` is now guessed from the URL extension (no more `image/jpeg` on PNG URLs), and omitted when unknown instead of being fabricated.
- Fix model facts to match Google's docs and this README: context 262,144, input cost $0.10 per 1M tokens, input modalities text/image/audio/video/file.
- Remove the `GEMINI_DECISION_BASE_URL` environment-variable override: the base URL is where the user's Google key is sent, and an env override could redirect it to any host.
- Clarify why `npm: '@ai-sdk/openai-compatible'` is registered: it's the request-channel package name per repo decision-provider convention; chat semantics come from `decide`/`decides`, not npm.
- Clean up leftovers from the plugin this was adapted from: provider-id references in comments, the user-visible 404 error text, misplaced JSDoc, and the Chinese-only key placeholder (now bilingual).
- Copy `scripts/opencode2.mjs` again (the previous copy predated #1642).
- Expand the test suite from 15 to 34 cases: noul criteria mapping, null-criteria fallback, id sanitizing/restoring (collisions, 64-char limit), media/assets conversion, the models hook, and usage mapping; the mock upstream now uses Google's real response shapes (`models/` prefixed names, paged model lists, `usage.total_input_tokens`).

## 0.1.0

- Initial release: expose Google Gemini Decision 1 as a System One (OpenRouter schema) decision provider for magpie/OpenCode.
- Request adaptation: `state`→`input`, model normalization to `gemini-decision-1`, `x-goog-api-key` auth.
- noul criteria key mapping (`true`/`false` → `true_description`/`false_description`); null criteria descriptions fall back to empty strings.
- Question-id sanitizing for Google's `[A-Za-z0-9_-]{1,64}` charset with answer-key restoration, fully transparent to callers.
- OpenRouter-standard multimodal parts (`image_url`, `input_audio`, `video_url`, `input_file`) converted to Gemini content blocks; inline `assets` map resolved into `state`.
- Zero-dependency single-file ESM plugin; 15-case offline test suite against a mock upstream.
