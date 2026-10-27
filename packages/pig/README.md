# agent-pig

`@magpie-community/agent-pig` adds [PiG (Pi in Go)](https://github.com/MichaelKinsy/PiG) to Magpie as a **connect-only agent**. It supplies Magpie's endpoint and model catalog in `~/.pig/agent/models.json`. You choose the model in PiG. The plugin never writes `settings.json`.

The Agents row identifies PiG with the project's pixel-pig icon from its official site. The image is not bundled: Magpie references it by URL and keeps its own cache. This is an unofficial integration; PiG is a project by Michael Kinsy and is not affiliated with, or endorsing, Magpie.

## Installation

With a Magpie release that supports connect-only Agent plugins:

```sh
magpie plugin add @magpie-community/agent-pig
```

1. Open Magpie's Agents page and turn on **PiG**. Its row is a provider switch, with no model picker. CLI equivalent: `magpie pig provider magpie`.
2. Start PiG, run `/model`, and select a model under the **Magpie** provider. Reopen `/model` after Magpie's catalog changes; restart PiG if your installed version does not reload it there.
3. Before disconnecting, choose a model from another provider in PiG. Turn off **PiG** in Magpie, or run `magpie pig default`.

Saving a startup default is a separate PiG action: use PiG's own model picker to save it. The plugin does not set or restore defaults, thinking preferences, or scoped models. An existing `enabledModels` scope can restrict selection; change that scope yourself in PiG if necessary. Disconnecting cannot repair a saved default or resumed session that still names a Magpie model.

Disconnect the PiG agent before disabling or uninstalling the plugin; do not rely on removing a plugin to run the agent's disconnect flow.

## What it owns

Magpie manages **one complete object**, `providers.magpie`, inside `models.json`:

| Field inside the managed object | Value |
| --- | --- |
| `name` | `Magpie` |
| `baseUrl` | The gateway's supplied `/v1` address |
| `apiKey` | The key supplied by Magpie for PiG; normally `magpie-pig` on loopback |
| `api` | `openai-completions` |
| `models` | The catalog Magpie exposes to PiG |

Magpie stashes the previous object and restores it on **agent disconnect**. If no `magpie` provider existed, the entire provider is removed. An empty top-level `providers` map or file can remain, but a provider object with no settings of its own must not.

Other provider IDs, unrelated top-level keys, and document comments outside the managed object stay in place, including changes made while connected. A pre-existing provider with the same `magpie` ID is temporarily replaced and restored semantically on disconnect; its internal formatting/comments are not a byte-for-byte backup. While connected the entire `magpie` object, including personal overrides there, is managed and refreshed by Magpie. Keep concurrently used manual services under a different provider ID.

The plugin does not change `auth.json` or PiG's credential precedence. A stored credential for the reserved `magpie` ID can take precedence over the injected key; use a distinct ID for an independently configured manual service.

The plugin preserves catalog IDs (including slashes), names, image input capability, positive context/output limits, and supported Pi thinking levels. A known output limit is capped at the known context window, matching Magpie's Pi adapter. Unknown limits are omitted so PiG applies its own defaults. The public Agent hook does not provide a model's native protocol, prices, or a separate reasoning flag: all models use Magpie's documented Chat Completions endpoint, and reasoning is advertised when `efforts` is nonempty. Magpie handles upstream protocol translation. This is not the full native-protocol behavior of Magpie's built-in Pi adapter.

It reads no credentials, installs no PiG extension, runs no daemon, and provides no Library integration. Requests use Magpie's supplied key, so usage can be attributed to `pig` without claiming Pi's User-Agent.

## Configuration paths

The shipped descriptor targets **the default PiG directory only**, `~/.pig/agent`. It does not automatically follow `PIG_CODING_AGENT_DIR`, `PIG_HOME`, `XDG_CONFIG_HOME`, or `PIG_USE_PI_DIRS=1`. The current public Agent contract offers one static config path (with `~`/`$VAR` expansion), not a conditional directory resolver. Do not turn this descriptor on when PiG uses a different directory.

For a custom directory, make a local copy of `pig.agent.js`, change `agent.config` and `agent.dir` to the actual selected PiG paths, and install that file with `magpie plugin add /absolute/path/to/custom-pig.agent.js`. Install only one descriptor with id `pig`. Do not change PiG's directory layout for this plugin. In Pi sharing mode, editing a shared `models.json` also affects Pi; that is an explicit custom setup, not the default plugin behavior.

## Platform support

The same `pig.agent.js` was tested on native Linux and Windows with Magpie 0.1.1294 and PiG 0.5.1+1.3.0.1402973a using an external real-binary harness (not shipped in this package): 8 end-to-end tests and 3 lifecycle tests per platform. They cover fresh connect/disconnect/reconnect with a real PiG parse afterwards, a pre-existing manually configured API-key service used before, during and after injection, and restoration of a prior same-name provider. On Windows the default path resolves to `%USERPROFILE%\.pig\agent\models.json`, including when the test workspace and home paths contain spaces.

Magpie owns native home expansion, path separators, command detection, file edits and restoration. The plugin has no platform branches or platform-specific dependencies. macOS and WSL have not been tested on real machines.

## Development

The runtime module is a single file, without imports, runtime dependencies or install hooks. `package.json` declares `magpie.agent` and no `main`, following the [community Agent convention](https://github.com/magpie-community/plugins#agents) and [public contract](https://usemagpie.ai/docs/plugins#agents).

From `packages/pig` in a checkout of the community plugins repository, run the included unit tests with Bun:

```sh
bun test pig.test.mjs
```

The repository's `scripts/check.mjs` skips Agent packages; `pig.test.mjs` checks this plugin's descriptor and `connect()` output. The published npm package excludes tests and research artifacts.

## 中文

这是仅注入模型目录的 PiG 适配插件。通过 `magpie plugin add @magpie-community/agent-pig` 安装后，在 Magpie 的 Agent 页打开 **PiG**，再到 PiG 中运行 `/model` 选择 Magpie 模型。

插件只通过 Magpie 托管 `~/.pig/agent/models.json` 中完整的 `providers.magpie` 对象，不修改 `settings.json` 或 `auth.json`，也不替用户设置启动默认模型、思考等级或模型范围。断开时，原先有同名 provider 就恢复原对象，原先没有就移除整个 provider，避免空 provider 导致 PiG 解析失败。

其他 provider 和顶层设置不在托管范围内。若原先就手动配置了名为 `magpie` 的 provider，它在接入期间会被替换，断开后恢复；接入期间对该区块的手写改动会被同步覆盖。需要同时使用的手动服务应使用其他 provider ID。插件不会修改既有凭证优先级。

默认仅支持 `~/.pig/agent`。使用环境变量改过目录或开启 Pi 共享目录的用户，需要先明确实际路径，再安装改过路径的本地描述文件。不要直接启用默认描述文件。

断开前在 PiG 中换回其他 provider 的模型；先断开 PiG，再禁用或卸载插件。PiG 自行保存的默认模型和会话引用不由本插件恢复。

## License

MIT.
