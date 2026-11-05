# OpenAI Decisions for Magpie

A native Magpie provider exposing OpenAI's **Decisions API** through
Magpie's existing **System One** endpoint. The model is
`openai-decisions/gpt-6-luna`; use it as a routing group's classifier or a
member of a decision-model group alongside other System One providers.

This package is proposed for `magpie-community/plugins`.
Install from a local checkout while community review and publication are pending.

## Why this plugin

Magpie already speaks System One for compatible decision providers. Add
those directly with their decision endpoint and model IDs. OpenAI
Decisions uses a different path and request/answer schema; this plugin
converts that protocol while Magpie manages accounts, routing, rate
limits, failover and request records.

The built-in OpenAI provider handles normal Chat/Responses calls. This
provider calls `POST https://api.openai.com/v1/decisions` and retains native
decision probabilities. It does not simulate decisions with chat text.
The [upstream feature request](https://github.com/yetone/magpie/issues/4316)
describes the gap this fills.

## Install and sign in

```sh
magpie plugin add /absolute/path/to/magpie-openai-decisions
magpie plugin login openai-decisions
```

Two sign-in methods:

1. **OpenAI API key**: Magpie's regular API-key sign-in and account store.
2. **Use the OpenAI key already saved in Magpie**: explicitly reuse the
   primary key of the enabled official provider whose ID is `openai`.
   The sign-in record stores a provider reference; each request reads the
   current saved key. This optional method follows `XDG_CONFIG_HOME` and
   Magpie's usual config directory.

Direct key sign-in works without a separate OpenAI provider. The package
follows the community's OpenCode 1.x/Magpie and OpenCode 2.x loader layout;
ordinary chat clients still need an explicit decision call to use it.

## One endpoint

Send a System One request to `http://127.0.0.1:3425/v1/systemone`:

```json
{
  "model": "openai-decisions/gpt-6-luna",
  "state": {"message": "What does HTTP 404 mean?"},
  "questions": {
    "intent": {
      "type": "choice",
      "instructions": "Which kind of request is this?",
      "criteria": {"question": "Asks for an explanation", "code_change": "Asks to modify code"}
    },
    "is_question": {"type": "noul", "instructions": "Does this ask a question?"},
    "effort": {
      "type": "score",
      "instructions": "How much work does this request require?",
      "criteria": ["Little work", "Some work", "Much work", "Most work"]
    }
  }
}
```

With an existing TypeSafe provider, create a decision group:

```sh
magpie group add Decisions models=typesafe/jev-latest,openai-decisions/gpt-6-luna routing=order
```

Then use `"model":"group/decisions"`. Magpie's group order and failover
decide which provider answers. A chat routing group can choose either the
decision provider or the decision group as its classifier.

## Protocol and limits

| System One | OpenAI Decisions | System One answer |
| --- | --- | --- |
| Text `state` | Text `input` | Shared evidence |
| Object/array `state` | User message containing `input_json` | Shared evidence |
| Numeric/boolean `state` | JSON text `input` | Shared evidence |
| `choice` with `criteria` map | `choice` with `choices` array | Selected value, probability map, confidence |
| `score` with ordered `criteria` | `score` with `levels` array | Expected zero-based score, legend, probability map, confidence |
| `noul` with optional true/false definitions | `predicate` | Probability in `noul` |

Structured instructions and descriptions become compact JSON. Predicate
definitions and score-level ordering are retained, including numeric and
structured descriptions. This version accepts text and ordinary JSON,
and declares no image capability. Limits: 1–400 questions, 2–255 choice
options, 2–10 ordered score levels. Unsupported fields and `box` are
rejected explicitly; compressed requests are not implemented.

Probabilities and OpenAI's confidence values are retained. Magpie derives
its own routing confidence from option probabilities; vendor confidence
fields may use different calibration, so equal raw values across
providers do not imply equal reliability.

Upstream error statuses, error bodies, retry/rate-limit headers and request
IDs are preserved. Invalid or incomplete successful answers become 502.
Cancellation propagates upstream. Calls use the fixed OpenAI Decisions
endpoint, a fresh header set and no redirects.

## Develop and contribute

```sh
npm test
```

Tests cover conversion, structured questions, answer matching, invalid
distributions, errors, cancellation and credential selection. Live Magpie
tests are separate; fixtures are not evidence of account access.
See [VERIFICATION.md](VERIFICATION.md) for the real gateway checks and limits.

From the root of the community repository, run:

```sh
bun scripts/check.mjs openai-decisions
bun test packages/openai-decisions
```

Keep `opencode2.mjs` byte-identical to the community's canonical
`scripts/opencode2.mjs`. See [NOTICE.md](NOTICE.md) for attribution. MIT license.

Review checks for protocol changes:

- Keep object/array evidence as `input_json`; serialize primitive evidence as text.
- Preserve predicate definitions, ordered score criteria and vendor probabilities.
- Distinguish transport success from complete, valid decision answers.
- Verify a real classifier call as well as the downstream chat response.
- Treat HTTP 429 as a quota/rate-limit outcome, not proof of an unsupported model.
  Record actual token usage and quota units, then pace live checks by that budget.
- Keep credentials, internal endpoints and local verification artifacts outside the distributable.

References: [OpenAI Decisions](https://developers.openai.com/api/docs/guides/decisions),
[Magpie plugins](https://github.com/yetone/magpie/blob/v0.1.3039/docs/subsystems/provider-plugins.md),
[River](https://github.com/magpie-community/plugins/tree/main/packages/river),
[System One example](https://github.com/lesnolie/magpie-free-gateways).

## 中文

统一入口复用 Magpie `/v1/systemone`：兼容 System One 的供应商直接接入，
本插件负责转换 OpenAI Decisions。支持选择、评分、是非概率，保留结构化问题、
概率、置信度、用量、错误及取消行为，可用于决策模型组和意图路由。

登录可使用独立 API key，也可明确选择复用 Magpie 已保存的官方 OpenAI
提供方。社区代码使用公开协议与通用示例；组织内部端点和凭据由本地维护。
