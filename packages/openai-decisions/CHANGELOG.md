# Changelog

## 0.1.0

- Add a native Magpie decision provider for OpenAI Decisions.
- Convert System One choice, score and noul questions while retaining answer probabilities and provider confidence.
- Support API key sign-in and optional reuse of Magpie's saved official OpenAI provider.
- Preserve upstream errors and cancellation; reject unsupported request shapes explicitly.
