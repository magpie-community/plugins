# Reference

What this plugin does that AgentCompass itself does not: its two modes, its options, the names it registers, its limits inside Magpie and its profile contract. How the engine scores (the four categories, the data gates, the quota economy, the order of rows) is AgentCompass's, written once in [`docs/technical-reference.md`](https://github.com/akiiwa-games/AgentCompass/blob/v0.6.0/docs/technical-reference.md#1-how-scoring--allocation-work) and [`router-internals.md`](https://github.com/akiiwa-games/AgentCompass/blob/v0.6.0/skills/agent-compass/references/router-internals.md) at the tag this plugin is pinned to (v0.6.0; the commit is named in the header of `src/reference-data.js`); this file does not repeat them. Model names are the public catalogue's: [`model-capabilities.md`](https://github.com/akiiwa-games/AgentCompass/blob/v0.6.0/skills/agent-compass/references/model-capabilities.md).

## Contents

[Modes](#modes) · [Task profile](#task-profile) · [Without a profile](#without-a-profile) · [Candidates, pins and refusals](#candidates-pins-and-refusals) · [Session continuity](#session-continuity) · [Quotas and accounts](#quotas-and-accounts) · [Options](#options) · [Names by install source](#names-by-install-source) · [Limits inside Magpie](#limits-inside-magpie) · [Layout and tests](#layout-and-tests)

## Modes

| | Mode A: gateway middleware (default) | Mode B: decision provider (opt-in) |
|---|---|---|
| Declared by | `magpie.middleware` in `package.json` | `enableDecisionProvider: true`; model `agentcompass/agentcompass-systemone`, served at `/v1/systemone` |
| Runs in | Magpie's `moejs`: synchronous, no network, no file system | A Bun process: may call a classifier |
| Asks | Requests to `agentcompass`, `agentcompass/*`, the names in `routeModelTriggers`, or every model with `routeAllModels: true` | A Routing Group whose classifier is the decision model |
| Result | Rewrites `body.model` to `<model>:<effort>` and sets the protocol's effort field (`reasoning_effort`, `reasoning.effort`, `output_config.effort`) | Answers the group's `intent` / `level` / `effort` questions |
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
- The scorer is `scorer.kind` `openai_compatible` (default; `model` defaults to `gemini-3.8-flash-high`) or `jev`; the flat options `scorerType`, `scorerBaseUrl`, `scorerApiKey`, `scorerModel`, `jevBaseUrl`, `jevApiKey` and `scorerTimeoutMs` (clamped to 100..55000 ms) are the same settings. An answer that is not a valid profile is retried once, then the request is not routed (`classifier_invalid_output`); an answer is never repaired.
- Answers are cached by task and structured fields (`useCache: false` turns it off).
- By default an answer holds only the model and effort, or `{ targetModel: null, blocked: true, error, message }`. Any gateway key that may use the decision model can call `/v1/systemone`, so accounts, quotas, the profile and `warnings` stay in the local log unless `decisionProviderDetails: true`. A refusal of a pin is then always `pin_unavailable`, with no name in it.

## Task profile

A profile comes from the classifier or the caller, never from the words of a task: `test/no-hardcode.test.mjs` scans `src/` for it, and routes the same profile across a corpus of trigger words (`test/task_text_corpus.mjs`) to the same answer.

A caller sends it as `body.profile`, `ctx.state.profile` or `ctx.profile` (on `/v1/systemone`: `state.task.profile` or `state.profile`). The middleware removes `body.profile` before the upstream sees it. A valid profile (`test/profile.mjs` builds one):

```json
{
  "work_kind": "general_implementation",
  "reasoning_depth": 2,
  "code_complexity": 2,
  "needs_visual": false,
  "needs_gui": false,
  "local_only": false,
  "wants_fast": false,
  "read_only_review": false,
  "access": "write",
  "interaction_style": "engineering",
  "expected_hours": 0.5,
  "hours_confidence": "medium",
  "urgency": "unknown",
  "multi_task": false,
  "task_count": "1",
  "axis_demand": { "divergence": 0, "coding": 2, "aesthetics": 0, "tool_operation": 0 }
}
```

- `reasoning_depth` is 1..4 and `code_complexity` 0..3 (integers); `needs_visual`, `needs_gui`, `local_only`, `wants_fast`, `read_only_review` and `multi_task` are booleans; `interaction_style` is `engineering`, `exploration`, `text_only` or `advisory`; `axis_demand` is the demand per category, 0..3 each, and is required.
- Optional: `work_kind` (one of `ROUTES` in `src/catalog.js`, 16 routes), `access` (`read-only` or `write`), `expected_hours` (clamped to 0.05..24), `hours_confidence` (`low`, `medium`, `high`), `urgency` (`unknown`, `low`, `normal`, `high`), `reason`.
- `task_count` is `"1"`, `"2"`, `"3"` or `">3"` (a positive integer is bucketed), and `multi_task` must agree with it.
- A read-only review (`read_only_review: true` or `access: "read-only"`) must have `code_complexity` 0.
- An image part in the request is read as structure: it sets `needs_visual` and takes `axis_demand.tool_operation` to 3, whatever the profile says.
- A profile that does not validate counts as none, with the code `invalid_caller_profile`. A profile in the 0.1.x shape (`context_scale`, `hallucination_risk`, `error_cost`, `realtime_loop`, a top-level `divergence`) is refused, not repaired.

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

- **Automatic routing never picks a name that has no scores**: a family or unknown name (`claude-opus-9`) is out of automatic routing with a data-error warning, and is dispatched only when named. `candidate name <name> is not in the catalog: ...` is logged once per runtime and put in `warnings`.
- **Turning off an effort**: add a row with `disabled: true` next to the bare name or `efforts[]` row, e.g. `["gpt-6.1-sol", { "model": "gpt-6.1-sol", "effort": "medium", "disabled": true }]`. No row of that account and model is dispatched at that effort, pinning it is refused (`pin_unavailable`), and a session held on it leaves it. A disabled row with an `account` applies to that account only; a family row is another model, so disabling `claude-opus-5-5` does not touch `claude-opus-9`.
- **Pins**: `constraintModel` / `pinnedModel` (optionally `:effort` or `-effort`), `constraintEffort` / `pinnedEffort`, `constraintBundle` / `pinnedBundle`. A pin that cannot be served is refused with a code; no other model is substituted. A pin on a model with its own entry matches only that model's rows, never a family row. Pin fields are removed from requests the plugin does not route. A `:auto`, `:off` or `:default` on a candidate name does not constrain the effort; on a pin `:default` names a concrete effort that no row offers.
- **Health**: a model that failed upstream (`status >= 400`, seen by `onResponse`) is out of routing for a cooldown (`UNHEALTHY_COOLDOWN_MS`, 5 minutes), recorded under its resolved entry (a family name under its own name). `unhealthyModels` adds names by hand.

A request the plugin routes but cannot serve is refused with HTTP 503 and a code (`agentcompass: ` prefix in the message); the detail goes to the local log:

| Code | When |
|---|---|
| `no_route` | No pin, and no candidate can serve the request (capability, effort, modality, or window quota) |
| `accounts_unavailable` | No pin, and every candidate that passes the non-quota checks fails because its account is unavailable (`plan_inactive`, `auth_failed`, `disabled`, or `usage_failing` past 6 h) |
| `pin_not_in_pool` | The pinned model or bundle is not among the candidates |
| `model_unhealthy` | The pinned model, or the model of the pinned bundle, is marked unhealthy |
| `pin_unavailable` | The pin cannot serve for another reason (effort not offered or disabled, data error, account) |
| `invalid_caller_profile` | The caller's profile does not validate |
| other | `<code>: this request could not be routed`, e.g. `classifier_invalid_output` |

## Session continuity

Holds run before the classifier, so a request does not move on the words of a harder turn unless the caller's profile says so. `affinityMode` is `cache` (default), `turn`, `session`, `strict` or `off`.

- **`turn`**: the latest message is a tool result (`role: "tool"`, `tool_result`, `function_call_output`) or an injected reminder with no new user text: the session's `<model>:<effort>` is held.
- **`cache`**: while the prompt cache is warm (5 minutes for Anthropic and Gemini, 1 hour for ChatGPT/Codex Responses and DeepSeek) the model is held and the effort does not drop (`keepsEffort`). A short turn (`"继续"`) is a turn like any other: nothing reads its words.
- **`session`** holds across turns for 24 hours even when the cache is cold. **`strict`** does too. Both ignore a compaction; `strict` also ignores outgrowth of capability and of the context window. **`off`** holds nothing.
- **Re-routes** (`why`): `first`, `provider_unhealthy`, `quota_exhausted`, `capability_outgrown` (an image part, or `needs.gui` or a profile's `needs_gui`, on a model that takes no images), `outgrown` (input over 95% of the context window), `worn` (compacted plus live tokens reach 2,000,000), `compacted` (the request's tokens fell by more than half), `cold`, `effort_gone` (the pool no longer offers the held effort and no accepted lower one is left; routing continues with the session's own profile), `user_pin_override`. An expired session is `reasonDetail: "session_expired"`.
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
| `accountsByWorkKind` | none | Per-`work_kind` allowlist of account `ref`, `name` or `provider`, applied in `onAccount`. |
| `affinityMode` | `cache` | See [Session continuity](#session-continuity). |
| `quotas` / `quotasPath` | none | An inline snapshot, or a file path (no directory scanning). |
| `userScores` | none | Your own category scores: `{ "<model>": { "<target>": level } }`, target `divergence`, `coding`, `aesthetics`, `tool_operation` or `<category>.<facet>`, level 1..3 (or `{ level, as_of, note }`). Fills a gap or overrides the maintainers' and measured scores (`local user > maintainer > measured > estimated`). |
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
- **Not ported** (Magpie only routes): launching workers, harness order and place, and the launch side of fast mode (`wants_fast`).

## Layout and tests

| Path | What it is |
|---|---|
| `src/middleware.js` | Mode A: `onRequest`, `onProvider`, `onAccount`, `onResponse`, and the pool `strategies`. |
| `src/index.js` | The plugin entry, and Mode B: `/v1/systemone`. |
| `src/hooks.js`, `src/scorer-live.js` | The async hook, and the classifier client (LRU cache). |
| `src/continuity.js`, `src/profiler-core.js` | Session holds and replay; request facts and the profile schema. |
| `src/allocator.js` | `rankCandidates` / `selectBestRoute`: AgentCompass's `allocator.plan` on a gateway's inputs. |
| `src/axis-scores.js`, `candidate-eval.js`, `candidate-ranking.js`, `quota-economy.js`, `quota-pools.js`, `task-intake.js`, `fleet.js`, `plans.js`, `user-scores.js` | The engine, each the port of the module of the same name in AgentCompass v0.6.0. |
| `src/quota.js`, `src/quota-loader.js` | Account states, the quotas file, seat ordering. |
| `src/catalog.js`, `src/reference-data.js` | The model table, routes, scores, plan capacity. Generated from AgentCompass v0.6.0 by the source repository's `catalog:sync`; this package ships the generated files. |

```sh
bun test    # or: npm test
```

The tests run on their own: no AgentCompass checkout and no network. They are the rules (`router`, `routing-contract`, `no-hardcode`) and the quota and plan tests (`plan-state`, `plan-align`, `quotas-load`). The comparison with AgentCompass's `allocator.plan` (same winner, effort and score on a grid of profiles and pools) and the sandbox run against real Magpie builds stay in the source repository, [akiiwa-games/magpie-agentcompass-router](https://github.com/akiiwa-games/magpie-agentcompass-router). The record of the sandbox run for the v0.6.0 engine, on Magpie 0.1.4026 and Bun 1.4.4, is [`docs/linux-sandbox-e2e-report-0.1.4026.json`](https://github.com/akiiwa-games/magpie-agentcompass-router/blob/main/docs/linux-sandbox-e2e-report-0.1.4026.json): scenarios 1–10 and 12–15 passed, scenario 13 with real Codex and Claude sign-ins included.
