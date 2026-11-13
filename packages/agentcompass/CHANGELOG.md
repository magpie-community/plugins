# Changelog

## 0.2.0 - 2026-11-13

### The scoring engine is AgentCompass v0.6.0

The scoring, quota economy and data gates are now AgentCompass v0.6.0's, ported module by module and compared with its `allocator.plan` (that comparison, the 1,451-row parity sample and the generated-data check, stays in the source repository, `akiiwa-games/magpie-agentcompass-router`; this package's tests run on their own). Ten modules are new under `src/`: `axis-scores`, `candidate-eval`, `candidate-ranking`, `fleet`, `plans`, `quota-economy`, `quota-pools`, `reference-data`, `task-intake` and `user-scores`.

**Scoring**

- Four capability categories: `divergence`, `coding`, `aesthetics`, `tool_operation`. A profile states its demand in `axis_demand` (each 0..3). Each `<model, effort>` row's net score is `N = fit + continuity + boost - quota_cost`, with `fit = Σ w·(min(z, cap) − t1) / Σ w`. Level 3 `tool_operation` needs a model with image input.
- Data gates (rule B): a demanded category with no data, a billed account with no cited price, unknown image input, an effort with no Time/Task, or a window of unknown capacity takes that row out of automatic routing. Naming the model (a pin) still dispatches it, with the data error in `warnings`.
- No capability floor, over-qualification penalty or realtime step-down any more: the fit and the quota economy choose the effort. Rows are ordered by net score, then waiting hours, completion hours, dollars and category level.
- Quota economy v3.1: a 5-hour window only gates feasibility; windows of 24 hours or more are priced as opportunity cost. A window confirmed exhausted, or under the start floor, excludes the row. An account whose `plan` is not reported has no known capacity and is out of automatic routing: put `plan` in `quotas`.
- Pins: `constraintModel` / `pinnedModel` (optionally `:effort` or `-effort`), `constraintEffort` / `pinnedEffort` and `pinnedBundle`. A pin that cannot be served is refused with a code; no other model is substituted.
- New option `userScores`: your own category scores (levels 1..3) for a model, ahead of the maintainers' data and measurements.

**What changes for you when you upgrade**

- The profile shape changed. `axis_demand`, `access`, `wants_fast` and `read_only_review` are required; `context_scale`, `hallucination_risk`, `error_cost`, `divergence` and `realtime_loop` are gone. A profile in the old shape is refused (`invalid_caller_profile`); there is no compatibility read.
- `realtime_loop` is removed everywhere: the option, the request field and the `why: "realtime_loop"` session hold.
- A family name or an unknown name (`claude-opus-9`) has no score of its own: automatic routing never picks it; only naming it dispatches it, with a data-error warning. It is no longer scored as a "generic row" or estimated from its family.
- Removed exports: from `catalog.js`, `DEFAULT_MODELS`, `DEFAULT_SCORING_POLICY`, `KIND_TRAITS`, `CANONICAL_ROUTES`, `EFFORT_CURVES` and `resolveModelSpec`; from `index.js`, `computeWindowCost`, `demandForecast`, `evaluateModelQuota`, `CANONICAL_ROUTES` and `healthOnlyQuotas`; from `continuity.js`, `effectiveRealtimeLoop`. `ROUTES` is new.
- The session hold's tier-based raise (the difficulty-driven `capability_outgrown` upgrade) is removed. A GUI / computer-use task outgrowing a light model is judged by whether the model has image input.
- `canonicalModel` returns a family or unknown name as it is: each is a model of its own, not folded into the flagship.
- A bare model name in a pool: when the provider has a dispatch-effort table and the model is not in it, the row has no efforts (as in `account_fleet.dispatch_allowed_efforts`), so a step-down never lands on an unverified effort. A gateway with no table still expands the efforts the data lists. `antigravity` and `gemini` have no table of their own and no longer borrow `antigravity-resilient`'s. Export names and signatures are unchanged; the behaviour of `dispatchTable` and `bareEfforts` changed.
- A `quotas` file broken for more than 6 hours: in `selectBestRoute` only `pool/quotas` is excluded, with a warning; gateway rows with no account behind them route as usual (the `onAccount` path still answers 503 when every candidate account is unavailable).

**Not ported** (Magpie only routes): launching workers, harness order and place (`harness_place` is always 0), and the fast variants and the launch side of `wants_fast`.

