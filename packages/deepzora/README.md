# Deepzora

Adds [Deepzora](https://github.com/SivanCola/deepzora) Desktop, CLI and ACP to
Magpie's Agents page as **Deepzora**, ID `deepzora`.

```sh
magpie plugin add @magpie-community/agent-deepzora
```

Choose a model on its Agent row, wait about a second with Magpie running, then
restart Deepzora and start a new conversation. Explicit project
`deepzora.toml` defaults, CLI `--model` flags and existing session selections
retain their precedence.

## Configuration and restoration

This package includes an Agent descriptor and a companion running in Magpie's
Bun plugin host. The generic Agent writer supports JSON/YAML/dotenv, not TOML
with a separate credential file. No Deepzora source changes, host patches,
extra daemon or upstream provider login are required. Parsing libraries are
vendored at exact versions with their licenses; installation needs no build
script or runtime dependency download.

The descriptor writes `~/.deepzora/magpie-agent.json`. The host bridges it into
`~/.deepzora/config.toml`, adding the `magpie-agent` OpenAI Chat Completions
provider and default model. The assigned gateway key goes into
`~/.deepzora/.env` as `MAGPIE_DEEPZORA_API_KEY`, never into TOML or logs.
Deepzora sends requests to Magpie; Magpie handles upstream credentials and
protocol conversion. Known context/output sizes and image support follow the
chosen model. Existing providers and unrelated settings are kept.

Choose the Agent's default to disconnect, wait for the bridge, then restart
Deepzora. Normal plugin-host exit flushes a pending disconnect, including
disabling the plugin with Magpie running. With CLI-only operation, restore
while the package is still enabled before removing it:

```sh
magpie deepzora default
magpie plugin list --json
# Remove after restoration completes:
magpie plugin rm @magpie-community/agent-deepzora
```

The one-shot fallback is `node cli.mjs sync` from this package. After a forced
host kill, re-enable the package and disconnect to finish restoration.

Private backups and a replayable transaction journal live in
`~/.deepzora/.magpie-bridge/`. They contain original credential-file contents;
keep them private and retain them if recovery pauses. Writes use private
files and atomic replacement. Untouched files restore byte for byte;
unrelated edits and Deepzora startup migrations are merged and retained.
TOML comments and formatting can change during connection and after a merged
restoration. Manual changes to managed fields pause synchronization. Existing
uses of the reserved provider or credential name are refused. Do not edit
Deepzora's model settings while switching models.

## Compatibility

Verified on macOS with unmodified Magpie 0.1.3850 and Deepzora CLI v0.0.4
against a local model fixture, including resident-host plugin disable.
The default paths target macOS/Linux with the shared global `config.toml` and
`.env`. On Windows or with custom `DEEPZORA_HOME`, install a local copy and
change the descriptor's `dir` and `config` to the same actual Deepzora data
directory. The bridge derives TOML and `.env` paths from the descriptor's
`config`; it cannot infer another process's environment. Native Windows
acceptance is not claimed.

Do not enable this package and `github:SivanCola/magpie-agent-deepzora` at the
same time: they register the same Agent and manage the same files. To switch,
restore defaults and remove the standalone package first, then install this
package and select a model again.

## Development

```sh
bun test ./packages/deepzora
bun scripts/check.mjs deepzora
MAGPIE_BIN=/path/to/magpie DEEPZORA_BIN=/path/to/deepzora node packages/deepzora/acceptance.mjs
MAGPIE_BIN=/path/to/magpie node packages/deepzora/resident-acceptance.mjs
```

Acceptance uses disposable homes and a localhost model fixture. It installs
the actual package in Magpie, verifies model selection and restoration, and
optionally checks an unchanged Deepzora CLI sends the selected model and
exact assigned credential. No saved accounts or paid inference requests are
used. See [THIRD_PARTY.md](THIRD_PARTY.md) for code and asset attribution.

## 中文

把 **Deepzora** 桌面版、CLI 和 ACP 加到 Magpie 的 Agent 页，ID 为
`deepzora`。安装后选模型，保持 Magpie 运行并等待约一秒，再重启 Deepzora、
新建会话。项目配置、CLI 参数和已有会话仍按各自优先级生效。

插件随包桥接 TOML 和独立 `.env`，保留原有供应商及无关设置，不修改原程序。
网关密钥只写入全局 `.env`，不写入 TOML 或日志。解析库已随包提供，
无需额外下载依赖。备份包含原始凭据文件，请妥善保管。

卸载前先在 Agent 页恢复默认；仅用 CLI 时先执行上面的 `default` 和
`plugin list --json` 两步。Magpie 运行期间正常关闭插件宿主会补做恢复；
强制终止后需要重新启用插件并断开。同步期间不要手工改动受管理的供应商、
默认模型或凭据。Windows 和自定义目录请先按上述说明修改路径。

从独立 GitHub 插件迁移时，先恢复默认并卸载旧插件，再安装本包、重新选模型；
两个包不能同时启用。插件代码采用 MIT 许可，图标单独采用 AGPL-3.0-only，
解析库保留 BSD 许可，详见来源说明。
