# Changelog

## 0.1.42

- Thinking budgets for medium, high, xhigh and max fit in one Kiro turn.
  Kiro stops a turn at about 16k output tokens. Budgets of 20k–50k spent
  that turn thinking and stopped `max_tokens` with no text and no tool
  call, which made a client that believed the output cap was much larger
  compact the conversation (plugins#1365). Those levels are now 12288,
  which leaves 4096 tokens for the answer. Low stays 10000. A catalog
  `maxOutputTokens` smaller than 16k is the cap instead, and thinking is
  fitted inside it. An explicit `thinking.budget_tokens`, when no effort
  level is named, is kept when it already fits.
- A model whose catalog omits `maxOutputTokens` reports an output limit of
  16384. One that advertises a cap keeps that cap.
- A mid-stream content filter ("Output blocked by content filtering
  policy", on CreateResponse's `error` or `response.failed`, or as a
  generateAssistantResponse exception) ends the message with stop reason
  `refusal`. A stream error that is not a content filter stays an error.