**Checked in a real gateway:** the source repository's Linux sandbox run passed on Magpie 0.1.4022 with this engine (CLI install, market listing, Mode A and Mode B, every pool shape on four protocols, session continuity, pins, caller profiles); its record is `docs/linux-sandbox-e2e-report-0.1.4022.json` there. The scenario against real upstream accounts was not run.

## 0.1.6 - 2026-11-08

### Breaking: Classifier-only task profiling (no text heuristics)

The router no longer guesses task profiles from regular expressions, keyword lists, or message length. Task profiles come only from an external classifier (`src/scorer-live.js`) or from the caller (`ctx.state.profile`, `ctx.profile`, `body.profile`, or `state.task.profile` / `state.profile` on `/v1/systemone`).

- **Upgrade impact on Mode A (`magpie.middleware`)**: `moejs` has no network, so Mode A cannot call a classifier. Requests to `agentcompass` / `agentcompass/*` (or concrete models under `routeAllModels: true`) that do not carry `body.profile` are forwarded unrouted (`agentcompass: 未路由：分类不可用 (<reason>)` in Magpie's log, and `agentcompass: { routed: false, notice, reason }` on JSON replies). Without `defaultModel`, `agentcompass/auto` stays as-is and Magpie returns 404.
- **How to keep routing**:
  - Switch to Mode B (`/v1/systemone` Routing Group classifier) with `allowExternalScorer: true` and a configured `scorer` (`scorerBaseUrl`, `scorerCommand`, or `scorer`).
  - Have the client pass `body.profile` on each request.
  - Set `defaultModel` if you want a fixed fallback model for unrouted virtual model names.
- `scorerType: "heuristic"` and `prefer_local_heuristic` have been removed and count as no classifier.

### Live observe-act loop responsiveness (`realtime_loop`)

- Synced AgentCompass v0.4.1 `realtime_loop` and per-turn responsiveness scoring:
  - Candidates below the per-turn responsiveness floor (`0.50`) step down to the highest provider-dispatchable effort (`DISPATCH_EFFORTS`) that clears both the task's ability gate and the responsiveness floor (`resolveRealtimeEffort`), skipping fixed-effort model IDs and deferring when a healthy sibling candidate already covers that lower effort.
  - Candidates still below `0.50` after step-down are excluded (`responsiveness X.XX below the realtime_loop floor 0.50`). Unmeasured models default to `0.52` (`responsiveness_source: "default"`). `gpt-5.3-codex-spark` has its own conservative catalog entry (`tier: 3.0`, responsiveness `0.52`).
  - Eligible candidates blend `0.35 * responsiveness` into `fit_score`.
  - User-pinned models/efforts (`pinnedModel`, `pinnedEffort`, `pinnedBundle`) are never stepped down or excluded for responsiveness, logging a warning instead.
  - `keepsEffort` does not ratchet stepped-down `realtime_loop` efforts back up during warm holds.

### Account states, plan-sized capacity, and refusal codes

- **Plan-sized window capacity** (aligned with AgentCompass `references/plan-templates.json`):
  - Codex weekly `plus` 67 (5h 10; `team` = plus), `pro100` 175 (alias `prolite`), `pro` 325 (no 5h window for `pro100` / `pro`).
  - Claude weekly `pro` 156 (5h 18), `max5` 1400 (5h 94, `weekly_fable` 700; bare `max` = `max5`), `max20` 2380 (5h 376, `weekly_fable` 1190).
  - Antigravity `pro`, `ultra5`, `ultra20` (bare `ultra` = `ultra20`) with template sizes for `gemini-5h`, `gemini-weekly`, `3p-5h`, and `3p-weekly`.
  - Unknown or unreported plans fall back to the smallest known plan of that provider and emit a warning. Online `plan` takes precedence over credential `plan_claim`, and disagreements are surfaced as `plan_conflict { online, credential }`.
- **Account states**: `ready`, `plan_inactive` (free, expired, cancelled, payment failed), `usage_failing` (error, missing reading, or no fresh reading for > 2 h via `usage_fresh_hours`), `auth_failed` (structured HTTP 401/403), and `disabled`.
  - `plan_inactive`, `auth_failed`, and `disabled` are never selected.
  - `usage_failing` warns immediately and continues dispatching until the last successful reading is older than 6 h (`usage_max_age_hours`), after which it is excluded.
  - `selectBestRoute`, `hooks`, `/v1/systemone`, `listQuotaAccounts(quotas)`, and `formatQuotaAccountList(rows)` expose structured account status rows (`status`, `reason`, `plan`, `last_success_at`, `dispatchable`, `failing_since`, `exclude_after_hours`, `usage_excluded`, `plan_conflict`).
- **Unreadable quotas file**: A configured `quotasPath` / `magpieConfigDir` file that is missing, unreadable, invalid JSON, or wrong schema adds a pool-level `pool/quotas` entry (`usage_failing`, `quotas_unreadable: missing | unreadable | invalid_json | wrong_schema`) to `accounts` and `warnings`, preserves the last good snapshot, logs once per change, and is exposed via `getQuotasLoadStatus()`.
- **`accounts_unavailable` refusal code**: When no model is pinned and at least one candidate is not excluded by non-quota reasons (capability, modality, effort, responsiveness) and every such capable candidate fails because its accounts are unavailable (`plan_inactive`, `auth_failed`, `disabled`, or `usage_failing` past 6 h), routing refuses with HTTP 503 `accounts_unavailable: every candidate account is unavailable` (including bare candidate names that expand across efforts). If all candidates fail for non-quota reasons or healthy accounts have exhausted windows, the refusal remains `no_route: no candidate can serve this request`.

### Three-repo routing contract (R1–R6) and session continuity

- **No silent fallback to excluded candidates**: When no candidate in `candidateModels` can serve a request, middleware and hooks return HTTP 503 with a structured reason code rather than picking an excluded candidate.
- **503 refusal codes**:

| 503 reason code | Message (`agentcompass: ` prefix) | When returned |
|---|---|---|
| `no_route` | `no_route: no candidate can serve this request` | Unpinned request where all candidates are excluded by non-quota reasons (capability, modality, effort, responsiveness) or by exhausted window quota |
| `accounts_unavailable` | `accounts_unavailable: every candidate account is unavailable` | Unpinned request where at least one candidate passes non-quota checks and all such candidates are excluded because their accounts are unavailable |
| `pin_not_in_pool` | `pin_not_in_pool: pinned model <name> is not among the candidates` | Pinned model/bundle is not in `candidateModels` |
| `model_unhealthy` | `model_unhealthy: pinned model <name> is marked unhealthy` | Pinned model is marked unhealthy |
| `model_unhealthy` | `model_unhealthy: the model of pinned bundle <name> is marked unhealthy` | Pinned bundle's model is marked unhealthy |
| `pin_unavailable` | `pin_unavailable: pinned model <name> cannot serve this request` | Pinned model/bundle/effort is unavailable for another reason (disabled effort, below floor, account/quota) |
| `invalid_caller_profile` | `invalid_caller_profile: the task profile is invalid` | Caller-supplied `profile` failed schema validation |
| Other code | `<code>: this request could not be routed` | Other refusal (such as `classifier_invalid_output`) |

- **`/v1/systemone` summary by default**: Unless `"decisionProviderDetails": true` is explicitly set, `/v1/systemone` returns only `{ targetModel, targetEffort }` or `{ targetModel: null, blocked: true, error, message }` (redacting pinned names to `pin_unavailable`) so gateway keys cannot probe pool contents or account quotas. `warnings` go to the local log; when no candidate can serve a request, `warnings` in the local log may include account names and quotas.
- **Disabling an effort (`disabled: true`)**: Adding `{ "model": "<model>", "effort": "<effort>", "disabled": true }` alongside a bare name or `efforts[]` row prevents any row of that model (and account, if `account` is set on the disabled row) from dispatching that effort, refuses pins to that effort with `pin_unavailable`, and moves held sessions off it (`onProvider` and `/v1/systemone` short follow-ups included).
- **Model health and pin isolation**: Exact and alias model names record health under their canonical entry; family names record health under their own raw name (`gpt-6.2-sol-preview` failing does not mark `gpt-6.1-sol` unhealthy). Pinning an exact/alias model matches only that model's rows, never a family row.
- **Session continuity (`affinityMode`, `effort_gone`, `session_expired`)**:
  - Supports `"cache"`, `"turn"`, `"session"`, `"strict"`, and `"off"`.
  - In `session` and `strict` modes, a state replayed from conversation history (`replayedState`) holds across turns within the 24-hour window so pooled `moejs` runtimes stay on the session's model. When the runtime holding the session record sees the 24-hour retention expire, `SessionContinuityStore.get(..., { keepExpired: true })` deletes the entry and expires the session directly (`reasonDetail: "session_expired"`, `replayed: false`) without falling back to `replayedState`.
  - In `cache` mode, a replayed state has no timestamp (`ageKnown: false`) and holds only inside an in-turn tool loop (`within: true`), treating TTL-gated holds (`cache`, `realtime_loop`) as cold.
  - When a held effort is no longer offered by the pool, the hold steps down to the highest pool-offered effort that clears the new-route gates, or breaks with `why: "effort_gone"` and re-routes using the session's task profile.
- **Other contract alignments**:
  - Turns with no user text (e.g. image-only first turns) still route whenever a candidate pool or pin is configured.
  - `:auto`, `:off`, and `:default` on candidate names do not constrain effort (`-off` is not an effort suffix); `:default` on a pin names a concrete effort and returns 503 `pin_unavailable` if no row offers it.
  - Task-level `multi_task` and `task_count` are strictly validated (`invalid_caller_profile` on non-boolean or out-of-range values).
  - Unclaimed requests strip router pin fields before forwarding upstream.
  - Held turns preserve the candidate row's `modeId` and `draws`.
  - Scores round half-to-even (`round3` / `round4`) to match Python's `round()`.
- **Retired model aliases (57 names)**: Legacy Magpie-only aliases not in AgentCompass's `accounts.json` were removed and emit a once-per-runtime `candidate name <name> is not in the catalog: ...; use <replacement>` warning:
  - **1. Unlisted names scored on the generic row (`tier: 2.8`, 34 names)**:
    - Use `claude-haiku-5-5`: `claude-3-5-haiku`, `claude-3-5-haiku-latest`, `claude-3-haiku`
    - Use `claude-opus-5-5`: `claude-3-opus`
    - Use `claude-sonnet-5-5`: `claude-3-7-sonnet`, `claude-3-7-sonnet-latest`, `claude-3-5-sonnet`, `claude-3-5-sonnet-latest`
    - Use `gpt-6-astra`: `gpt-5.5`, `gpt-5.4`, `gpt-5`, `o3`, `o1`
    - Use `gpt-6-luna`: `gpt-5.4-mini`, `gpt-5.4-nano`, `gpt-5.5-mini`, `gpt-5.5-nano`, `gpt-5-mini`, `gpt-5-nano`, `gpt-4.1-mini`, `gpt-4.1-nano`, `gpt-4o-mini`
    - Use `gpt-6-pro`: `gpt-5.5-pro`, `gpt-5.4-pro`, `o3-pro`, `o1-pro`
    - Use `gpt-6.1-sol`: `gpt-5.3-codex`, `gpt-5.2-codex`, `gpt-5.1-codex`, `gpt-5-codex`, `gpt-4.1`, `gpt-4o`, `o3-mini`, `o4-mini`
  - **2. Family-estimated names (`tier - 0.3`, 20 names)**:
    - Use `claude-opus-5-5`: `claude-opus-4-5`, `claude-opus-4-1`, `claude-opus-4`
    - Use `claude-sonnet-5-5`: `claude-sonnet-4-5`, `claude-sonnet-4`
    - Use `deepseek-v4-pro`: `deepseek-r1`, `deepseek-reasoner`, `deepseek-v3`
    - Use `deepseek-v4.1-flash-free`: `deepseek-chat`, `deepseek-v4.1-io`
    - Use `gemini-3.8-flash-high`: `gemini-3-flash`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`, `gemini-2.0-flash`, `gemini-2.0-flash-lite`
    - Use `gemini-4-argon-high`: `gemini-3-pro`, `gemini-2.5-pro`
    - Use `gpt-6-luna`: `gpt-5.6-sol-mini`
    - Use `grok-4.7`: `grok-3`
    - Use `grok-4.7-build-fast`: `grok-3-mini`
  - **3. Dedicated catalog entries no longer aliased to newer flagships (3 names)**:
    - Use `claude-haiku-5-5`: `claude-haiku-4-5`
    - Use `claude-opus-5-5`: `claude-opus-4-6`
    - Use `claude-sonnet-5-5`: `claude-sonnet-4-6`

## 0.1.5 - 2026-11-08

- Replay anchor turns from conversation history (`replayedState`) across pooled `moejs` runtimes, keeping the routed candidate name (`heldTarget`) and marking replayed states `ageKnown: false` so `cache` mode holds only inside in-turn tool loops.
