# OpenAI Decisions for Magpie

A provider exposing OpenAI's native **Decisions API** through Magpie's
**System One** interface. Use it as a chat routing group's classifier or
as a member of a decision-model group with other System One providers.

**Provider id:** `openai-decisions`. **Model:** `openai-decisions/gpt-6-luna`.

Magpie already speaks System One for compatible decision providers. OpenAI
uses a different path and question/answer schema, which this plugin converts.
The built-in OpenAI provider serves Chat/Responses; this provider calls
`POST https://api.openai.com/v1/decisions` and returns native probabilities.

## Install and sign in

Install a released community package through Magpie:

```sh
magpie plugin add @magpie-community/opencode-openai-decisions-auth
magpie plugin login openai-decisions
```

For an unpublished package or a source checkout, run from the root of
`magpie-community/plugins` instead:

```sh
magpie plugin add ./packages/openai-decisions
magpie plugin login openai-decisions
```

In Magpie's Plugins page, install **OpenAI Decisions**, then sign in with
an OpenAI API key that can access Decisions. The community's distribution
branch can supply a released package before its first npm publication.

### Credentials and compatibility

The plugin receives the selected account's API key from the host's
`getAuth` callback. Magpie keeps the sign-in in its `plugin-auth.json`
(Unix permissions 0600); OpenCode keeps it in its own `auth.json`.
Requests use the selected key's OpenAI API allowance. Account/key changes
and sign-out are read again for each request.

The loader layout supports Magpie/OpenCode 1.x and the community's OpenCode
2.x compatibility bridge. This is a decision provider; ordinary chat clients
need an explicit decision call to consume its output. Live OpenCode decision
workflows and Windows/Linux execution have not been verified. Earlier
gateway checks used Magpie 0.1.3039; a minimum compatible release has not
been established.

## Use System One

Send this request to `http://127.0.0.1:3425/v1/systemone`:

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

With an existing TypeSafe provider, create a group containing only decision
models. Choose a new name: `magpie group add` replaces a group of the same name.

```sh
magpie group add Decisions models=typesafe/jev-latest,openai-decisions/gpt-6-luna routing=order
```

Use `"model":"group/decisions"` to let Magpie's order and failover pick the
provider. For an existing chat group whose ID is `coding`, enable automatic
effort with:

```sh
magpie group set coding classifier=openai-decisions/gpt-6-luna effort=auto
```

Replace `coding` with your group's ID. Use `classifier=group/decisions`
to select the decision group instead. Chat models belong in the chat group's
`models`; decision models belong in `classifier` or a decision-only group.
Magpie keeps decision models out of ordinary chat catalogs.

## Protocol and limits

| System One | OpenAI Decisions | Returned answer |
| --- | --- | --- |
| Text `state` | Text `input` | Shared evidence |
| Object/array `state` | User message containing `input_json` | Shared evidence |
| Numeric/boolean `state` | JSON text `input` | Shared evidence |
| `choice` with a criteria map | `choice` with options | Selected value, probability map, confidence |
| `score` with ordered criteria | `score` with levels | Expected zero-based score, legend, probabilities, confidence |
| `noul` with optional true/false criteria | `predicate` | Probability in `noul` |

Structured instructions and descriptions become compact JSON. Predicate
definitions and score ordering are retained. If instructions are omitted,
null or blank, the adapter supplies:
`Answer this question using the supplied input and criteria.`
Explicit non-empty instructions are preserved.

An upstream question with `type: "refusal"` is omitted from `answers`;
other questions retain their answers, probabilities and usage. If every
question is refused, `answers` is empty. A refusal does not invent a choice
or probability. Missing, duplicate, unrequested or invalid ordinary answers
remain errors and produce HTTP 502.

This version accepts text and ordinary JSON, with 1–400 questions, 2–255
choice options and 2–10 ordered score levels. Unsupported fields, images
and `box` are outside its declared capabilities; compressed requests are
not implemented. OpenAI's confidence is retained. Magpie derives its own
routing confidence; values from different vendors need separate calibration.

