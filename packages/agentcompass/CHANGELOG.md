# Changelog

One entry per version, newest first. This lists what a user has to know to upgrade.

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
