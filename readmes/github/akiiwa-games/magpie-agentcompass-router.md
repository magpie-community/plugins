# magpie-agentcompass-router

A [Magpie](https://github.com/yetone/magpie) gateway plugin powered by [AgentCompass](https://github.com/akiiwa-games/AgentCompass). It routes requests and orders account-pool seats by task intent, 7D capability vectors, 3D Model DNA (`divergence`, `global_rigor`, `module_precision`), session continuity, and 5h/7d subscription quota economics.

By default it runs synchronously inside Magpie's `moejs` gateway middleware (`magpie.middleware`) in under 1 ms with zero network calls, and optionally registers an on-demand Magpie Decision Provider (`agentcompass/agentcompass-systemone`, `/v1/systemone`) for Routing Groups.

**It routes on a classifier's structured answer, never on the words of a task.** Without a task profile a request is not routed: see [Without a classifier](#without-a-classifier).

## Quickstart

### 1. Install

```sh
magpie plugin add @magpie-community/gateway-agentcompass          # plugin market
# or: magpie plugin add github:akiiwa-games/magpie-agentcompass-router
# or: magpie plugin add /path/to/magpie-agentcompass-router
magpie plugin list
```

### 2. Gateway middleware (Mode A, default)

Configure `candidateModels` (or `availableModels` / `allowedModels`) in the plugin options, then send requests to `model: "agentcompass"` (or `"agentcompass/auto"`, or set `"routeAllModels": true`):

```json
{
  "plugins": {
    "agentcompass": {
      "routeAllModels": false,
      "candidateModels": [
        "claude-opus-5-5",
        "claude-sonnet-5-5",
        "claude-haiku-5-5",
        "gpt-6.1-sol",
        "gpt-6-astra",
        "gemini-4-argon-high",
        "gemini-3.8-flash-high"
      ]
    }
  }
}
```

Or from the CLI:

```sh
magpie plugin options <plugin-spec> '{"candidateModels":["claude-opus-5-5","claude-sonnet-5-5","gpt-6.1-sol","gemini-4-argon-high","gemini-3.8-flash-high"]}'
```

- Requests to `agentcompass` or `agentcompass/*` rewrite `body.model` to `<targetModel>:<targetEffort>` (which Magpie's gateway splits natively) and set protocol-specific effort fields (`reasoning_effort`, `reasoning.effort`, `output_config.effort`).
- If a virtual model (`agentcompass` / `agentcompass/*`) is requested without `candidateModels` or `defaultModel`, the middleware rejects the call with HTTP 400 (`agentcompass: set candidateModels in the plugin's options`) rather than guessing models.
- If `routeAllModels: true` is set without `candidateModels`, concrete model names are kept as-is and only the reasoning effort is injected.
- `moejs` has no network, so **the middleware cannot call a classifier**: it routes only a request that brings its profile (`body.profile`, see below). Every other request is forwarded unrouted. To have requests classified, use Mode B with a scorer.
- To turn off one effort of a model, add a row for it with `disabled: true` next to the bare name or `efforts[]` row: `["gpt-6.1-sol", { "model": "gpt-6.1-sol", "effort": "medium", "disabled": true }]`. No row of that account and model is dispatched at that effort, and pinning it returns 503. A disabled row with an `account` applies to that account only.

### 3. Account-pool seat strategy (`routings`)

To order accounts inside a Magpie pool by quota headroom, pre-reset surplus sprint, and subscription vs. metered API key priority, select the plugin's routing strategy on your pool (see table below for exact name by install source).

### 4. Routing Group Classifier (Mode B, opt-in)

To use AgentCompass as a Classifier in Magpie's **Routing Groups** UI (`/v1/systemone`, using Magpie's `ClassifyTimeout` of 8–60s):

```sh
magpie plugin options <plugin-spec> '{"enableDecisionProvider": true}'
# restart Magpie (or magpie web), then sign in (keyless):
magpie plugin login agentcompass
magpie plugin list   # shows: agentcompass (AgentCompass, 1 models)  signed in
magpie group set <group> effort=auto classifier=agentcompass/agentcompass-systemone
```

Give it a classifier model, or it answers `none of these` on every turn:

```sh
magpie plugin options <plugin-spec> '{"enableDecisionProvider": true, "allowExternalScorer": true, "scorer": {"kind": "openai_compatible", "baseUrl": "http://127.0.0.1:4096/v1", "apiKey": "<key>", "model": "gemini-3.8-flash-high"}}'
```

A group's intent or level is answered directly when its label is exactly the route's `work_kind`, `difficulty` or model. Any other label is the operator's own words, and the classifier is asked which one fits (one more call on that turn).

*(Requires plugin `0.1.1+`; `0.1.0` did not register the `auth` hook required by Magpie's provider list — see [issue #1](https://github.com/akiiwa-games/magpie-agentcompass-router/issues/1)).*

### Without a classifier

Where a request gets its task profile, in order:

1. The caller: `ctx.state.profile`, `ctx.profile` or `body.profile` (`state.task.profile` / `state.profile` on `/v1/systemone`), with the schema's integer fields present (`divergence` may be left out). The middleware removes `body.profile` before the upstream sees it. A profile that does not validate counts as none (`invalid_caller_profile`).
2. The classifier (`allowExternalScorer: true` and a `scorer`), from `src/hooks.js` and `/v1/systemone`. The middleware can't reach one.

With neither, or when the classifier fails or times out, **there is no routing decision and no guess**, and the plugin raises no error of its own:

| Entry | What the request does | Where it says so |
|---|---|---|
| Middleware (Mode A) | Goes on with `body.model` as the client sent it, with no effort added. A virtual name (`agentcompass/auto`) is only the router's, so it becomes `defaultModel`, the model you named for this, with no effort added. With no `defaultModel` it stays, Magpie serves no model of that name, and the client gets Magpie's error (HTTP 404 in the sandbox), with nothing sent upstream | `ctx.state.agentcompass`, Magpie's log (`agentcompass: 未路由：分类不可用 (<reason>)`), and `agentcompass: { routed: false, notice, reason }` on a JSON reply, an error's included (chat, responses and messages; a stream says it only in the log) |
| Hooks | No `ctx.state.route`, so the middleware above decides | `ctx.state.agentcompass`, the log |
| `/v1/systemone` (Mode B) | `intent` / `level` answer `none of these`, so the group's fallback rule applies; no `effort`. The levels probe answers "not a scale" | `agentcompass: { routed: false, notice, reason }` in the response, the log |

An unrouted request records nothing in the session store, so it starts no session that later turns would hold. A virtual model with neither `candidateModels` nor `defaultModel` is refused with HTTP 400 and a message naming both: that is a configuration error, not a classification one.

**What this changes if you upgrade with no classifier configured:** requests to `agentcompass` / `agentcompass/*` are no longer sent to a model picked from `candidateModels`. Set `defaultModel` so that they still reach a model of your choice, or configure Mode B with a scorer, or have your client send `body.profile`. `scorerType: "heuristic"` and `prefer_local_heuristic` no longer exist and count as no classifier.

### Known limitations

- **Mode A can't ask a classifier.** The package ships no `magpie.hooks` and `moejs` has no network, so on Mode A a profile comes with the request or not at all.
- **Mode A can't read a quotas file.** `moejs` has no file system, so a `quotasPath` there always reports `quotas_unreadable: missing`, even when the file exists. Give Mode A its readings inline with `quotas`, or use the file from `/v1/systemone`.
- **A client that sends `body.profile` sends it on every request of a session.** Magpie hands each request a pooled runtime, and only a runtime that served the session has anything to hold it by. In the sandbox a tool-loop step sent with no profile mid-session was held on 4 to 10 of 20 requests and got Magpie's 404 on the rest.
- **A request carries this turn's answer, and no earlier one's.** A new turn with a different profile holds on a runtime that served the session and goes where the new profile says on one that didn't (3 to 5 of 20 in the sandbox for a realtime session). With the same profile on every turn nothing moves.
- **A warm session doesn't ask the classifier about each new turn.** Holds run first, so a harder task in a warm session on a light model moves only if the caller's profile says so.
- **Streams aren't annotated.** A stream goes through `onEvent`, which the plugin doesn't export, so a streamed reply says nothing of not being routed; Magpie's log does.
- **The classifier sees a bounded part of a long turn**, to bound the work: a request's text is cut to 4,000 characters, head and tail, when it is extracted (`capTextSlice`), and the `openai_compatible` classifier is sent at most 12,000 of what it is given.

### Names by install source

Magpie prefixes pool strategies with the package name (stripped of scope and `middleware-` / `opencode-` / `tools-`), whereas the virtual request model (`agentcompass` / `agentcompass/auto`) and the decision provider (`agentcompass/agentcompass-systemone`) are independent of install source:

| Install source | Pool strategies (`routings`) | Classifier model (Mode B) |
|---|---|---|
| Market `@magpie-community/gateway-agentcompass` | `gateway-agentcompass/agentcompass`, `gateway-agentcompass/agentcompass-pure` | `agentcompass/agentcompass-systemone` |
| GitHub `github:akiiwa-games/magpie-agentcompass-router` | `agentcompass/agentcompass`, `agentcompass/agentcompass-pure` | `agentcompass/agentcompass-systemone` |
| Local directory | `<dir>/agentcompass`, `<dir>/agentcompass-pure` | `agentcompass/agentcompass-systemone` |

Run `magpie plugin list` to inspect the exact names on your machine.

---

## How it decides

```text
Request ──▶ Session continuity check (src/continuity.js)
             ├─ hold current <model>:<effort> on tool loops or warm KV cache
             └─ otherwise:
                  task profile from the caller or the classifier (src/scorer-live.js)
                    ├─ none: not routed, the client's model goes on as it asked
                    └─ 7D capability + 3D Model DNA + quota allocator (src/allocator.js, src/quota.js)
                         ──▶ <targetModel>:<targetEffort>
```

### 1. Session continuity (`src/continuity.js`)

The router avoids re-classifying every HTTP request and preserves prompt caches and reasoning signatures:

- **In-turn tool loops (`within: true` → `why: "turn"`)**: When the latest message is a tool result (`role: "tool"`, `tool_result`, `function_call_output`) or an injected system reminder with no new user text, the session's `<model>:<effort>` is held unconditionally.
- **Warm KV cache (`why: "cache"`)**: While a session's prefix cache is warm (`5m` for Anthropic/Gemini, `1h` for ChatGPT/Codex Responses and DeepSeek), the current model is kept and `keepsEffort` prevents effort from dropping mid-session. A short turn (`"继续"`) is a turn like any other: nothing reads its words, and if the cache is cold it is classified with the previous turn beside it.
- **History replay across pooled VMs (`replayedState`)**: Magpie runs each request on a pooled `moejs` runtime (`sync.Pool`). When a later turn or tool loop lands on a runtime that did not serve the earlier turn, the middleware slices the anchor turn out of the resent conversation history and replays its decision (up to 4 turns back). The history carries no time, so a replayed state has no age: in `cache` mode it holds only in the tool loop, and a TTL-gated hold (`cache`, `realtime_loop`) counts as cold. Every runtime therefore produces the same route in the tool loop and once the cache TTL has passed; inside the TTL only the runtime holding the session's record keeps a follow-up turn on the held route. In `session` and `strict` modes a replayed state holds across turns as well, and when the runtime holding the record sees the 24-hour retention expire, it expires the session directly (`reasonDetail: "session_expired"`, `replayed: false`) without falling back to `replayedState`. A request with no profile has nothing to replay.
- **Re-route triggers**: Re-evaluates only on `first` (new session), `provider_unhealthy` (upstream `status >= 400` recorded by `onResponse`), `quota_exhausted`, `capability_outgrown` (an image part; `needs.gui: true` or a profile with `needs_gui` on a model without GUI; a profile with `reasoning_depth >= 3` on a light model), `outgrown` (input exceeds 95% of `context_window`), `worn` (`compacted + live >= 2M` tokens), `compacted` (the request's tokens dropped by more than half), or `cold`. Holds run before the classifier, so a warm session on a light model does not move on the words of a harder turn unless the caller's profile says so.

### 2. Task profiling & Model DNA allocation (`src/profiler-core.js`, `src/scorer-live.js`, `src/allocator.js`)

Single-pass bounded extraction over Anthropic `/v1/messages`, OpenAI `/v1/responses`, `/v1/chat/completions`, and Gemini payloads gives the structured facts of a request: turns, tool loops, image and video content parts (never words like "screenshot"), and token estimates. The task profile comes from the classifier or the caller (`work_kind` across 16 canonical routes, `difficulty`, `reasoning_depth`, `code_complexity`, `context_scale`, `divergence`, `hallucination_risk`, `error_cost`, `needs_visual`, `needs_gui`, `realtime_loop`). `test/no-hardcode.test.mjs` holds this to it: a static scan of `src/`, and the same answer routed across a corpus of trigger words.

Each `<model, effort>` pair in `candidateModels` is scored on:

```text
pure_intent_score(m, e) = fit_score(m, e) - overqual_penalty(m, e) - effort_selectivity_penalty(m, e)
```

- **7D convergent fit**: Weighted match over `reasoning`, `code`, `context`, `tool_use`, `rigor`, `speed`, and `autonomy`, scaled by per-model `EFFORT_CURVES` (`minimal` / `low` / `medium` / `high` / `xhigh` / `max`), with a steep deficit penalty below the task's ability floor.
- **3D Model DNA**: Matches `divergence` (creative/architectural exploration), `global_rigor` (cross-module invariants and deep debugging), and `module_precision` (self-contained code and schema accuracy).
- **Over-qualification & effort selectivity**: Penalizes frontier models and `xhigh` / `max` effort on routine tasks unless unlocked by high demand or pre-reset quota sprint.
- **Live observe-act responsiveness (`realtime_loop`)**: When the classifier (`src/scorer-live.js`) or explicit caller input marks `realtime_loop: true` (the worker itself acts inside a live observe → decide → act loop against a changing external system):
  - **Responsiveness floor (`0.50`) & effort step-down (`resolveRealtimeEffort`)**: Candidates below the per-turn responsiveness floor step down to the highest provider-dispatchable effort (`DISPATCH_EFFORTS`) that clears both the task's ability gate and the responsiveness floor (skipping models whose effort is baked into the model ID, or deferring when a healthy, applicable sibling candidate already covers that lower effort). Quota burn and cost are computed at the stepped-down effort.
  - **Exclusion & conservative default**: Candidates that still fall below `0.50` after step-down are excluded with `"responsiveness X.XX below realtime_loop floor 0.50 (too slow per turn for a live loop)"`. Names AgentCompass has no calibrated row for default to `0.52` (`responsiveness_source: "default"`). A name resolves to its speed data as AgentCompass's `resolve_canonical_model` does (`resolveResponsivenessModelKey`), which is a separate mapping from the one routing uses: `claude-opus-4-6` routes as `claude-opus-5-5` but has its own responsiveness, its own pin identity, and no `none` step-down.
  - **Responsiveness blend & user pins**: Eligible candidates blend `0.35 * responsiveness` into `fit_score`. Explicitly pinned models/efforts are never stepped down or excluded for responsiveness, emitting a warning instead. On Magpie a pin is the plugin options `pinnedModel` / `pinnedEffort` / `pinnedBundle`, and the warning goes to Magpie's log. Non-`realtime_loop` routing is completely unchanged.
  - **The flag on Magpie**: `realtime_loop` stops at the gateway: the middleware removes it from the body before the upstream sees it. Magpie's pooled runtimes share nothing between requests, so send it on every turn or set the plugin option `realtime_loop: true`; a turn sent without it routes as non-realtime on a runtime that has not seen the session.
  - **Warm-session hold boundary (by design)**: Continuation holds (`why: "cache" | "turn" | "realtime_loop"`) are evaluated before calling the external scorer (`scoreTaskLive`), so an already-running warm session does not invoke the classifier mid-hold. `realtime_loop` is decided by the classifier on the session's first turn (or when a hold expires/reroutes) and persisted in session state, or can be passed explicitly (`realtime_loop: true` in the request payload or plugin options) on any turn to break a non-realtime hold (`capability_outgrown: realtime_loop_required`) without relying on any text heuristics.

### 3. Quota economics & seat ordering (`src/quota.js`, `src/quota-loader.js`)

- **Hard reserve gates**: Excludes rate-limited windows or windows below safety reserves (`safety_margin_pct = 5%`, `short_window_floor_pct = 10%`).
- **Opportunity cost & pre-reset sprint**: Prices expected shortage against forecast demand before reset (`demandForecast`, `computeWindowCost`). Within 36 hours of a window reset, surplus quota above forecast demand earns a `reset_bonus` and discounts over-qualification and effort penalties (`sprint_sunk`).
- **Plan-sized capacity** (values from AgentCompass `references/plan-templates.json`, the authority): a window's USD capacity comes from the account's `plan`. Codex weekly `plus` 67 (5h 10; `team` = plus) / `pro100` 175 (alias `prolite`) / `pro` 325, with no 5h window for pro100 and pro. Claude weekly `pro` 156 (5h 18) / `max5` 1400 (5h 94, weekly_fable 700; bare `max` = max5) / `max20` 2380 (5h 376, weekly_fable 1190). Antigravity `pro` / `ultra5` / `ultra20` (`ultra` = ultra20) with the template's gemini-5h, gemini-weekly, 3p-5h and 3p-weekly sizes. Plans match exactly, never by substring. An unknown or unreported plan is sized as the smallest known plan of that provider and warns. An explicit `capacity_usd` still wins. Rates tagged with a different `rate_plan` are dropped. The online `plan` wins over a credential `plan_claim` (which is only a fallback); a disagreement is exposed as `plan_conflict {online, credential}` and warns.
- **Account state (same names as AgentCompass)**: `ready`, `plan_inactive` (free, expired, cancelled, payment failed), `usage_failing` (any error, no reading, or no fresh reading for over 2 h, `usage_fresh_hours`), `auth_failed` (HTTP 401/403 in structured fields), plus `disabled` for an operator switch. `plan_inactive`, `auth_failed` and `disabled` are never selected. `usage_failing` warns at once and keeps dispatching until the last successful reading is older than **6 h** (`usage_max_age_hours` in `quotas.json`, `catalog.policy`, or `normalizeQuotaSnapshot(..., { usageMaxAgeHours })`), then is excluded. A fresh reading returns the account to `ready` by itself. State is read from structured fields only, never from message or task text.
- **Account list**: `selectBestRoute` / `hooks` / the decision provider return `accounts` (`status` (= `state`), `reason`, plan, `last_success_at`, `dispatchable`, and for `usage_failing` also `failing_since`, `exclude_after_hours`, `usage_excluded`; `plan_conflict` when plan sources disagree) and put each non-ready account's warning in `warnings` (middleware logs them); `listQuotaAccounts(quotas)` and `formatQuotaAccountList(rows)` give the same list as data or text. The "nothing was eligible" fallback ignores exhausted windows but keeps excluding expired, failing, signed-out and disabled accounts (`healthOnlyQuotas`). When no model is pinned and among candidates not excluded by non-quota reasons there is at least one and all of them fail because their accounts are unavailable, the 503 refusal is `accounts_unavailable: every candidate account is unavailable` (without exposing account names, candidate pool, or quotas; details stay in the local log); if all candidates were excluded by non-quota reasons (such as capability or effort) or a capable candidate was excluded due to window quota, the refusal remains `no_route: no candidate can serve this request`.
- **Unreadable quotas file**: no configured file stays silent-by-design (`null`). A configured `quotasPath` / `magpieConfigDir` file that is missing, unreadable, not JSON or the wrong shape adds a pool-level `pool/quotas` account (`usage_failing`, reason `quotas_unreadable: missing | unreadable | invalid_json | wrong_schema`) to `accounts` and `warnings`, keeps the last good snapshot (its readings age out through the 6 h rule), logs once per change, and is exposed as `getQuotasLoadStatus()`. It does not block dispatch by itself.
- **Pool seat ordering (`strategies.agentcompass`)**: Orders Magpie `Seat` entries (`{ account, known, learns, used, soon, pace, resting }`) as:
  `unprobed (learns) → pre-reset sprint → healthy subscriptions → metered API keys → high-usage reserve (≥90%) → resting/exhausted`.

---

## Plugin options

Set under `plugins.agentcompass` (or via `magpie plugin options`):

| Option | Default | Description |
|---|---|---|
| `candidateModels` | — | Candidate model IDs the middleware may route to (aliases: `availableModels`, `allowedModels`, `models`). |
| `defaultModel` | — | Fallback model when no `candidateModels` list is set, and the model an unrouted request to a virtual name goes to (alias: `fallbackModel`). |
| `routeAllModels` | `false` | Route every incoming model request, not only `agentcompass` virtual models. |
| `routeModelTriggers` | `["agentcompass", "agentcompass/auto", "agentcompass/intent", "agentcompass/system-one-0.5"]` | Virtual model names that trigger routing when `routeAllModels` is `false` (alias: `triggerModels`). |
| `injectProtocolEffort` | `true` | Write the selected effort into protocol fields (`reasoning_effort`, `reasoning.effort`, `output_config.effort`). |
| `useColonEffort` | `true` | Rewrite `body.model` as `<model>:<effort>` for Magpie's native effort splitter. |
| `modelMap` / `modelPrefix` | — | Map canonical model IDs to custom upstream names or prepend a provider prefix. |
| `modelsByProvider` | — | Per-provider candidate model lists used by `onProvider(body, ctx)`. |
| `accountsByWorkKind` | — | Per-`work_kind` allowlist of account `ref` / `name` / `provider` filtered in `onAccount(account, ctx)`. |
| `affinityMode` | `"cache"` | Session continuity mode (`"cache"`, `"turn"`, `"session"`, `"strict"`, or `"off"`): `"cache"` holds in tool loops and while the KV cache is warm; `"turn"` holds only inside an in-turn tool loop (`within: true`); `"session"` holds across turns for 24h even after cache expiry, breaking on capability/window outgrowth, health, quota, or 2M wear; `"strict"` holds across turns for 24h and ignores capability/window outgrowth and compaction, breaking only on health, quota, pin override, or 2M wear; `"off"` disables all continuity holds. |
| `quotas` / `quotasPath` | — | Inline quota snapshot object or explicit path to a quota JSON file (`quotaFile`). No implicit directory scanning. |
| `meteredOk` | `true` | Allow metered API keys when scoring candidates. |
| `enableDecisionProvider` | `false` | Register the `agentcompass/agentcompass-systemone` Decision Provider (`/v1/systemone`) for Routing Groups. |
| `decisionProviderDetails` | `false` | Return accounts, quotas, warnings and the task profile in `/v1/systemone` answers. Any gateway key that may use the decision model can read them. Off, an answer holds only the model and effort, or a reason code and a sentence; warnings go to the local log. |
| `allowExternalScorer` | `false` | Allow Mode B (`src/index.js`) or `src/hooks.js` to call an external `scorer` (`{ kind, baseUrl, apiKey, model, timeoutMs }`). On timeout or error the request is not routed. |

## Repository layout

| Path | Description |
|---|---|
| `src/middleware.js` | Synchronous `moejs` gateway middleware (`onRequest`, `onProvider`, `onAccount`, `onResponse`) and pool `strategies`. |
| `src/index.js` | Mode B Decision Provider (`agentcompass/agentcompass-systemone`, `/v1/systemone`, `jevLevelled` and `jevBody`). |
| `src/continuity.js` | Session key fingerprinting, tool-loop lock, KV cache TTLs, monotonic effort ratchet, and stateless history replay. |
| `src/profiler-core.js` | Single-pass multi-protocol request fact extractor, the task profile schema and its validation. |
| `src/allocator.js` | 7D capability + 3D Model DNA + effort-curve candidate ranker. |
| `src/quota.js`, `src/quota-loader.js` | 5h/7d window opportunity-cost model, pre-reset surplus sprint, and Magpie pool seat ordering. |
| `src/catalog.js` | 16 `work_kind` routes, model capability/DNA catalog, aliases, and `EFFORT_CURVES`. Generated from AgentCompass's `accounts.json` at the commit in `test/fixtures/agentcompass-pin.json` (`npm run catalog:sync`, `npm run catalog:check`). |
| `src/scorer-live.js`, `src/hooks.js` | External System-One classifier client (LRU cache) and programmatic Bun hook helper. |
| `test/router.test.mjs` | Unit test suite (`npm test` / `bun test`). |
| `test/no-hardcode.test.mjs` | The rule against classifying by text: static scan of `src/` with its written exceptions, and same-answer-any-wording routing over `test/task_text_corpus.mjs`. |
| `test/realtime-parity.test.mjs`, `test/routing-parity.test.mjs` | The port against AgentCompass's `allocator.py` at the pinned commit; regenerate with `test/fixtures/gen_realtime_parity.py` and `gen_routing_parity.py`. |
| `test/routing-contract.test.mjs` | One regression test per finding of the routing review. |

## Tests

```sh
npm test                       # or: bun test
```

Against real Magpie builds, with fake credentials and a local mock upstream and classifier (`docs/RESEARCH_AND_SCHEME.md` §4.6):

```sh
BASELINE_SRC=<export of the commit to compare with> MAGPIE_LINUX_BIN=<magpie-cli-linux-amd64> sh test/run-linux-sandbox.sh
```

---

## 中文说明

基于 [AgentCompass](https://github.com/akiiwa-games/AgentCompass) 的 [Magpie](https://github.com/yetone/magpie) 网关路由插件：按任务意图、7 维客观能力、3 维模型禀赋（`divergence` 发散创意、`global_rigor` 全局严密、`module_precision` 单模块精准）、会话连续性与 5h/7d 订阅配额经济学选出 `<model>:<effort>` 并对号池席位排序。默认在 `moejs` 网关中间件内同步运行（`< 1 ms`，零网络请求），并可按需开启 `/v1/systemone` 决策 Provider 供路由组（Routing Groups）使用。

**路由只依据分类模型或调用方给出的结构化画像，绝不根据任务文本判断。** 拿不到画像时不做路由，见下面的"没有分类模型时"。

### 快速上手

#### 1. 安装

```sh
magpie plugin add @magpie-community/gateway-agentcompass          # 插件市场
# 或：magpie plugin add github:akiiwa-games/magpie-agentcompass-router
# 或：magpie plugin add /path/to/magpie-agentcompass-router
magpie plugin list
```

#### 2. 网关中间件（模式 A，默认）

在插件选项中配置 `candidateModels`（或 `availableModels` / `allowedModels`），客户端请求 `model: "agentcompass"`（或 `"agentcompass/auto"`，或设 `"routeAllModels": true`）：

```sh
magpie plugin options <plugin-spec> '{"candidateModels":["claude-opus-5-5","claude-sonnet-5-5","gpt-6.1-sol","gemini-4-argon-high","gemini-3.8-flash-high"]}'
```

- 请求虚拟模型 `agentcompass` / `agentcompass/*` 时，中间件将 `body.model` 改写为 `<targetModel>:<targetEffort>`，并按协议注入思考档位字段（`reasoning_effort`、`reasoning.effort`、`output_config.effort`）。
- 未配置 `candidateModels` 或 `defaultModel` 时请求虚拟模型会返回 HTTP 400（`agentcompass: set candidateModels in the plugin's options`），不猜测模型列表。
- 要禁用模型的某个档位，在裸名或 `efforts[]` 行旁边加一行 `disabled: true`：`["gpt-6.1-sol", { "model": "gpt-6.1-sol", "effort": "medium", "disabled": true }]`。同账户、同模型的行都不会再派发这一档，点名这一档返回 503。禁用行带 `account` 时只对该账户生效。
- `/v1/systemone` 默认只回答模型和档位，或原因码和一句说明，账号、配额和 `warnings` 不返回。未点名且未被非配额原因排除的候选（至少有一个）全部因账户不可用落选时，503 拒绝原因为 `accounts_unavailable: every candidate account is unavailable`（若所有候选均因能力/档位等非配额原因被排除，或因窗口余额被排除，则仍为 `no_route: no candidate can serve this request`），明细只写本地日志。需要明细时设置 `decisionProviderDetails: true`，能用这个分类器模型的网关 key 都能读到。
- 开启 `routeAllModels: true` 且未配置候选列表时，具体模型名保持不变，仅自动注入思考档位。
- `moejs` 没有网络，**中间件调用不了分类模型**：只有带了画像（`body.profile`）的请求才会被路由，其余请求一律不路由、直接转发。要让请求被分类，请用配了分类模型的模式 B。

#### 3. 账号池席位排序（`routings`）

在多账号池上选择本插件的路由策略（名称见下表），按「待探测新号 (`learns`) → 临期富余冲刺 (`36h` 内重置) → 低机会成本订阅 → 按量 API Key → 高占用储备 (`≥90%`) → 冷却/耗尽」排序。

#### 4. 路由组分类器（模式 B，按需开启）

在 Magpie 的 **Routing Groups** 中把本插件用作分类器（`/v1/systemone`，需 `0.1.1+`）：

```sh
magpie plugin options <plugin-spec> '{"enableDecisionProvider": true}'
# 重启 Magpie（或 magpie web），然后免 Key 登录：
magpie plugin login agentcompass
magpie group set <group> effort=auto classifier=agentcompass/agentcompass-systemone
```

需要同时配置分类模型（`allowExternalScorer: true` + `scorer`，写法见英文部分），否则每一轮都回答 `none of these`。路由组的 intent/level 标签恰好等于路由的 `work_kind`、`difficulty` 或模型名时直接回答；其他标签是操作者自己的措辞，交给分类模型判断（这一轮多调用一次）。

#### 没有分类模型时

画像的来源依次是：调用方显式传入（`ctx.state.profile`、`ctx.profile`、`body.profile`，`/v1/systemone` 上是 `state.task.profile` / `state.profile`；中间件转发前会移除 `body.profile`；校验不过视为没有，原因 `invalid_caller_profile`），然后是分类模型（`src/hooks.js` 与 `/v1/systemone` 可调用，中间件不能）。

都拿不到，或分类模型失败、超时时，**不做路由决策、不猜测，插件自己也不报错**：

- 中间件：`body.model` 原样转发，不附加档位。虚拟模型名（`agentcompass/auto`）只属于路由器，配置了 `defaultModel` 时改用你指定的这个模型，不附加档位；没有配置则保持原样，Magpie 没有这个名字的模型，客户端收到 Magpie 的错误（沙盒里是 HTTP 404），不会发往上游。写明在 `ctx.state.agentcompass`、Magpie 日志（`agentcompass: 未路由：分类不可用 (<原因>)`）和 JSON 响应（含错误响应）的 `agentcompass: { routed: false, notice, reason }` 字段里（chat、responses、messages；流式只有日志）。
- Hooks：不写 `ctx.state.route`，交给上面的中间件；写明在 `ctx.state.agentcompass` 和日志里。
- `/v1/systemone`：`intent` / `level` 回答 `none of these`，由路由组的兜底规则处理，不回答 `effort`；量表探测回答"不是量表"。响应里带 `agentcompass: { routed: false, notice, reason }`，并写日志。

未路由的请求不写入会话状态，不会形成后续轮次要保持的会话。虚拟模型既没有 `candidateModels` 也没有 `defaultModel` 时返回 HTTP 400，错误信息写明这两个选项：这是配置错误，不是分类问题。

**没有配置分类模型时升级的影响：** 发给 `agentcompass` / `agentcompass/*` 的请求不再从 `candidateModels` 里选模型。请设置 `defaultModel` 让它们仍能到达你指定的模型，或配置带分类模型的模式 B，或让客户端传 `body.profile`。`scorerType: "heuristic"` 和 `prefer_local_heuristic` 已删除，等同于没有分类模型。

#### 已知限制

- **模式 A 问不了分类模型。** 包里没有 `magpie.hooks`，`moejs` 没有网络，模式 A 的画像只能随请求带来。
- **模式 A 读不了配额文件。** `moejs` 没有文件系统，在这里配 `quotasPath` 总是报 `quotas_unreadable: missing`，文件存在时也一样。模式 A 请用 `quotas` 直接传读数，或者在 `/v1/systemone` 上用配额文件。
- **客户端用 `body.profile` 时，会话的每个请求都要带。** Magpie 给每个请求分配池里的运行时，只有服务过该会话的运行时才能保持。沙盒里会话中途不带画像的工具循环请求，20 次中有 4 到 10 次被保持，其余收到 Magpie 的 404。
- **请求只带当前轮的答案，不带前一轮的。** 新一轮画像变了时，服务过该会话的运行时保持，没服务过的按新画像走（沙盒里实时会话 20 次中有 3 到 5 次）。每轮画像不变则不会移动。
- **温会话不会每轮都问分类模型。** 保持判断在前，所以轻量模型上的温会话遇到更难的任务时，只有调用方画像说明了才会移动。
- **`session` / `strict` 模式超过 24 小时后，无记录的池化运行时仍会保持。** 持有记录的运行时在超过 24 小时后会直接让会话过期（`reasonDetail: "session_expired"`，`replayed: false`），不再回退到重放状态；但没有该会话记录的运行时只能从不带时间戳的对话历史重放状态，无法知道会话已经超过 24 小时，因此仍会保持——这是两种 24 小时粘性模式在池化运行时下的代价。
- **流式回复没有标注。** 流式走 `onEvent`，插件没有导出它，所以流式回复不会说明未路由；日志会写。
- **分类模型只看长文本的一部分**，用于限制工作量：提取请求文本时截成首尾合计 4000 字符（`capTextSlice`），`openai_compatible` 分类模型最多收到传给它的前 12000 字符。

#### 各安装来源下的名称

Magpie 会用包名前缀命名号池策略（`routings`），而客户端请求的虚拟模型（`agentcompass` / `agentcompass/auto`）与分类器模型（`agentcompass/agentcompass-systemone`）与安装来源无关：

| 安装来源 | 号池策略（`routings`） | 路由组分类器（模式 B） |
|---|---|---|
| 插件市场 `@magpie-community/gateway-agentcompass` | `gateway-agentcompass/agentcompass`、`gateway-agentcompass/agentcompass-pure` | `agentcompass/agentcompass-systemone` |
| GitHub `github:akiiwa-games/magpie-agentcompass-router` | `agentcompass/agentcompass`、`agentcompass/agentcompass-pure` | `agentcompass/agentcompass-systemone` |
| 本地目录 | `<目录名>/agentcompass`、`<目录名>/agentcompass-pure` | `agentcompass/agentcompass-systemone` |

可通过 `magpie plugin list` 查看本机实际注册的名称。

### 决策流程简述

1. **会话连续性优先（`src/continuity.js`）**：轮内工具循环（`within: true`）或 KV 缓存温热期内（Anthropic/Gemini `5m`，ChatGPT/Codex Responses 与 DeepSeek `1h`）直接保持当前 `<model>:<effort>` 且思考档位单调不降级（`keepsEffort`；实时会话不触发抬档棘轮）。短追问（`"继续"`）是普通的一轮，不读它的措辞；缓存已冷时连同上一轮一起交给分类模型。跨 `sync.Pool` 池化 `moejs` 实例时，自动从客户端重发的对话历史回溯锚点轮次（最多 4 轮）重放决策：默认 `cache` 模式下重放状态仅在轮内工具循环中保持；`session` / `strict` 模式下重放状态也会跨轮次保持，而持有记录的运行时在 24 小时过期后直接按过期（`session_expired`）处理、不回退到重放状态。仅在新会话、上游报错（`status >= 400`）、配额耗尽、新增图片内容或显式传入 `needs.gui` / `realtime_loop: true`、调用方画像的复杂度超出轻量模型、输入超窗口 95%、累计上下文达 2M、或缓存冷化/请求 token 骤降（压缩）后重新路由。（设计边界：温会话的 hold 发生在外部评分器调用之前，对已在跑的温会话不会在 hold 期间重跑分类器；`realtime_loop` 判定在会话首回合或重路由时由分类器给出并随会话状态保存，或由调用方在任意回合显式传入 `realtime_loop: true` 触发重路由，不做任何基于任务文本的硬编码判断。）
2. **任务画像与能力选型（`src/profiler-core.js`、`src/allocator.js`）**：单遍有界解析 Anthropic / OpenAI Responses / Chat / Gemini 请求体，取出轮次、工具循环、图片/视频内容类型等结构化事实；任务画像只来自分类模型 `src/scorer-live.js` 或调用方显式传入（含 `realtime_loop` 实时观察→动作循环标记）；结合 7 维客观能力、Effort 投入曲线、3 维 Model DNA、实时循环响应速度（`responsiveness` 下限 `0.50`、自动降档到过能力门限与响应下限的最高可派发档位、兄弟候选礼让、慢模型排除、未测速模型保守默认 `0.52`、用户点名仅告警：Magpie 上通过插件选项 `pinnedModel` / `pinnedEffort` / `pinnedBundle` 点名，告警写入 Magpie 日志）。`realtime_loop` 标记由中间件在转发前从请求体移除，不会发给上游；Magpie 的池化运行时之间不共享状态，客户端需每轮都带上该标记或设置插件选项 `realtime_loop: true`，否则未见过该会话的运行时会按非实时路由与防杀鸡用牛刀惩罚对 `candidateModels` 评分。
3. **订阅配额精算（`src/quota.js`）**：过滤低于安全水位（长窗口 `5%`、短窗口 `10%`）或限流的窗口，计算期望短缺机会成本，并在距重置 36 小时内对富余额度给予冲刺加分（`reset_bonus` / `sprint_sunk`）。

---

## Related projects

- [AgentCompass](https://github.com/akiiwa-games/AgentCompass) — cross-host multi-agent task router (`agentcompass roll`), 5h/7d subscription quota scheduler, 2M-token rotation guard, and `PreToolUse` spawn gate.
- [cindy-agentcompass-plugin](https://github.com/akiiwa-games/cindy-agentcompass-plugin) — Cindy host plugin for AgentCompass task routing and child-task collection.
- [Magpie](https://github.com/yetone/magpie) — local AI gateway and multi-subscription proxy.

## License

MIT
