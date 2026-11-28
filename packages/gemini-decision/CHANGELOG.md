# Changelog

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
