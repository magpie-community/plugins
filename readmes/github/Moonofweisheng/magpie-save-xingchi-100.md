# magpie-save-xingchi-100

[简体中文](README.zh-CN.md)

Trigger Codex's native context compaction before Xingchi's 100-round limit, send the compaction request to a separate model, and resume ordinary requests on the primary model immediately. No model switching is needed during either compaction or recovery.

The guard is configurable and **disabled by default**. Exact agent, protocol and model IDs limit it to the routing group you configure. The verified profile is **Codex + Responses**; other clients, protocols and providers need their own validation.

Version `0.1.0` is distributed from GitHub source, not npm. The former candidate name was `magpie-context-guard`; use `magpie-save-xingchi-100` for this repository and package.

## Two live compactions verified

On **2026-11-26 (Asia/Shanghai)**, the GitHub plugin replaced the old custom guard and completed two consecutive automatic compactions in the **same real Codex conversation**, using real Xingchi and Command Code requests:

| Cycle | Native compaction completed | Compaction route | First ordinary request after compaction | Consecutive ordinary requests verified, including the first |
| --- | --- | --- | --- | --- |
| 1 | 19:19:37.724 | Command Code / DeepSeek V4.1 Flash, HTTP 200 | Direct Xingchi / GPT-6.1 Sol, one attempt, HTTP 200 | 12, all direct Xingchi |
| 2 | 19:35:05.768 | Command Code / DeepSeek V4.1 Flash, HTTP 200 | Direct Xingchi / GPT-6.1 Sol, one attempt, HTTP 200 | 14, all direct Xingchi |

Both reached a guard count of **90/90** and opened a fresh counter window after compaction. There was no manual model switch, manual `/compact`, lowered threshold or injected history. Guard counts include a conservative assistant/tool-history correction: 90 is not a claim of 90 user messages or 90 completed HTTP requests. Other-source isolation was checked through exact matching, tests and unchanged configuration; other providers were not live-tested. See [verification details and limits](docs/VERIFICATION.md).

## Quick start

### 1. Prepare the client and model IDs

- Use Magpie with both async gateway request hooks and gateway middleware. The tested host was Magpie `0.1.4526` / Bun `1.4.4` on macOS; this is an observed version, not a claimed minimum.
- Connect Codex to Magpie using Responses. Both the primary and compaction models must already work in Magpie; the compaction model must accept the full conversation being summarized.
- Run `magpie models` or inspect Magpie's model list to find your actual IDs. The IDs below are examples, not built-in provider names.

| Purpose | Example | Replace with |
| --- | --- | --- |
| Primary model | `api/gpt-6.1-sol` | Your capped provider's full model ID |
| Compaction / optional rescue model | `commandcode/deepseek/deepseek-v4.1-flash` | A model you can access for summarizing the conversation |
| Routing group | Stored ID `xingchi-gpt`; client ID `group/xingchi-gpt` | A dedicated group for that source only |

The CLI examples use a POSIX shell and assume `magpie` is on `PATH`. If the command is unavailable, use Magpie's UI or its actual executable path. Windows execution has not been verified.

### 2. Install the GitHub plugin

Add `github:Moonofweisheng/magpie-save-xingchi-100` from Magpie's Plugins page, or run:

```sh
magpie plugin add github:Moonofweisheng/magpie-save-xingchi-100
```

It appears as **Save Xingchi 100**. Installation alone does not enable the guard. Before migrating, back up your configuration and disable the old guard for this model so two plugins do not count or rewrite the same request. Do not disable unrelated plugins.

For local development instead:

```sh
git clone https://github.com/Moonofweisheng/magpie-save-xingchi-100.git
cd magpie-save-xingchi-100
magpie plugin add "$PWD"
```

### 3. Create a dedicated routing group

For a **new** group, replace the model IDs, then run:

```sh
magpie group add xingchi-gpt \
  models=api/gpt-6.1-sol,commandcode/deepseek/deepseek-v4.1-flash \
  routing=order stays=turn
magpie group set xingchi-gpt context=256000 compact=200000
magpie group rule add xingchi-gpt \
  use=commandcode/deepseek/deepseek-v4.1-flash compact
magpie group xingchi-gpt
```

`group add` can replace an existing group with the same name. For an existing group, inspect it first and edit only its intended settings/rule instead of repeating `add`. The equivalent UI setup is: primary model first, ordered routing, turn affinity, and a `compact` rule targeting the compaction model. Avoid session-pinned or drain routing when you expect immediate primary recovery.

