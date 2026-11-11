# OpenCode Zen Free (Fork & Patched)

OpenCode Zen's free models provider plugin for magpie and OpenCode with issue #3491 fixes. Provider ID: `opencode-zen-free`.

## Fixes against Issue #3491 & Upstream Drift

1. **Endpoint Path Alignment (端点路径漂移修复)**:
   - Aligns with the modern OpenCode Console catalog and API specification:
     - Chat completions routed to `/inference/openai/v1/chat/completions` (replacing outdated `/inference/v1/chat/completions`).
     - Responses routed to `/inference/openai/v1/responses`.
     - Messages routed to `/inference/anthropic/v1/messages`.
   - Backward-compatible with legacy requests targeting `/zen/v1` or `/inference/v1`.

2. **Mitigation for 12+ Hour Resting Lockout (消除超长 Retry-After 本地死锁)**:
   - When upstream returns HTTP 429 (`FreeUsageLimitError`) with a `Retry-After` header pointing to UTC 00:00 (e.g. 36000s~50000s), magpie's in-memory `restingUntil` circuit breaker normally blocks all future requests locally for up to 14 hours.
   - This fork intercepts non-OK responses and clamps excessive `Retry-After` down to 10 seconds.
   - Result: If your IP or hotspot triggers upstream rate limits, switching proxy / IP / mobile hotspot allows immediate retries without magpie short-circuiting in memory or requiring process restart.

3. **OpenCode v2 Protocol Parity (协议特征对齐)**:
   - Updated client version to `2.2.0` (`User-Agent: opencode/latest/2.2.0/cli`).
   - For subagent / fork conversations, preserves `x-opencode-parent-session-id` and `x-parent-session-id`.
   - Injects `X-Session-Id`, `x-session-affinity`, `x-opencode-session-id`, and OpenCode environment blocks (`<env>`).

4. **Model Discovery & Catalog Sanitization (过滤失效与废弃模型)**:
   - Prunes officially deprecated models (`longcat-2.5-preview-free`, `minimax-m3.1-flash-free`).
   - Updates offline bootstrap catalog with active free models: `deepseek-v4.1-flash-free`, `glm-5.3-flash-free`, `big-pickle`, `mimo-v2.6-flash-free`, `nemotron-3.5-lightning-free`, `nemotron-3.5-super-vl-free`, `flint-40b-free`.

## Install into magpie

In your magpie plugins configuration, add this package or point directly to this directory:

```json
{
  "plugins": [
    "/home/parsifa1/Project/extern/magpie-zen"
  ]
}
```

Or install / link via pnpm:

```sh
pnpm link /home/parsifa1/Project/extern/magpie-zen
```

Login with the keyless public credential:

```sh
magpie plugin login opencode-zen-free
# Key: public
```

## Testing

```sh
bun test
```
