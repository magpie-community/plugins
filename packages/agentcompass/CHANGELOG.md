# Changelog

One entry per version, newest first. This lists what a user has to know to upgrade.

## 0.4.0 - 2026-11-19

The engine is AgentCompass v0.7.1 (pinned at `e35a462`, the `v0.7.1` tag), with the reference data of that release (schema 8: a value at every effort a gateway offers, or a declared known gap). `src/` is the source repository's at `1bd0181`. The source repository compares the port with AgentCompass's `allocator.plan` on a committed sample of 2,415 rows drawn from a grid of 96,572 (efforts `default`, `none`, `minimal` and `ultra` included), plus 280 bare-name rows, and the user-score overlay with AgentCompass's for four user-score documents (cells, measured efforts, operating-point floors, derived facets and the candidate note at every effort); every row and every model is alike.

**Upgrading**

- **Efforts run `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`** (`user-scores.js` `EFFORTS`, AgentCompass's `user_scores.EFFORTS`). A bare name on a provider with no launch table (a gateway) is now offered at every effort the data times, `none`, `minimal` and `ultra` included; give a row `efforts[]` to run it at fewer. A row's own list is still what it runs at.
- **Candidates from your gateway**: `scripts/candidates-from-models.mjs` turns your Magpie's `GET /v1/models` into `candidateModels` rows with Magpie's own efforts per model ([reference](docs/reference.md#candidates-from-the-gateway)). A model Magpie lists with no reasoning levels becomes a row at `default`, its one configuration: one candidate, scored where the data reads `default` (High), and sent to Magpie as the bare model with no effort.
- **`userScores` schema 4.** A table of schema 3 (0.3.0) is read and upgraded: a score under a name v0.7.0 resolved through an alias v0.7.1 removed or re-targeted (`gemini-4-pro`, `gemini-4-ultra`, `claude-opus-5`, `claude-sonnet-5`, `claude-fable-5`, `grok-4`, `kimi-k3.1-pro-highspeed`, `glm-5.3-flash`, `deepseek-flash`, `deepseek-v4-flash`, `deepseek-v4.1-flash`, `mimo-v2.6-pro-ultraspeed`) moves to the row v0.7.0 meant, so it keeps scoring the model you scored. A score whose name resolves to no row is kept in your table and ignored; it no longer makes a row of its own. A hand-written score now fills every effort the panel steps to, and no curve inverts along effort.
- **Model identity moved** (AgentCompass v0.7.1): `gemini-4-pro` and `gemini-4-ultra` are no longer aliases of `gemini-4-argon-high` (they are now family names, with no scores); `claude-opus-5`, `claude-sonnet-5`, `claude-fable-5`, DeepSeek's dated snapshots, `glm-5.3-flash`, `kimi-k3.1-pro-highspeed` and `mimo-v2.6-pro-ultraspeed` are rows of their own; `claude-haiku-4-5-20251001` is an alias of `claude-haiku-4-5`. A `candidateModels` entry or pin under one of these names now reaches that row, or is out of automatic routing with a warning if it has none.
- **`gpt-6-pro`** is `gpt-6-astra` at one operating point above `max`: a maintainer score on it never reads below that point, and a candidate's note shows both inputs and which binds.
- **The candidate note of a manual score** says what routing reads on each facet at the candidate's effort (`manual capability scores applied, read at <effort>: ...`).
- **The catalog warning of a family name** no longer says it is scored as an estimate of its series' row: such a name has no scores, as the code already did since 0.3.0.
- **Removed exports**: `EFFORT_ORDER` (`catalog.js`, `quota-economy.js`; use `EFFORTS` from `user-scores.js`). New: `EFFORTS`, `MEASURED_EFFORTS`, `EDGES`, `edgeAnchor`, `anchorEffort`, `boundAlongEffort`, `operatingPointFloor`, `appliedScores`, `appliedNote`, `DERIVED_FROM_LARGER` (`user-scores.js`); `readingEffort` (`axis-scores.js`); `V0_7_0`, `v070Row` (`released-names.js`); `FIVE_AXIS_EFFORT_READINGS`, `FIVE_AXIS_EFFORT_STEPS` (`reference-data.js`). A task's `include_unverified` and `force_fast` are no longer read (AgentCompass v0.7.1: a caller cannot lift the launch-evidence check; this port carries no fast mode).
- **Some model names are served as other weights than the row they name.** On the saved Magpie 0.1.4470 catalog the provider's own listing identifies
  `deepseek-v4-pro` on `deepseek` as `deepseek-v4-pro-0813`, `deepseek-v4-flash` on `deepseek` as `deepseek-v4.1-flash-1017`, `gemini-3.1-flash-lite-preview`
  on `google` as the preview model itself while the name resolves to the `gemini-3.1-flash-lite` row, and `ministral-3b-2512`, `ministral-8b-2512`, `ministral-14b-2512` on `mistral` as
  `ministral-3-3b-instruct-2512`, `ministral-3-8b-instruct-2512`, `ministral-3-14b-instruct-2512`. The plugin scores each as the row its name resolves to and
  routes it automatically, as AgentCompass v0.7.1 itself would, so its scores may be those of other weights. If that matters to you, name the model you
  want (a pin) or leave the name out of `candidateModels` (or add it as a `disabled` row). It closes when AgentCompass's reference data says which row a name
  is on each provider, ported in a later plugin release.
- A pin is still refused on a row you marked `disabled` (`pin_unavailable`): the plugin has no separate record of the user's own naming, which is what lets AgentCompass v0.7.1 launch an unchecked model the user names.

## 0.3.0 - 2026-11-18

The engine is AgentCompass v0.7.0 (pinned at `7827cdb`, the `v0.7.0` tag), with the reference data of that release; `src/` is the source repository's at `c27dd73`. The source repository compares the port with AgentCompass's `allocator.plan` on a committed sample of 1,085 rows drawn from a grid of 43,372 (the whole grid was also compared once); every row is alike. This version also carries what 0.2.2 was to bring (prepared on 2026-11-18, never published), the first item below.

**Upgrading**

- **A row's own `efforts[]` is what it runs at** (from 0.2.2). Before, the efforts a row listed were intersected with the launch table shipped with the version (`dispatch_efforts`): a listed effort the table lacked was dropped, and a row whose efforts the table did not list at all was kept but out of automatic routing. Now the list is used as written and the table applies only to rows that list no efforts. An effort the shipped data does not score leaves automatic routing with a data error naming the missing data; naming the model still dispatches it. The `not_dispatchable` flag is gone. If your `candidateModels` list efforts your upstream cannot run, remove them. An empty `efforts: []` counts as no list.
- **The profile changed.** A profile names one of 11 work kinds (`creative_ideation`, `architecture_reasoning`, `code_implementation`, `frontend_ui`, `code_audit`, `exploration_forensics`, `web_research`, `visual_analysis`, `text_processing`, `live_loop`, `gui_control`) with its depth `primary_level` 1..3, an optional `secondary_kind` with `secondary_level`, `access`, `local_only`, `needs_visual`, `wants_fast`, `expected_hours` and `task_count`. `axis_demand` is projected from the kinds and depths through AgentCompass's declared signature table; it may still be given explicitly. `needs_gui`, `read_only_review` and `multi_task` are derived. `reasoning_depth`, `code_complexity`, `interaction_style`, `hours_confidence` and `urgency` are gone, and the first category is `creativity` (was `divergence`). A profile of the 0.2.x shape is refused with `invalid_caller_profile`; nothing reads it for compatibility. A valid one: [reference](docs/reference.md#task-profile).
- **The classifier** is asked AgentCompass's v0.7.0 prompt with its classifier cases (OpenAI-compatible) or its ten questions (`jev`). An answer of the old shape is invalid; the in-memory cache revalidates every entry on read, so nothing old is served.
- **`userScores`**: level 3 is now the panel's best and levels above 3 extrapolate. Write `{ "schema_version": 3, "scores": { ... } }`. A table without `schema_version` is read as the 0.2.x shape and upgraded by AgentCompass's declared steps (`divergence` renamed `creativity`, then the level-3 conversion): your table is converted, never dropped or refused. A hand-written `tool_operation.responsiveness` level bounds the other efforts in the facet's direction.
- **An `aesthetics` demand of 2 or 3** also needs `tool_operation.image_recognition` data; a model without it leaves automatic routing with the missing facet named.
- **An advisor-only model** (`gpt-6-pro`) is also kept out of a task with `access: "write"`.
- **A pool row's `when.max_reasoning_depth` is now `when.max_primary_level`.** An old key is ignored.
- **Removed exports**: `INTERACTION_STYLES` (`catalog.js`); `FIVE_AXIS_DEMAND_LEVELS`, `FIVE_AXIS_DEMAND_SCHEMA` (`axis-scores.js`); `SCORER_SYSTEM_PROMPT`, `JEV_SCORE_QUESTIONS`, `JEV_STYLE_CRITERIA`, `JEV_EFFORT_BANDS`, `JEV_URGENCY_CRITERIA`, `JEV_NOUL_QUESTIONS` (`scorer-live.js`); `PROFILE_FLAGS`, `MULTI_TASK_QUESTION`, `READ_ONLY_REVIEW_QUESTION` (`profiler-core.js`). New: `WORK_KINDS`, `WORK_KIND_SIGNATURES`, `ROLE_FN`, `projectAxisDemand` and the question texts (`profiler-core.js`); `SCORER_PROMPT`, `scorerSchema`, `scorerEvidence`, `profileQuestions`, `PROFILE_*` (`scorer-live.js`); `LEVEL_FACETS`, `FACET_CATEGORY` (`axis-scores.js`); `upgradeScores`, `LOCAL_UPGRADES`, `convertLevel` (`user-scores.js`); `CLASSIFIER_CASES`, `LEVEL3_CONVERSIONS` (`reference-data.js`). `taskKind` and `profileKind` take no policy.
- The reference data is AgentCompass v0.7.0's, including the GPT-6.2 rows. Nothing is fetched at run time.

## 0.2.1 - 2026-11-13

The engine follows AgentCompass `2844342` (v0.6.0 plus one routing rule).

- **A `needs_visual` task requires image input at every `tool_operation` level.** Before, the image-input gate applied only at `tool_operation` 3, so a task marked `needs_visual` (or `needs_gui`) with a lower level could be routed to a model whose public data says it takes no image input. Such a model now leaves the task, and a model with no cited modality leaves automatic routing; naming it still dispatches it with the data error. Nothing to change when upgrading.

## 0.2.0 - 2026-11-13

The engine is AgentCompass v0.6.0 (pinned at `974eb49`, the `v0.6.0` tag), ported module by module: four capability categories (`divergence`, `coding`, `aesthetics`, `tool_operation`) in place of the 6D/7D vectors and the 3D model profile, data gates, and the quota economy. The source repository compares the port with AgentCompass's `allocator.plan` on a committed sample of 1,451 rows, drawn from a grid of 58,016. How the engine scores is AgentCompass's ([technical reference](https://github.com/akiiwa-games/AgentCompass/blob/v0.6.0/docs/technical-reference.md#1-how-scoring--allocation-work)).

**Upgrading**

- **The profile changed.** `axis_demand`, `access`, `wants_fast` and `read_only_review` are required; `context_scale`, `hallucination_risk`, `error_cost`, the top-level `divergence` and `realtime_loop` are gone. A profile of the old shape is refused with `invalid_caller_profile`; nothing reads it for compatibility. A valid one: [reference](docs/reference.md#task-profile).
- **`realtime_loop` is removed** (the option, the request field and the `realtime_loop` session hold).
- **A family or unknown name has no scores.** `claude-opus-9` is no longer scored as a generic row or as an estimate of its family: automatic routing does not pick it, and naming it dispatches it with a data-error warning.
- **An account with no `plan` has unknown capacity** and is out of automatic routing: put `plan` in `quotas`.
- **No ability floor, over-qualification penalty or realtime step-down.** The fit and the quota economy choose the effort.
- **New option `userScores`**: your own category scores for a model, ahead of the maintainers' and measured ones.
- **Removed exports**: from `catalog.js`, `DEFAULT_MODELS`, `DEFAULT_SCORING_POLICY`, `KIND_TRAITS`, `CANONICAL_ROUTES`, `EFFORT_CURVES` and `resolveModelSpec`; from `index.js`, `computeWindowCost`, `demandForecast`, `evaluateModelQuota`, `CANONICAL_ROUTES` and `healthOnlyQuotas`; from `continuity.js`, `effectiveRealtimeLoop`. `ROUTES` is new. `canonicalModel` returns a family or unknown name as it is.
- **Held sessions**: the difficulty-driven raise on `capability_outgrown` is gone; a request that needs images or a GUI outgrows a model that takes no images.
- **Bare names in a pool**: when a provider has a table of efforts and the model is not in it, the row has no efforts, so a step-down never lands on an unverified effort; `antigravity` and `gemini` no longer borrow another provider's table.
- **A quotas file broken for over 6 hours** excludes only `pool/quotas` in `selectBestRoute`; `onAccount` still answers 503 when every candidate account is unavailable.

Not ported, because Magpie only routes: launching workers, harness order, and the launch side of fast mode.

The comparison with AgentCompass's `allocator.plan` and the Linux sandbox run stay in the source repository, [akiiwa-games/magpie-agentcompass-router](https://github.com/akiiwa-games/magpie-agentcompass-router); this package's tests run on their own. The sandbox script was rewritten for this engine and ran on real Magpie 0.1.4026 (2026-11-13) with real Codex and Claude sign-ins: scenarios 1–10 and 12–15 passed, scenario 13 against both real upstreams included (no `profile` on the wire, the routes the engine gives, a real classifier, one valid account among invalid peers, every account unavailable). The record is `docs/linux-sandbox-e2e-report-0.1.4026.json` there.

## 0.1.6 - 2026-11-08

- **Automatic routing needs a classifier or a caller's profile.** The plugin stopped guessing a profile from regular expressions, word lists or message length. Mode A cannot reach a classifier, so a request to `agentcompass` or `agentcompass/*` without `body.profile` is no longer routed (Magpie's log says `未路由：分类不可用`; a JSON reply carries `agentcompass: { routed: false, notice, reason }`). To keep routing: use Mode B with a scorer, send `body.profile` on every request, or set `defaultModel` for a fixed fallback. `scorerType: "heuristic"` and `prefer_local_heuristic` are gone and count as no classifier. See [Without a profile](docs/reference.md#without-a-profile).
- **Account states, plan-sized capacity and refusal codes.** States `ready`, `plan_inactive`, `usage_failing`, `auth_failed`, `disabled`; a `usage_failing` account keeps dispatching for 6 hours after its last good reading. A configured quotas file that cannot be read is reported as `pool/quotas`. When nothing can serve a request the plugin answers HTTP 503 with a code (`no_route`, `accounts_unavailable`, `pin_not_in_pool`, `model_unhealthy`, `pin_unavailable`, `invalid_caller_profile`) instead of picking an excluded candidate. See [Quotas and accounts](docs/reference.md#quotas-and-accounts) and [refusals](docs/reference.md#candidates-pins-and-refusals).
- **`/v1/systemone` answers only the route** unless `decisionProviderDetails: true`; accounts, quotas, the profile and `warnings` go to the local log, and a refused pin is always `pin_unavailable`.
- **Disabling an effort**: a row with `disabled: true` next to the bare name or `efforts[]` row turns off that effort for the model (and the account, when the row names one).
- **Health and pins**: a failure of a family name no longer takes down the flagship, and naming a model matches only that model's rows.
- **Session holds**: `affinityMode` accepts `cache`, `turn`, `session`, `strict` and `off`; a held effort that the pool no longer offers steps down or ends the hold (`effort_gone`); a session held 24 hours expires.
- **Old model aliases are gone.** Names Magpie once aliased to the then-current flagships (`gpt-5.4`, `claude-3-5-sonnet`, ...) are no longer in the catalog: each logs `candidate name <name> is not in the catalog` once per runtime and is out of automatic routing. Use the names in AgentCompass's [`model-capabilities.md`](https://github.com/akiiwa-games/AgentCompass/blob/v0.6.0/skills/agent-compass/references/model-capabilities.md).

## 0.1.5 - 2026-11-08

- A request that lands on a pooled `moejs` runtime that did not serve the earlier turn replays the anchor turn from the resent history (`replayedState`), so a session stays on its model across runtimes; a replayed state has no age, so in `cache` mode it holds only inside a tool loop.
