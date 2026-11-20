# OpenRouter Decisions for Magpie

A provider exposing **OpenRouter's [Decisions API](https://openrouter.ai/docs/guides/features/decisions)**
through Magpie's **System One** interface. Use it as a chat routing group's
classifier (intent or reasoning effort) or as a member of a decision-model
group with other System One providers.

**Provider id:** `openrouter-decisions`. **Models:**
`openrouter-decisions/microsoft-decision-1.1` and
`openrouter-decisions/microsoft-decision-1` (Microsoft's System One decision
models on OpenRouter; 1.1 reads text and images, 1 is text-only and cheaper).

Magpie already speaks System One for compatible decision providers. OpenRouter
speaks the same question/answer dialect on a different path with a few extra
constraints, which this plugin converts:

| System One | OpenRouter Decisions |
| --- | --- |
| `POST /v1/systemone` (via the plugin's `fetch`) | `POST https://openrouter.ai/api/alpha/decisions` |
| `model: "microsoft-decision-1.1"` | `model: "microsoft/microsoft-decision-1.1"` |
| object / number / boolean `state` | JSON text `state` |
| `choice` with a `choices` array | expanded to a `criteria` map |
| blank criteria text | the option name, then a positional label |
| `score` with ordered criteria | same array, blank levels labeled |
| `noul` with optional true/false criteria | same fields |

Answers are converted back with validation: probabilities must cover every
option and sum to one (±0.02), a `score` must land inside `0..N-1`, and a
per-question `refusal` stays a refusal while other answers and usage are
kept.

## Install and sign in

Install a released community package through Magpie:

```sh
magpie plugin add @magpie-community/opencode-openrouter-decisions-auth
magpie plugin login openrouter-decisions
```

For an unpublished package or a source checkout, run from the root of
`magpie-community/plugins` instead:

```sh
magpie plugin add ./packages/openrouter-decisions
magpie plugin login openrouter-decisions
```

In Magpie's Plugins page, install **OpenRouter Decisions**, then sign in with
an OpenRouter API key (`sk-or-…`). The key is kept in Magpie's
`plugin-auth.json` (Unix permissions 0600); requests use the selected key's
OpenRouter allowance.

## Use as a classifier

As an intent classifier:

```sh
magpie group add my-group models=provider/model-a,provider/model-b routing=order
magpie group rule add my-group use=provider/model-a intent="a hard task: designing or debugging"
magpie group set my-group classifier=openrouter-decisions/microsoft-decision-1.1
```

As an effort classifier (the group needs at least two models, and members
need reasoning levels):

```sh
magpie group set my-group classifier=openrouter-decisions/microsoft-decision-1.1 effort=auto
```

## Call System One directly

```sh
curl -s -X POST http://127.0.0.1:3425/v1/systemone \
  -H "Authorization: Bearer $MAGPIE_KEY" -H "Content-Type: application/json" \
  -d '{
    "model": "openrouter-decisions/microsoft-decision-1.1",
    "state": {"message": "What does HTTP 404 mean?"},
    "questions": {
      "is_question": {"type": "noul", "instructions": "Does this ask a question?"},
      "intent": {
        "type": "choice",
        "instructions": "Which kind of request is this?",
        "criteria": {"question": "Asks for an explanation", "code_change": "Asks to modify code"}
      },
      "effort": {
        "type": "score",
        "instructions": "How much work does this request require?",
        "criteria": ["Little work", "Some work", "Much work", "Most work"]
      }
    }
  }'
```

A real response:

```json
{
  "model": "microsoft/microsoft-decision-1.1-20261117",
  "answers": {
    "is_question": {"type": "noul", "noul": 0.998},
    "intent": {"type": "choice", "choice": "question",
      "probabilities": {"question": 0.998, "code_change": 0.0017}, "confidence": 0.9966},
    "effort": {"type": "score", "score": 0.179,
      "legend": {"0": "Little work", "1": "Some work", "2": "Much work", "3": "Most work"},
      "probabilities": {"0": 0.858, "1": 0.112, "2": 0.021, "3": 0.0086}, "confidence": 0.811}
  },
  "usage": {"input_tokens": 114, "output_tokens": 3, "cost": 0.000004788},
  "provider": "Azure"
}
```

## Usage

`auth.usage` reads OpenRouter's `/api/v1/auth/key` and `/api/v1/credits`;
`magpie quota` shows the credit window, its percentage and the remaining
balance.

## Protocol and limits

- Only `POST /v1/systemone` is accepted; other paths and methods are refused
  with 400 and never sent upstream.
- The upstream request goes to the fixed `https://openrouter.ai/api/alpha/decisions`
  with a fresh header set, no redirects, and no gateway headers or cookies.
- 1–400 questions, 2–255 choice options, 2–10 ordered score levels.
- Upstream error status, body, `Retry-After`, `x-request-id` and
  `x-ratelimit-*` headers pass through unchanged.
- Cancellation propagates; HTTP error answers are never retried. One quick
  network-level retry absorbs a momentary proxy or DNS failure.
- The decision models stay out of the chat catalog and refuse conversation.
- The adapter does not retry rate limits and owns no failover; Magpie routes.

## Develop and contribute

```sh
npm test                                  # or: node --test test/*.test.mjs
bun scripts/check.mjs openrouter-decisions   # from the community repo root
MAGPIE=/absolute/path/to/magpie scripts/try.sh openrouter-decisions
```

The tests are offline: credentials and responses are synthetic and in-memory,
and no test writes a credential file or touches the network.

[index.mjs](index.mjs) registers the provider, the selected-account auth and
the usage hook. [adapter.mjs](adapter.mjs) converts requests and answers and
sends the fixed upstream request. Keep `opencode2.mjs` byte-identical to the
community's canonical `scripts/opencode2.mjs`. See [NOTICE.md](NOTICE.md)
for attribution and [VERIFICATION.md](VERIFICATION.md) for live evidence and
untested scope.

Review checks:

- Receive credentials only through the host's selected-account auth.
- Preserve probabilities, confidence, the score legend and per-question
  refusals.
- Supply non-empty instructions and criteria wherever the upstream requires
  them.
- Keep tests offline and free of credential files; code comments use English.
- Keep the root README, package README, bilingual registry and changelog
  aligned.
- Verify live routing separately from fixtures; pace live checks by actual
  quota.
- Keep credentials, internal endpoints and local artifacts outside the
  package.

References: [OpenRouter Decisions](https://openrouter.ai/docs/guides/features/decisions),
[Magpie provider contract](https://usemagpie.ai/docs/plugins#provider).

MIT. Not affiliated with OpenRouter or Microsoft.

## 中文

安装社区发行包并使用 OpenRouter API key 登录：

```sh
magpie plugin add @magpie-community/opencode-openrouter-decisions-auth
magpie plugin login openrouter-decisions
```

未发布时，在社区仓库根目录使用
`magpie plugin add ./packages/openrouter-decisions`，再执行同一登录命令。
提供方 ID 为 `openrouter-decisions`，模型为
`openrouter-decisions/microsoft-decision-1.1` 与
`openrouter-decisions/microsoft-decision-1`。

统一入口为 Magpie `/v1/systemone`。支持选择、评分和是非概率（含概率分布、
置信度与评分档位说明）；单题拒绝（refusal）原样保留，其余答案与用量不受影响。
作为意图分类器时，路由记录会显示命中的意图与 `sure` 置信度；作为推理强度
分类器时，用评分题给每一轮打难度（组内需至少两个带推理档位的模型）。

凭据由宿主提供当前选中账号的 API key；用量钩子读取 OpenRouter 的额度与
余额，显示在 `magpie quota` 与供应商卡片上。只接受发往固定上游地址的请求，
错误状态码、`Retry-After` 与限流头原样透传；瞬时网络故障自动快速重试一次，
HTTP 错误回答不重试，故障切换交给 magpie。

## 客户端兼容性

- Magpie：完整支持（意图分类器、推理强度分类器、决策模型组、`/v1/systemone`）。
- OpenCode 1.x：加载与登录可用；决策输出需要客户端自己发起决策调用。
- OpenCode 2.x：通过 `opencode2.mjs` 桥接加载；决策工作流未端到端验证。
