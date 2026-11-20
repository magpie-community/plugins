# Reference

What this plugin does that AgentCompass itself does not: its two modes, its options, the names it registers, its limits inside Magpie and its profile contract. How the engine scores (the four categories, the data gates, the quota economy, the order of rows) is AgentCompass's, written once in [`docs/technical-reference.md`](https://github.com/akiiwa-games/AgentCompass/blob/v0.7.3/docs/technical-reference.md#1-how-scoring--allocation-work) and [`router-internals.md`](https://github.com/akiiwa-games/AgentCompass/blob/v0.7.3/skills/agent-compass/references/router-internals.md) at the tag this plugin is pinned to; this file does not repeat them. Model names are the public catalogue's: [`model-capabilities.md`](https://github.com/akiiwa-games/AgentCompass/blob/v0.7.3/skills/agent-compass/references/model-capabilities.md).

## Contents

[Modes](#modes) · [Task profile](#task-profile) · [Without a profile](#without-a-profile) · [Candidates, pins and refusals](#candidates-pins-and-refusals) · [Session continuity](#session-continuity) · [Quotas and accounts](#quotas-and-accounts) · [Options](#options) · [Names by install source](#names-by-install-source) · [Limits inside Magpie](#limits-inside-magpie) · [Layout and tests](#layout-and-tests)

## Modes

| | Mode A: gateway middleware (default) | Mode B: decision provider (opt-in) |
|---|---|---|
| Declared by | `magpie.middleware` in `package.json` | `enableDecisionProvider: true`; model `agentcompass/agentcompass-systemone`, served at `/v1/systemone` |
| Runs in | Magpie's `moejs`: synchronous, no network, no file system | A Bun process: may call a classifier |
| Asks | Requests to `agentcompass`, `agentcompass/*`, the names in `routeModelTriggers`, or every model with `routeAllModels: true` | A Routing Group whose classifier is the decision model |
| Result | Rewrites `body.model` to `<model>:<effort>` and sets the protocol's effort field (`reasoning_effort`, `reasoning.effort`, `output_config.effort`); at `default`, the bare model and no effort | Answers the group's `intent` / `level` / `effort` questions |
| Profile from | The request only (`body.profile`) | The state of the request, or the classifier (`allowExternalScorer: true` and a `scorer`) |

The package declares no `magpie.hooks`, so Mode A cannot call a classifier. `src/hooks.js` (a Bun async hook that can) is exported as `agentcompass/hooks` for hosts that load it, and routes the same profile to the same answer as the other two (`test/router.test.mjs`).

Mode B, with a classifier (`<spec>` is what `magpie plugin list` shows):

```sh
magpie plugin options <spec> '{"enableDecisionProvider": true, "allowExternalScorer": true, "scorer": {"kind": "openai_compatible", "baseUrl": "http://127.0.0.1:4096/v1", "apiKey": "<key>", "model": "gemini-3.8-flash-high"}}'
magpie plugin login agentcompass
magpie group set <group> effort=auto classifier=agentcompass/agentcompass-systemone
```

- Without a classifier model Mode B answers `none of these` on every turn.
- A group's label is answered directly when it equals the route's `work_kind`, `difficulty` or model; any other label is the operator's own words, and the classifier is asked which one fits (one more call on that turn).
- The scorer is `scorer.kind` `openai_compatible` (default; `model` defaults to `gemini-3.8-flash-high`) or `jev`; the flat options `scorerType`, `scorerBaseUrl`, `scorerApiKey`, `scorerModel`, `jevBaseUrl`, `jevApiKey` and `scorerTimeoutMs` (clamped to 100..55000 ms) are the same settings. An answer that is not a valid profile is retried once, then the request is not routed (`classifier_invalid_output`); an answer is never repaired. The `openai_compatible` scorer gets AgentCompass's prompt (`scorer_client.SCORER_PROMPT`, verbatim, plus one line on `previous_user`) and the classifier cases of `references/classifier-cases.json` at the pinned commit, compacted the same way (about 18 KB of rubric before the task); `jev` gets the same ten questions as AgentCompass's question APIs, over the task and the dimension rubric.
- The `effort` answer is a score on Magpie's scale (0 to 3: `low`, `medium`, `high`, `xhigh`; `internal/gateway/decide.go` `jevLevels`). An effort outside the scale answers its nearest end (`none` and `minimal` 0, `max` and `ultra` 3), and `default` answers what the data reads it as (High, 2). A route with no effort the scale names gets no `effort` answer, so Magpie keeps the effort the request asked for (`EFFORT_TO_JEV_SCORE`, `src/index.js`).
- Answers are cached by task and structured fields (`useCache: false` turns it off).
- By default an answer holds only the model and effort, or `{ targetModel: null, blocked: true, error, message }`. Any gateway key that may use the decision model can call `/v1/systemone`, so accounts, quotas, the profile and `warnings` stay in the local log unless `decisionProviderDetails: true`. A refusal of a pin is then `pin_unavailable`, with no name in it (whether a pinned name is in the pool or healthy is the operator's to know), except a malformed pin: it answers `invalid_model_pin` and what is wrong with it, which quotes the pin as the caller typed it. That text is the caller's own, not a fact of the operator's pool, so it is not redacted.

## Task profile

A profile comes from the classifier or the caller, never from the words of a task: `test/no-hardcode.test.mjs` scans `src/` for it, and routes the same profile across a corpus of trigger words (`test/task_text_corpus.mjs`) to the same answer.

A caller sends it as `body.profile`, `ctx.state.profile` or `ctx.profile` (on `/v1/systemone`: `state.task.profile` or `state.profile`). The middleware removes `body.profile` before the upstream sees it. A valid profile (`test/profile.mjs` builds one):

```json
{
  "work_kind": "code_implementation",
  "primary_level": 2,
  "secondary_kind": "none",
  "secondary_level": 0,
  "access": "write",
  "local_only": false,
  "needs_visual": false,
  "wants_fast": false,
  "expected_hours": 0.5,
  "task_count": "1",
  "axis_demand": { "creativity": 0, "coding": 2, "aesthetics": 0, "tool_operation": 0 }
}
```

- Required (AgentCompass v0.7.3 `task_intake.TASK_PROFILE_SCHEMA`): `work_kind`, one of the 11 work kinds (`creative_ideation`, `architecture_reasoning`, `code_implementation`, `frontend_ui`, `code_audit`, `exploration_forensics`, `web_research`, `visual_analysis`, `text_processing`, `live_loop`, `gui_control`); `primary_level` 1..3; `secondary_kind` (`none` or a second work kind, different from `work_kind`) with `secondary_level` (0 exactly when `secondary_kind` is `none`, else 1..3); `access` (`read-only` or `write`); `local_only`, `needs_visual`, `wants_fast` (booleans); `expected_hours` (clamped to 0.05..24); `task_count` (`"1"`, `"2"`, `"3"` or `">3"`; a positive integer is bucketed). `reason` is optional.
- Derived, and checked when given: `needs_gui` (either kind is `gui_control`), `needs_visual` (forced true by `gui_control` or `visual_analysis`), `read_only_review` (`code_audit`), `multi_task` (`task_count` is not `"1"`).
- `axis_demand`, the demand per category (0..3 each), is projected from the kinds and levels through AgentCompass's declared signature table (`WORK_KIND_SIGNATURES`, `projectAxisDemand` in `src/profiler-core.js`); a caller may state it explicitly, and then it stands as given. The classifier never answers it.
- Contradictions are refused: `code_audit` with `access: "write"`, and a `local_only` `code_implementation` or `frontend_ui` with `access: "read-only"`.
- An image part in the request is read as structure: it sets `needs_visual` and takes `axis_demand.tool_operation` to 3, whatever the profile says.
- A profile that does not validate counts as none, with the code `invalid_caller_profile`. A profile of an older shape (0.2.x: `reasoning_depth`, `code_complexity`, `interaction_style`, `divergence`; 0.1.x: `context_scale`, `hallucination_risk`, ...) is refused, not repaired: it has no `primary_level` and none of the 11 work kinds.

## Without a profile

Where a request gets its profile, in order: the caller, then the classifier (Mode B, `src/hooks.js`). With neither, or when the classifier fails or times out, **there is no routing decision and no guess**; the plugin raises no error of its own.

| Entry | What the request does | Where it says so |
|---|---|---|
| Middleware (Mode A) | Goes on with `body.model` as the client sent it and no effort added. A virtual name (`agentcompass/auto`) is the router's alone, so it becomes `defaultModel`; with no `defaultModel` it stays, Magpie has no model of that name, and the client gets Magpie's error (HTTP 404 in the sandbox) with nothing sent upstream | `ctx.state.agentcompass`, Magpie's log (`agentcompass: 未路由：分类不可用 (<reason>)`), and `agentcompass: { routed: false, notice, reason }` on a JSON reply, an error's included (chat, responses, messages) |
| Hooks | Writes no `ctx.state.route`, so the middleware above decides | `ctx.state.agentcompass`, the log |
| `/v1/systemone` (Mode B) | `intent` / `level` answer `none of these`, so the group's fallback rule applies; no `effort`; the levels probe answers "not a scale" | `agentcompass: { routed: false, notice, reason }` in the answer, the log |

An unrouted request records nothing in the session store. A virtual model with neither `candidateModels` nor `defaultModel` is refused with HTTP 400 naming both: that is a configuration error, not a classification one. `scorerType: "heuristic"` and `prefer_local_heuristic` no longer exist and count as no classifier.

## Candidates, pins and refusals

`candidateModels` (aliases `availableModels`, `allowedModels`, `models`) lists the names the plugin may route to: a bare model name, `model:effort`, a row with `efforts[]`, or a full bundle (`{ id, provider, account, model, effort, when }`). A virtual model without `candidateModels` or `defaultModel` is refused (HTTP 400, `agentcompass: a virtual model needs candidateModels or defaultModel in the plugin's options`). With `routeAllModels: true` and no `candidateModels`, a concrete model name is kept and only the effort is injected.

- **The efforts of a row**: a row with `efforts[]` (in `candidateModels` and its aliases or in `modelsByProvider`) is routed at exactly the efforts it lists. The list is the operator's declaration: it is not checked against the launch table this version ships (`dispatch_efforts`, from AgentCompass `references/accounts.json`) and is not read from Magpie's gateway model list. An effort the upstream cannot run fails there, with the upstream's own error. The table applies only to a row that lists no efforts (a bare name): such a row is offered at the table's efforts for its provider. If Magpie hands the middleware `ctx.models` or `ctx.availableModels` (the plugin reads them after its own options; this was not verified against Magpie), the same rule applies to their rows. A listed effort that the shipped data does not score (no Time/Task, or no category score the task demands, at that effort) takes the data-error path below. AgentCompass itself has no such input: it launches with CLI flags and reads no list of efforts, so its table is its only source; for a row with `efforts[]` the port departs from `allocator.plan` for that reason only.
- **Where rows come from, and `default`**: every row is one the operator writes into the options (`candidateModels` and its aliases, `modelsByProvider`), as a bare name or with `efforts[]`. Magpie hands a middleware no model list (`ctx.models` and `ctx.availableModels` are read, but Magpie 0.1.4470 sets neither), and the plugin keeps no catalog of the host's own. A bare name the operator writes by hand follows the bare-name rule above. A row converted from Magpie's listing never does: [the script](#candidates-from-the-gateway) writes a model listed with no reasoning levels as `{ "model": <id>, "efforts": ["default"] }`, the model's one configuration (AgentCompass `audit/gateway_coverage.py`). A `default` row is one candidate, scored and timed where the data reads `default` (High, `FIVE_AXIS_EFFORT_READINGS`), and the middleware sends it as the bare model id with no effort field: `default` is no level Magpie knows (`provider.MemberEfforts`, `none` to `max`), so `<model>:default` would name another model.
- **Automatic routing never picks a name that has no scores**: a family or unknown name (`claude-opus-9`) is out of automatic routing with a data-error warning, and is dispatched only when named. A family name is not scored as its series' row: it has no scores of its own. `candidate name <name> is not in the catalog: ...` is logged once per runtime and put in `warnings`.
- **Which row a served name is** (`provider_names`, AgentCompass `model_resolution.resolve_model`): for each spelling of a name in turn (as given, each vendor tag stripped, a dash effort dropped), the serving provider's own declaration is read first, then the maker's default (a name its maker moved to a newer dated snapshot reads as that snapshot: `deepseek-v4-pro` as `deepseek-v4-pro-0813`, `deepseek-v4-flash` as `deepseek-v4.1-flash-1017`; a maker's repository id such as `deepseek-ai/DeepSeek-V4-Pro` as its own undated row), then the row of that spelling. The serving provider is the part before the first `/` of a candidate's name: Magpie lists every chat model as `<preset>/<model>` (`gateway.go` `modelObject`), which is what [the script](#candidates-from-the-gateway) writes, so a converted row reads its preset's declarations. Every table (a provider's declaration, a maker's default, a row, an alias) is read in one order, the full id, then what follows each `/` in turn, then the last segment (`model_resolution.slash_suffixes`), so a list id whose model part holds a `/` (`google-vertex/openai/gpt-oss-120b-maas`) reads its `<publisher>/<model>` alias exactly as a `modelsByProvider` list of that preset reads the name. A Magpie preset whose id is not the models.dev catalog it serves (`provider_names.host_providers.magpie`, from Magpie's `presets.go`: `opencode-zen` serves `opencode`, `tencent-cloud` serves `tencent-tokenhub`, 17 presets) reads that catalog's declarations: `opencode-zen/deepseek-v4-flash` is OpenCode's own `deepseek-v4-flash`, other weights with no row. The plugin reads a preset id this way only where Magpie gives it one (the first segment of a name in the plugin's options, `ctx.provider.id` in `onProvider`); the same text read by anything else (the Cindy plugin, a direct caller of the allocator) is a provider id like any other. A name in `modelsByProvider` is read on the preset Magpie is trying (`ctx.provider.id`): a name that preset declares is routed by the spelling that keeps reading the declaration, `<provider>/<model>` for a name declared with no row (the provider the declaration is on, the name as declared: `opencode/deepseek-v4-flash` for `deepseek-v4-flash-high` on `opencode-zen`, with its effort kept as `:high`) or as a row whose own id its maker moved to another, and the row's id for a name declared as another row than the bare name reads. Whenever the route lands on such a spelling, also when the route `onRequest` chose stands on that preset, the body goes to the preset under the name it lists. In Magpie 0.1.4470 this rewrite reaches only a direct caller of the middleware: after `onProvider` the gateway itself writes the member's model into the upstream request (`passthrough` and `translate` set `body.model` from the member it chose). A bare name you write by hand in `candidateModels` names no provider: it reads the maker's default and its row. Names and provider ids are matched lowercase.
- **A pair with no row on its provider** (`retired`: the maker shut the name down there; `other_weights`: the provider's listing serves other weights than any row) is its own model, `<provider>/<model>`, never the row the same name is elsewhere: it has no scores, so it leaves automatic routing with a data error, and `candidate name <name> has no row: <provider> no longer serves this name (retired) ...` (or `... serves this name as weights the public data has no row for (other_weights) ...`) is put in `warnings`. Naming it (a pin) still dispatches it. Its failures count against it alone (`healthKey`). A name whose serving providers declare different rows has no row either (`conflict`).
- **Turning off an effort**: add a row with `disabled: true` next to the bare name or `efforts[]` row, e.g. `["gpt-6.1-sol", { "model": "gpt-6.1-sol", "effort": "medium", "disabled": true }]`. No row of that account and model is dispatched at that effort, pinning it is refused (`pin_unavailable`), and a session held on it leaves it. A disabled row with an `account` applies to that account only. A disabled row listed under a preset (`<preset>/<model>`, or a name in that preset's `modelsByProvider` list) turns the effort off on that preset only (presets that serve one catalog, `qwen`, `qwen-cn` and `qwencloud`, or `zai` and `zhipu`, are separate presets); a bare disabled row turns it off on every row of that model on the account, on every preset (in 0.3.0 a row under one preset turned the effort off on every preset of a row with no quota account); a family row is another model, so disabling `claude-opus-5-5` does not touch `claude-opus-9`.
- **Pins**: `constraintModel` / `pinnedModel` (optionally `:effort` or `-effort`), `constraintEffort` / `pinnedEffort`, `constraintBundle` / `pinnedBundle`. A pin that cannot be served is refused with a code; no other model is substituted. Which rows a pinned model names is decided over every row of the pool before any filter (an unchecked row, one marked unavailable or unhealthy, one its `when` keeps out, one that offers another effort); those filters then apply to the named rows only, each out with its own reason, and the best of the rest is routed (AgentCompass `account_fleet.pin_matching_bundles`, owner's rule of 2026-11-20). A bare name (no `/`) names the model on every candidate: each row whose model is the pin's model as that row reads names (a name's own row, a pair with no row there as `<provider>/<model>`, an unmeasured name by its own name), whatever it is spelled. A name with a prefix, `P/name`, is obeyed: it names the rows `P` names, one spelled as typed (case and effort aside) or one of the pin's model whose account, provider, catalog it serves or Magpie preset is `P` (a list id `<preset>/<model>` is offered on its preset, and so is every name of a preset's `modelsByProvider` list; `opencode-zen/...` and `opencode/...` both name OpenCode Zen's rows), and no other. The prefix is the longest leading part of the name that names something in the pool and, with the rest of the name, a row, then the shorter parts, so it may hold a `/`: with a seat `claude/work` that offers no `custom-m` and the preset `claude` listing `work/custom-m`, `claude/work/custom-m` is that preset's row. A leading part that names something but no row with the rest is obeyed, and the pin refused, only when no shorter part names a row. A Magpie seat is a quotas key `<provider>/<account>` (`claude/work`); a seat prefix names it three ways: the seat's full id (`claude/work/claude-sonnet-5-5`) names that seat only, the seat name (`work/claude-sonnet-5-5`) names the seats of that name, and the provider (`claude/claude-sonnet-5-5`) names every seat of the provider. A seat prefix decides which rows the plugin picks and refuses; it cannot bind which seat Magpie sends the request on (`onAccount`, below). When none of the named rows or seats can run the pin is refused, never served by the same model elsewhere (write the bare name when any candidate will do). A prefix that names nothing in the pool is dropped and the rest is read as the pin from the start, each level of a name with several `/` decided again: with nothing named `opencode` in the pool, `opencode/deepseek-v4-flash` is the bare `deepseek-v4-flash`. Where a prefix names a candidate, a pin never names a family row, never the scored row of a name beside the provider that serves it as other weights (`opencode/deepseek-v4-flash` and `deepseek/deepseek-v4-flash`), and never a moved name's snapshot for the repository id of its earlier weights (`deepseek-ai/DeepSeek-V4-Pro` and `deepseek-v4-pro`). A malformed name (an empty part around a `/` or a `:`, a bare `:high`, an `auto:` id without its account and harness, a blank or a value that is not text) is refused with `invalid_model_pin` and what is wrong with it (AgentCompass `model_resolution.check_model_pin`). A model Magpie serves that is in no pool (a routing group's members, a signed-in account's maker) is not a candidate, so a prefix naming only those names nothing and is dropped. A `constraintBundle` names that row only; a bundle id given as the model names that row and the rows of its model. Pin fields are removed from requests the plugin does not route. A `:auto`, `:off` or `:default` on a candidate name does not constrain the effort; on a pin `:default` names the effort `default`, which only a row listing it offers (a model's one configuration: where rows come from, above).

  What each entry reads as the pool, and what a user gets for a prefix that names another preset (`<other-preset>/<model>`):
  - **`onRequest` with `candidateModels`**: the pool is those rows (the operator's options, or the converter's rows from Magpie's `/v1/models`), every preset at once. The pin is decided there: it routes to the named preset's row, or the request is refused with 503 and a code (below) before any upstream is tried.
  - **Mode B (`/v1/systemone`) and `src/hooks.js`**: the same rule over the rows they read, before any hold; Mode B answers a refusal as in [Modes](#modes), and `hooks` leaves it for `onRequest` to refuse.
  - **`onProvider`** (`modelsByProvider`, or `routeAllModels` with no `candidateModels`): the pool is the tried preset's own list with the rows you unchecked; the other presets' rows (of `candidateModels`, and of the other presets' `modelsByProvider` lists, each offered on its preset) are read only to decide what a pin names, and never compete there. A prefix that names only another preset's row is not served from this preset's list: the plugin does not rewrite the body and does not record the route as its own. It cannot refuse it: Magpie's `onProvider` can neither reject nor skip a preset (`internal/middleware/run.go`: a returned `undefined` leaves the body as it is), so Magpie still sends the attempt to the preset it is trying, with the body as `onRequest` left it. To have such a pin refused instead, list the presets' rows in `candidateModels`, so `onRequest` decides it.
  - **`onAccount`**: a pin skips no account. The account Magpie hands the hook names no seat the plugin can read: it is `{ ref, provider, name, kind, model }` (`internal/middleware/account.go`), where `name` is the provider's name, the same for every seat of the provider, and `ref` a hash of the login keyed on the machine Magpie runs on, while the quotas key a seat by its login, `<provider>/<login>` (`internal/provider/quota_last.go`). A guess could skip the seat a pin named, and when every account is skipped Magpie answers 404 rather than trying one anyway (`internal/gateway/gateway.go`). So a seat prefix decides the plugin's choice and refusal (a named seat that cannot run is refused with `pin_unavailable`), but cannot bind which seat of the provider Magpie then uses: with two seats of one provider ready, `claude/work/<model>` may be served on either. `onAccount` still skips an account when every seat of its provider in the quotas is out of dispatch, and by `accountsByWorkKind`.
- **Health**: a model that failed upstream (`status >= 400`, seen by `onResponse`) is out of routing for a cooldown (`UNHEALTHY_COOLDOWN_MS`, 5 minutes), recorded under its resolved entry (a family name under its own name). `unhealthyModels` adds names by hand.

### Candidates from the gateway

Magpie hands a middleware no model list (`ctx` carries the request, not the gateway's catalog), so `candidateModels` is what the plugin rolls among. To make it what your gateway offers, with Magpie's own efforts per model, convert the gateway's `GET /v1/models` with your own gateway key:

```sh
curl -s -H "Authorization: Bearer $MAGPIE_KEY" http://127.0.0.1:<port>/v1/models | node scripts/candidates-from-models.mjs > candidates.json
```

The script makes no request itself; it prints `{ "candidateModels": [...] }`. A model listed with reasoning levels becomes `{ "model": <id>, "efforts": [<levels>] }` (read from `reasoning_levels`, else `supported_reasoning_levels`), so it is routed at exactly those efforts; a model listed with none is written as `{ "model": <id>, "efforts": ["default"] }`, its one configuration (`default` above), never as a bare id. A row the script cannot read (not an object, or no id) and an id listed again are skipped and named on stderr, as is a repeated id whose levels differ from the row kept; stdout is only the JSON. Paste the array into the plugin's options, and rerun it when you add or remove providers or models in Magpie. Names the shipped data has no row for stay out of automatic routing as described above.

A request the plugin routes but cannot serve is refused with HTTP 503 and a code (`agentcompass: ` prefix in the message); the detail goes to the local log:

| Code | When |
|---|---|
| `no_route` | No pin, and no candidate can serve the request (capability, effort, modality, or window quota) |
| `accounts_unavailable` | No pin, and every candidate that passes the non-quota checks fails because its account is unavailable (`plan_inactive`, `auth_failed`, `disabled`, or `usage_failing` past 6 h) |
| `pin_not_in_pool` | The pinned model or bundle is not among the candidates |
| `model_unhealthy` | The pinned model, or the model of the pinned bundle, is marked unhealthy |
| `pin_unavailable` | The pin cannot serve for another reason (effort not offered or disabled, data error, account, a named seat exhausted) |
| `invalid_model_pin` | The pin is malformed (an empty part around a `/` or a `:`, a bare `:high`, an `auto:` id without its account and harness, a blank or a value that is not text); the message says what is wrong with it, quoting the pin as typed |
| `invalid_caller_profile` | The caller's profile does not validate |
| other | `<code>: this request could not be routed`, e.g. `classifier_invalid_output` |

Each pin code's message (`invalid_model_pin` included) says why that pin cannot serve; the message of every other code is `this request could not be routed`.

## Session continuity

Holds run before the classifier, so a request does not move on the words of a harder turn unless the caller's profile says so. `affinityMode` is `cache` (default), `turn`, `session`, `strict` or `off`.

- **`turn`**: the latest message is a tool result (`role: "tool"`, `tool_result`, `function_call_output`) or an injected reminder with no new user text: the session's `<model>:<effort>` is held.
- **`cache`**: while the prompt cache is warm (5 minutes for Anthropic and Gemini, 1 hour for ChatGPT/Codex Responses and DeepSeek) the model is held and the effort does not drop (`keepsEffort`). A short turn (`"继续"`) is a turn like any other: nothing reads its words.
- **`session`** holds across turns for 24 hours even when the cache is cold. **`strict`** does too. Both ignore a compaction; `strict` also ignores outgrowth of capability and of the context window. **`off`** holds nothing.
- **Re-routes** (`why`): `first`, `provider_unhealthy`, `quota_exhausted`, `capability_outgrown` (an image part, or `needs.gui` or a profile's `needs_gui`, on a model that takes no images), `outgrown` (input over 95% of the context window), `worn` (compacted plus live tokens reach 2,000,000), `compacted` (the request's tokens fell by more than half), `cold`, `effort_gone` (the pool no longer offers the held effort and no accepted lower one is left; routing continues with the session's own profile), `user_pin_override`. An expired session is `reasonDetail: "session_expired"`.
- **A pin on a held session**: the hold is kept only when the held route is among the rows the pin names and can run, i.e. it is in the ranking a cold request with the same pins and the session's profile gets; otherwise the request routes as a cold one does, which serves a named row or refuses with the same code. A malformed pin is refused before any hold.
- **Pooled runtimes**: Magpie runs each request on a pooled `moejs` runtime, and only one that served the session has its record. Any other slices the anchor turn out of the resent history (up to 4 turns back) and replays its decision; history has no time, so a replayed state has no age. In `cache` mode it holds only in a tool loop; in `session` and `strict` it holds across turns too. A runtime holding the record expires the session after 24 hours (`reasonDetail: "session_expired"`); one without it cannot know, so it still holds.

## Quotas and accounts

Mode A reads quotas only inline (`quotas`); a file (`quotasPath`, alias `quotaFile`, or a `magpieConfigDir`) is read on Mode B and by `src/hooks.js`. A snapshot maps `<provider>/<account>` to its readings:

```json
{
  "claude/main": {
    "kind": "subscription",
    "plan": "max5",
    "quota": { "windows": [{ "name": "7d", "remaining": 80, "used": 20, "resetHours": 100 }] }
  }
}
```

- **Plan**: a window's capacity comes from the account's `plan`. An account with no reported or unknown `plan` has unknown capacity and is out of automatic routing (`capacity_unknown`) until one is reported. An explicit `capacity_usd` wins. The online `plan` wins over a credential `plan_claim`; a disagreement shows as `plan_conflict`.
- **States** (as in AgentCompass): `ready`, `plan_inactive` (free, expired, cancelled, payment failed), `usage_failing` (an error, no reading, or no fresh reading for over `usage_fresh_hours`, default 2), `auth_failed` (HTTP 401/403 in structured fields), and `disabled`. `plan_inactive`, `auth_failed` and `disabled` are never selected. `usage_failing` warns at once and keeps dispatching until the last good reading is older than `usage_max_age_hours` (default 6), then is excluded; a fresh reading returns it to `ready`. State is read from structured fields, never from message or task text.
- **Account list**: `selectBestRoute`, `hooks` and the decision provider return `accounts` and put each non-ready account's warning in `warnings`; `listQuotaAccounts(quotas)` and `formatQuotaAccountList(rows)` give the list as data or text.
- **An unusable quotas file** (configured but missing, unreadable, not JSON or the wrong shape) adds a `pool/quotas` account (`usage_failing`, reason `quotas_unreadable: missing | unreadable | invalid_json | wrong_schema`), keeps the last good snapshot, logs once per change, and shows in `getQuotasLoadStatus()`. It does not block dispatch by itself. Without a configured file nothing is reported.
- **A seat in a pin**: a quotas key `<provider>/<account>` is a seat; a pin names it by its full id, its seat name or its provider. That decides the plugin's choice and refusal, not the seat Magpie uses ([Pins](#candidates-pins-and-refusals)).
- **Metered accounts** (API keys) are used only as a last resort when no subscription row can serve, unless `meteredOk: true`.
- **Pool seats** (`routings`): `strategies.agentcompass` and `agentcompass-pure` order Magpie's seats (`orderSeatsByQuotaEconomics`): seats under `keepPercent` (90) of use before those at or over it, then resting or exhausted ones, then excluded accounts; among healthy seats, ones still to be probed first, then subscriptions, then the seat furthest behind its recovery line (its capacity would expire at the reset), then pace, use and tokens.

## Options

Set under `plugins.agentcompass`, or with `magpie plugin options <spec> '<json>'`.

| Option | Default | Description |
|---|---|---|
| `candidateModels` | none | Names the middleware may route to (aliases `availableModels`, `allowedModels`, `models`). |
| `defaultModel` | none | The model an unrouted request to a virtual name goes to, and the only candidate when there is no list (alias `fallbackModel`). |
| `routeAllModels` | `false` | Route every request, not only virtual names. |
| `routeModelTriggers` | the four names below | Names that trigger routing when `routeAllModels` is off (alias `triggerModels`). A non-empty list replaces the default `agentcompass`, `agentcompass/auto`, `agentcompass/intent`, `agentcompass/system-one-0.5`; `agentcompass` and `agentcompass/*` always trigger. |
| `injectProtocolEffort` | `true` (in `package.json`) | Write the effort into the protocol's field. |
| `useColonEffort` | `true` | Rewrite `body.model` as `<model>:<effort>` for Magpie's own splitter. |
| `modelMap` / `modelPrefix` | none | Map a name to an upstream name, or prepend a provider prefix. |
| `modelsByProvider` | none | Per-provider candidate lists for `onProvider`. |
| `catalog` | the shipped catalogue | Your own tables: `models`, `aliases`, `policy`, and `providerNames` (`{ "defaults": {}, "rows": {} }`, the shape of AgentCompass's `provider_names`). With your own `models` and no `providerNames`, no provider declaration is read (the shipped table names rows your models need not have). |
| `accountsByWorkKind` | none | Per-`work_kind` allowlist of account `ref`, `name` or `provider`, applied in `onAccount` (Magpie's `name` is the provider's name, its `ref` a per-machine hash of the login). |
| `affinityMode` | `cache` | See [Session continuity](#session-continuity). |
| `quotas` / `quotasPath` | none | An inline snapshot, or a file path (no directory scanning). |
| `userScores` | none | Your own category scores: `{ "schema_version": 4, "scores": { "<model>": { "<target>": level } } }`, target `creativity`, `coding`, `aesthetics`, `tool_operation` or `<category>.<facet>`, level 1 = the panel's weakest, 2 = its median, 3 = its best, above 3 extrapolated (or `{ level, as_of, note }`). An older table is upgraded by AgentCompass's declared steps, never refused: one without `schema_version` is the 0.2.x shape (schema 1: `divergence`, level 3 = the anchor; `divergence` is renamed `creativity`, then the level-3 conversion of `level-3-conversion.json`), schema 2 takes the second step, and schema 3 (0.3.0) the third: a score under a name v0.7.0 resolved through an alias v0.7.1 removed or re-targeted moves to the row v0.7.0 meant (`released-names.js`). A key reads its maker's default first (a score under `deepseek-v4-pro` lands on `deepseek-v4-pro-0813`), then the row, an alias, its last `/` segment; where two keys land on one row, the row's own id wins for it, whatever their order; a key that reads no row of the catalogue in use is kept in the table and ignored. Fills a gap or overrides the maintainers' and measured scores (`local user > maintainer > measured > estimated`). A level sets High on its facet (and the model's one fixed effort); the facet's other efforts follow its own curve moved to that value, else the panel's median step from High, the edge efforts `none`, `minimal` and `ultra` step from their anchors, and the curve is bounded along effort in the facet's direction on every facet, so no curve inverts. |
| `meteredOk` | unset | `true` lets metered accounts compete with subscriptions. |
| `enableDecisionProvider` | `false` | Register the Mode B provider. |
| `decisionProviderDetails` | `false` | Return accounts, quotas, warnings and the profile in `/v1/systemone` answers. |
| `allowExternalScorer`, `scorer` | `false`, none | Allow a classifier call (`{ kind, baseUrl, apiKey, model, timeoutMs }`). On a timeout or an error the request is not routed. |

## Names by install source

Magpie prefixes pool strategies with the package name (without its scope and a `middleware-`, `opencode-` or `tools-` prefix); the virtual request model and the decision model do not depend on the source.

| Install source | Pool strategies (`routings`) | Classifier model (Mode B) |
|---|---|---|
| Market `@magpie-community/gateway-agentcompass` | `gateway-agentcompass/agentcompass`, `gateway-agentcompass/agentcompass-pure` | `agentcompass/agentcompass-systemone` |
| GitHub `github:akiiwa-games/magpie-agentcompass-router` | `agentcompass/agentcompass`, `agentcompass/agentcompass-pure` | `agentcompass/agentcompass-systemone` |
| Local directory | `<dir>/agentcompass`, `<dir>/agentcompass-pure` | `agentcompass/agentcompass-systemone` |

`magpie plugin list` shows the names on your machine.

## Limits inside Magpie

- **Mode A can't ask a classifier** (no `magpie.hooks`, no network in `moejs`) **and can't read a quotas file** (no file system): a `quotasPath` there reports `quotas_unreadable: missing` even when the file exists. Give Mode A `quotas` inline.
- **A client that sends `body.profile` sends it on every request of a session.** Only a runtime that served the session has anything to hold it by: in the sandbox, a tool-loop step sent with no profile mid-session was held on 4 to 10 of 20 requests and got Magpie's 404 on the rest.
- **A request carries this turn's answer, and no earlier one's.** A new turn with a different profile holds on a runtime that served the session and goes where the new profile says on one that did not.
- **A warm session does not ask the classifier about each new turn** (holds run first).
- **Streams are not annotated.** The plugin does not export `onEvent`, so a streamed reply says nothing of not being routed; Magpie's log does.
- **The classifier sees a bounded part of a long turn**: request text is cut to 4,000 characters, head and tail, when extracted (`capTextSlice`), and the `openai_compatible` classifier is sent at most 12,000 of what it is given.
- **The serving provider of a routing group and of an account's maker is not known.** A Magpie routing group is listed as `auto/<model>` or `group/<id>` and its members are not in the listing (`owned_by` names only the first), so a group's name reads the maker's default and its row, never a member's own declaration. AgentCompass reads a Magpie `account:<kind>` with the maker of its account as a second serving provider (`gateway_coverage.row_providers`); the plugin sees the preset id and the account kind (`ctx.provider.account`) but ships no table of makers, so a declaration by the maker of a signed-in account is not read on it. No shipped declaration applies to either today: on the saved Magpie 0.1.4470 catalog the declared names are served by the `deepseek`, `google`, `mistral` and `opencode-zen` presets (the last through `host_providers.magpie`: its `deepseek-v4-flash` is OpenCode's other weights), none by an account or as a group member the data declares otherwise.
- **Not ported** (Magpie only routes): launching workers, harness order and place, and the launch side of fast mode (`wants_fast`).

## Layout and tests

| Path | What it is |
|---|---|
| `src/middleware.js` | Mode A: `onRequest`, `onProvider`, `onAccount`, `onResponse`, and the pool `strategies`. |
| `src/index.js` | The plugin entry, and Mode B: `/v1/systemone`. |
| `src/hooks.js`, `src/scorer-live.js` | The async hook, and the classifier client (LRU cache). |
| `src/continuity.js`, `src/profiler-core.js` | Session holds and replay; request facts and the profile schema. |
| `src/allocator.js` | `rankCandidates` / `selectBestRoute`: AgentCompass's `allocator.plan` on a gateway's inputs. |
| `src/axis-scores.js`, `candidate-eval.js`, `candidate-ranking.js`, `quota-economy.js`, `quota-pools.js`, `task-intake.js`, `fleet.js`, `plans.js`, `user-scores.js` | The engine, each the port of the module of the same name in AgentCompass v0.7.3; `src/released-names.js` is `released_names.py` (the names v0.7.0 resolved through an alias v0.7.1 removed or re-targeted, read by the `userScores` upgrade). |
| `src/quota.js`, `src/quota-loader.js` | Account states, the quotas file, seat ordering. |
| `src/catalog.js`, `src/reference-data.js` | The model table, provider names, routes, scores, plan capacity. Generated from AgentCompass v0.7.3 by the source repository's `catalog:sync`; this package ships the generated files. |
| `scripts/candidates-from-models.mjs` | `candidateModels` from the gateway's `/v1/models` ([candidates from the gateway](#candidates-from-the-gateway)). |

```sh
bun test    # or: npm test
```

The tests run on their own: no AgentCompass checkout and no network. They are the rules (`router`, `routing-contract`, `engine-070`, `engine-071`, `no-hardcode`) and the quota and plan tests (`plan-state`, `plan-align`, `quotas-load`). The comparison with AgentCompass's `allocator.plan` (same winner, effort and score on a grid of profiles and pools), the comparison of the user-score overlay with AgentCompass's, the check of `src/released-names.js` against AgentCompass's `released_names.py`, and the sandbox run against real Magpie builds stay in the source repository, [akiiwa-games/magpie-agentcompass-router](https://github.com/akiiwa-games/magpie-agentcompass-router). The latest record of the sandbox run, [`docs/linux-sandbox-e2e-report-0.1.4026.json`](https://github.com/akiiwa-games/magpie-agentcompass-router/blob/main/docs/linux-sandbox-e2e-report-0.1.4026.json), is of the v0.6.0 engine on Magpie 0.1.4026 and Bun 1.4.4 (scenarios 1–10 and 12–15 passed, scenario 13 with real Codex and Claude sign-ins included); the v0.7.0, v0.7.1, v0.7.2 and v0.7.3 engines have not been run there yet.