[xingchi.routing-group.json](examples/xingchi.routing-group.json) shows the stored group object. Its `id` is `xingchi-gpt`, **without** `group/`; Codex and the plugin's `models` option use `group/xingchi-gpt`. Do not replace your whole providers configuration with this one object.

### 4. Save the plugin options

In **Plugins → Installed → Save Xingchi 100 → Options**, save this object after replacing your group and rescue model IDs:

```json
{
  "enabled": true,
  "agents": ["codex"],
  "protocols": ["responses"],
  "models": ["group/xingchi-gpt"],
  "roundLimit": 90,
  "overflowAt": 95,
  "overflowModel": "commandcode/deepseek/deepseek-v4.1-flash",
  "contextWindowTokens": 256000,
  "compactionRatio": 0.95
}
```

Or set options from a terminal:

```sh
magpie plugin options github:Moonofweisheng/magpie-save-xingchi-100 '{"enabled":true,"agents":["codex"],"protocols":["responses"],"models":["group/xingchi-gpt"],"roundLimit":90,"overflowAt":95,"overflowModel":"commandcode/deepseek/deepseek-v4.1-flash","contextWindowTokens":256000,"compactionRatio":0.95}'
```

Use the installed spec shown by `magpie plugin list`; local folder installations use their folder path. Save options for this plugin only. Do not paste API keys into options or overwrite `plugins.json` with an example. Ready-to-copy files: [Xingchi options](examples/xingchi.options.json) and [generic options](examples/options.json).

### 5. Select the group once in Codex

Select `group/xingchi-gpt` as the conversation's model through Magpie/Codex. Keep the compaction-model setting on **the current session's model**, so the request passes through the group's `compact` rule. Reload the client/model list if the new group or its context settings have not taken effect. Subsequent compactions and recovery do not require switching models.

Keep the protection scoped to this group. The plugin does not create groups, pick a client model or change the global compaction model. Another source serving the same GPT model does not match `group/xingchi-gpt`.

## Configuration reference

| Option | Meaning |
| --- | --- |
| `enabled` | Default `false`; explicitly enable it. |
| `models` | Exact full client model IDs; default empty, no wildcards. All listed IDs share one policy. |
| `agents` / `protocols` | Default `codex` / `responses`; other profiles need independent adaptation and validation. |
| `roundLimit` | Signal native compaction after a successful response at this guard count; default 90. |
| `overflowAt` / `overflowModel` | Optional late-window rescue while waiting for compaction. Threshold is at least `roundLimit`; empty model disables rescue. Use a reachable model with enough context. |
| `contextWindowTokens` | Context capacity configured for this client/model; default 0 leaves the guard inactive. |
| `compactionRatio` | Signal calculation fraction, default 0.95; ensure the resulting signal exceeds the client's effective compaction threshold. |
| `summaryPreamble` / `compactionPrompt` | Codex summary-prefix and compaction-prompt defaults; change only for an independently verified client version. |

The example group's `compact=200000` is a **token threshold**, not a promise to compact before 100 rounds. The independent `roundLimit=90` guard supplies that earlier request-count signal when needed. With `contextWindowTokens=256000` and `compactionRatio=0.95`, the successful response reports `floor(256000 × 0.95) + 1 = 243201`. The live client budget was 243200; the second cycle's actual input was only 93936 tokens. Confirm the effective threshold in your current client; a higher threshold can make the signal ineffective. Configure the target group rather than changing global limits for unrelated models.

Counting reserves one count per incoming client request, including failures and tool continuations, and takes assistant/tool history as a conservative lower bound. Internal provider retries do not reserve separate counts. This can trigger early, so keep a margin below the upstream cap. Compaction calls are excluded; a new native context window starts a new counter.

## Check your installation

```sh
magpie plugin list --json
magpie plugin options github:Moonofweisheng/magpie-save-xingchi-100
magpie group xingchi-gpt
```

Confirm both the async counter hook and middleware loaded without errors. In Magpie's Usage/Routing view, filter to the same conversation and verify:

1. Ordinary requests use the primary model before the configured count.
2. The count signal causes a **native client compaction**; the compaction request has `compact=true` and uses the summary model.
3. The very first subsequent ordinary request has `compact=false` and goes directly to the primary, with no initial rescue attempt. Verify at least five more ordinary requests and repeat for a second cycle.
4. The new window starts a fresh count and unrelated model IDs remain outside the configured scope.