Upstream error status/body, retry/rate-limit headers and request IDs are
preserved. Cancellation propagates upstream. Requests use the fixed OpenAI
endpoint, a fresh header set and no redirects.

## Troubleshooting

| Result | Check |
| --- | --- |
| 400 | Use the documented model, question fields and limits. |
| Upstream 401/403 | Check the selected key and its Decisions access. |
| Upstream 429 | Check quota units and actual token usage, honor `Retry-After` when present and space checks accordingly. |
| 503: credentials unavailable | Sign in to OpenAI Decisions with an API key again. |
| 502 | Inspect Magpie's request record: the upstream was unreachable or returned an invalid/incomplete ordinary answer. |

The adapter does not retry. Magpie owns routing and failover. A quota refusal
does not establish that a model is unsupported; start with one short question
when testing a constrained allowance.

## Develop and contribute

From the community repository root:

```sh
bun scripts/check.mjs openai-decisions
bun test packages/openai-decisions
```

For Node's test runner, run `npm test` from `packages/openai-decisions`.
To install and list the provider without signing in or using a real account:

```sh
MAGPIE=/absolute/path/to/magpie scripts/try.sh openai-decisions
```

The harness isolates configuration under `.sandbox/openai-decisions`.
Automated tests use in-memory synthetic credentials and injected fetches;
they make no vendor calls or credential fixtures on disk.

[index.mjs](index.mjs) registers the provider and selected-account auth.
[adapter.mjs](adapter.mjs) converts requests/answers and sends the fixed
upstream request. Keep `opencode2.mjs` byte-identical to the community's
canonical `scripts/opencode2.mjs`. See [NOTICE.md](NOTICE.md) for attribution
and [VERIFICATION.md](VERIFICATION.md) for evidence and untested scope.

Review checks:

- Receive credentials only through the host's selected-account auth.
- Preserve predicate definitions, score ordering and vendor probabilities.
- Keep per-question refusals separate from invalid or missing answers.
- Supply non-empty instructions when System One omits or blanks them.
- Keep tests offline and free of credential files; code comments use English.
- Keep the root README, package README, bilingual registry and changelog aligned.
- Verify live routing separately from fixtures; pace live checks by actual quota.
- Keep credentials, internal endpoints and local artifacts outside the package.

References: [OpenAI Decisions](https://developers.openai.com/api/docs/guides/decisions),
[Magpie provider contract](https://github.com/yetone/magpie/blob/v0.1.3039/docs/subsystems/provider-plugins.md).

MIT. Not affiliated with OpenAI.

## 中文

安装社区发行包并使用 OpenAI API key 登录：

```sh
magpie plugin add @magpie-community/opencode-openai-decisions-auth
magpie plugin login openai-decisions
```

未发布时，在社区仓库根目录使用
`magpie plugin add ./packages/openai-decisions`，再执行同一登录命令。
提供方 ID 保持 `openai-decisions`，模型为 `openai-decisions/gpt-6-luna`。

统一入口为 Magpie `/v1/systemone`。支持选择、评分和是非概率；已有聊天组可设置
`classifier=openai-decisions/gpt-6-luna effort=auto`，也可使用决策模型组
`group/decisions`。凭据由宿主提供当前选中账号的 API key，登录记录保存在宿主的
`plugin-auth.json` 或 `auth.json`，请求使用该 key 所属账号的 API 额度。

单题被拒绝时只省略该题，其余答案继续返回；全部拒绝时答案为空。缺省或空白指令会
补上非空默认描述，结构化指令和判断条件仍保留。遇到 429 按额度单位、实际 token
用量与 `Retry-After` 放慢调用。真实 OpenCode 决策流程及 Windows/Linux 尚未验证；
完整范围见 [VERIFICATION.md](VERIFICATION.md)。
