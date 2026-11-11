# Changelog

## 0.1.0

- Add a native Magpie decision provider for OpenAI Decisions.
- Convert System One choice, score and noul questions while retaining probabilities, provider confidence and usage.
- Use standard API-key sign-in and the host's selected-account auth; remove direct reads of Magpie's credential store.
- Omit per-question refusals while preserving other answers, and supply non-empty default instructions.
- Preserve upstream errors and cancellation; reject unsupported or invalid ordinary request/answer shapes.
- Use the community provider package name, inline SVG icon and canonical OpenCode compatibility bridge.
- Document installation, credential ownership, classifier setup, quota handling and verification limits.