For real acceptance, keep the actual threshold and continue real requests. A manual `/compact`, a small mock threshold or injected history alone does not establish automatic recovery. In raw routing logs, the top-level `provider` may still identify the logical source; inspect **`served` and `tries`** for the model/provider actually used.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Installed but inactive | Save `enabled: true`, a nonempty exact `models` list and positive `contextWindowTokens`; check both hook and middleware diagnostics. |
| Counter advances but no auto-compaction | Compare the calculated signal with the current client's effective threshold; reload stale model settings and inspect client usage events. A token-only 200K setting does not enforce a round cap. |
| Recovery stays on DeepSeek | Inspect the first recovery request's `compact`, `served` and `tries`; check old duplicate guards, group routing/affinity and compatibility with the current Codex summary format. Preserve the default prompt settings unless adapting a tested version. |
| A window is already near the upstream limit | Configure a working `overflowModel` with sufficient context; do not reset the counter to make an old window look new. A successful reply is needed to deliver the signal. |
| Want to use another source | Create its own group, replace the exact IDs and thresholds, and validate it separately. Do not add every GPT model to the protected list. |

## State and privacy

The counter is stored at `$XDG_CONFIG_HOME/magpie/plugins/context-guard/state.json`, or `~/.config/magpie/plugins/context-guard/state.json` when `XDG_CONFIG_HOME` is unset. It contains SHA-256 window keys, request counts, initial history corrections and timestamps only. Prompts, replies, account names, API keys and request bodies are not written by this plugin. The file is capped at 512 windows.

To disable the behavior, set `enabled` to `false` or turn off the plugin. To remove a GitHub installation, use Magpie's Installed plugins page or `magpie plugin rm github:Moonofweisheng/magpie-save-xingchi-100`.

## How it works

The async hook persists a counter per agent/protocol/model/context window. At the configured count, middleware raises the successful Responses reply's `usage.total_tokens` above the client's auto-compaction threshold. Actual input/output token fields and Magpie's recorded provider usage stay unchanged; Codex's cumulative token display can include the control value.

Codex performs native compaction and Magpie's group rule chooses the summary model. During recovery, the plugin temporarily quotes a known compaction instruction **only inside the known summary preamble** while Magpie selects a route, then restores the exact original text before the provider receives it. This avoids routing the first recovery request as another compaction. Actual compaction requests are not masked.

## Compatibility and limits

- Requires a Magpie version with gateway middleware and async request hooks.
- The counter hook and the middleware must both load. If the async hook is unavailable, history-based counting is only a fallback and is not persistent.
- The client must perform native compaction when it receives the configured usage signal.
- A successful model response is needed to deliver the signal. The optional rescue model covers windows that are already near their upstream cap when enabled.
- Test the selected client, model context size, routing group, tool continuations, retries and compaction recovery before relying on a new profile.
- No model provider, API key or organization-specific defaults are enabled by the published package.
- Local state writes are serialized inside one Bun host; multiple gateway processes sharing the same config folder have not been validated.
- This is a version-dependent Codex usage signal, not a general API for every client's compaction. Codex's cumulative token display can include the raised control value.

## Development

```sh
npm test
npm run check
npm run pack:check
```

An optional integration check uses an existing Magpie executable and Bun runtime:

```sh
MAGPIE_VERIFY_BINARY=/absolute/path/to/magpie \
MAGPIE_VERIFY_BUN=/absolute/path/to/bun \
npm run verify:magpie
```

It packs the package, installs the extracted files into an isolated HOME and XDG config, and sends requests to local mock providers. It verifies routing and usage signals; it does not run a real Codex session or real provider. Evidence is written to a sibling `magpie-save-xingchi-100-validation` folder, outside the npm package.

See [verification](docs/VERIFICATION.md) for observed results, [CHANGELOG.md](CHANGELOG.md) for package changes, and [publishing notes](docs/PUBLISHING.zh-CN.md) for release and listing options.

Magpie's upstream references: [plugin installation and options](https://usemagpie.ai/docs/plugins) and [routing rules](https://usemagpie.ai/docs/intent). Check your installed CLI's `magpie group --help` and `magpie group rule help` when using a different host version.
