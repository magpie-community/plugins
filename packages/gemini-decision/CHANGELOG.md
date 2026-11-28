# Changelog

## 0.1.0

- Initial release: expose Google Gemini Decision 1 as a System One (OpenRouter schema) decision provider for magpie/OpenCode.
- Request adaptation: `state`→`input`, model normalization to `gemini-decision-1`, `x-goog-api-key` auth.
- noul criteria key mapping (`true`/`false` → `true_description`/`false_description`); null criteria descriptions fall back to empty strings.
- Question-id sanitizing for Google's `[A-Za-z0-9_-]{1,64}` charset with answer-key restoration, fully transparent to callers.
- OpenRouter-standard multimodal parts (`image_url`, `input_audio`, `video_url`, `input_file`) converted to Gemini content blocks; inline `assets` map resolved into `state`.
- Zero-dependency single-file ESM plugin; 15-case offline test suite against a mock upstream.
