# OpenAI Decisions for Magpie

A native Magpie provider exposing OpenAI's **Decisions API** through
Magpie's existing **System One** endpoint. The model is
`openai-decisions/gpt-6-luna`; use it as a routing group's classifier or a
member of a decision-model group alongside other System One providers.

**Provider id:** `openai-decisions`. **Decision model:** `gpt-6-luna`.
Verified with Magpie 0.1.3039; the minimum compatible release has not been established.

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

Install the released community package through Magpie:

```sh
magpie plugin add @magpie-community/openai-decisions
magpie plugin login openai-decisions
```

For a source checkout, including a package that is not published yet, run
from the root of `magpie-community/plugins` instead:

```sh
magpie plugin add ./packages/openai-decisions
magpie plugin login openai-decisions
```

In Magpie's Plugins page, install **OpenAI Decisions**, then sign in.
The community's distribution branch can supply a released package before
its first npm publication; a separate `npm install` is unnecessary.

### Authentication and storage

Two sign-in methods:

1. **OpenAI API key**: enter a key that can access the native Decisions API.
   Magpie stores the sign-in in `plugin-auth.json` in its configuration
   directory, with Unix permissions 0600.
2. **Use the OpenAI key already saved in Magpie**: explicitly reuse the
   primary key of the enabled official provider whose ID and preset are
   `openai`. Its configured Chat/Responses endpoints must be
   `https://api.openai.com/v1`. The plugin sign-in stores the reference
   `magpie-provider:openai`; each request reads the current primary key
   from Magpie's `providers.json`. It leaves that file unchanged.

The saved-key reader uses `XDG_CONFIG_HOME/magpie` when configured;
otherwise it uses `~/.config/magpie`, or `APPDATA/magpie` on Windows
with `~/AppData/Roaming/magpie` as its fallback. It selects the primary
key, not the provider's additional key pool. This optional keyless method
is a Magpie extension.

Direct key sign-in works without a separate OpenAI provider. Requests are
billed to the OpenAI account owning the selected key; reusing a key shares
that account's API allowance. OpenCode's regular API-key sign-in uses
its own `auth.json`. The package provides the community's OpenCode 1.x
and 2.x entry points, whose loader shapes are tested; live OpenCode decision
workflows and Windows/Linux execution have not been verified.

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

### Decision groups and automatic effort

With an existing TypeSafe provider, create a decision group. Choose a new
group name: `magpie group add` replaces a group of the same name.

```sh
magpie group add Decisions models=typesafe/jev-latest,openai-decisions/gpt-6-luna routing=order
```

Then use `"model":"group/decisions"`. Magpie's group order and failover
decide which provider answers.

For an existing chat routing group whose ID is `coding`, enable automatic
effort with this decision provider:

```sh
magpie group set coding classifier=openai-decisions/gpt-6-luna effort=auto
```

Use your own chat group's ID in place of `coding`. Set
`classifier=group/decisions` to use the decision group instead. Chat
models remain in the chat group's `models`; decision models belong in
`classifier` or in a group containing only decision models. Magpie keeps
these models out of ordinary chat catalogs. Automatic effort rates the
turn's difficulty for chat models that support reasoning.

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

## Troubleshooting

| Result | Check |
| --- | --- |
| 400 from the adapter | Use `gpt-6-luna`, text/JSON state and the documented choice, score or noul fields and limits. |
| Upstream 401/403 | Check the selected OpenAI key and its Decisions access. |
| Upstream 429 | Read the quota unit and actual token usage, honor `Retry-After` when present, and space checks by that budget. A quota refusal does not establish that a model is unsupported. |
| 503: credentials unavailable | Sign in again; for saved-key mode, check that the official `openai` provider is enabled and has a usable primary key. |
| 502 from the adapter | The upstream could not be reached or returned an incomplete/invalid decision answer; inspect Magpie's request record and any retained request ID. |

The adapter does not retry requests. Magpie owns routing and failover;
try one short question first when checking a constrained allowance.

## Develop and contribute

Tests cover conversion, structured questions, answer matching, invalid
distributions, errors, cancellation and credential selection. Live Magpie
tests are separate; fixtures are not evidence of account access.
See [VERIFICATION.md](VERIFICATION.md) for the real gateway checks and limits.

From the root of the community repository, run:

```sh
bun scripts/check.mjs openai-decisions
bun test packages/openai-decisions
```

For the Node test runner, run `npm test` from `packages/openai-decisions`.
To check installation without using your real Magpie sign-ins, use the
community harness from the repository root:

```sh
MAGPIE=/absolute/path/to/magpie scripts/try.sh openai-decisions
```

The harness keeps its own configuration under `.sandbox/openai-decisions`.
The command above lists the provider without signing in or calling OpenAI.
Keep automated tests offline and use synthetic credentials.

The plugin is registered in [index.mjs](index.mjs);
[adapter.mjs](adapter.mjs) owns request/answer conversion and the fixed
upstream fetch; [credentials.mjs](credentials.mjs) owns saved-key lookup.
Keep `opencode2.mjs` byte-identical to the community's canonical
`scripts/opencode2.mjs`. See [NOTICE.md](NOTICE.md) for attribution. MIT license.

Review checks for protocol changes:

- Keep the root README's provider table, this README, the registry's English/Chinese
  summaries and the changelog aligned with the user-visible behavior.
- State each command's working directory and separate real-use evidence from fixtures.
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

安装社区发行包后登录：

```sh
magpie plugin add @magpie-community/openai-decisions
magpie plugin login openai-decisions
```

未发布时，在社区仓库根目录运行
`magpie plugin add ./packages/openai-decisions`，再执行同一登录命令。
提供方 ID 是 `openai-decisions`，决策模型为
`openai-decisions/gpt-6-luna`；已验证 Magpie 0.1.3039。

统一入口复用 Magpie `/v1/systemone`：兼容 System One 的供应商直接接入，
本插件负责转换 OpenAI Decisions。支持选择、评分、是非概率，保留结构化问题、
概率、置信度、用量、错误及取消行为，可用于决策模型组和意图路由。

登录可使用独立 API key，也可明确选择复用 Magpie 已保存的官方 OpenAI
提供方的主 key。前者保存在 Magpie 的 `plugin-auth.json`；后者只保存引用，
每次请求从 `providers.json` 读取当前主 key，共用该 key 所属 OpenAI 账号的 API
额度。已有聊天组可设置 `classifier=openai-decisions/gpt-6-luna effort=auto`，
也可把分类器设为决策模型组 `group/decisions`。

遇到 429 时按错误中的额度单位、实际 token 用量和 `Retry-After` 拉开调用间隔，
不要据此判断模型不受支持。真实 OpenCode 决策流程及 Windows/Linux 尚未验证；
完整验证范围见 [VERIFICATION.md](VERIFICATION.md)。社区代码使用公开协议与通用
示例；组织内部端点和凭据由本地维护。
