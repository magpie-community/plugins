# Reasonix 1.x

Adds Reasonix 1.x Desktop and CLI to Magpie's Agents page as
**Reasonix 1.x**, ID `reasonix-desktop`. This is separate from Magpie's built-in
`reasonix` adapter for Reasonix Studio 2.x.

```sh
magpie plugin add @magpie-community/agent-reasonix-desktop
```

Choose a model on its Agent row, wait about a second with Magpie running, then
restart Reasonix and start a new conversation. Explicit project
`reasonix.toml`, CLI model flags and existing session selections retain their
own precedence.

## Configuration and restoration

The package includes an Agent descriptor plus a companion in Magpie's Bun
host, as the current generic Agent writer supports JSON/YAML/dotenv, not TOML
with a separate credential file. It works on unmodified Magpie and Reasonix;
no daemon installation, provider login, remote service or host patch is needed.
The parsing libraries are vendored at exact versions with their licenses.

The descriptor writes only `~/.reasonix/magpie-agent.json`. The host bridges
it into `~/.reasonix/config.toml`, adding the `magpie-agent` OpenAI Chat
Completions provider and its default model; the assigned gateway key goes
only into `~/.reasonix/.env` as `MAGPIE_REASONIX_DESKTOP_API_KEY`. Upstream
provider secrets remain in Magpie. Existing providers and other settings are
kept. Known context/output sizes and image support follow the chosen model.

Choose the Agent's default to disconnect, wait for the bridge, then restart
Reasonix. A normal Magpie host exit flushes a pending disconnect, including
when disabling the plugin while Magpie is running. For CLI-only operation,
finish restoration while the plugin is still enabled:

```sh
magpie reasonix-desktop default
magpie plugin list --json
# Remove only after restoration completes:
magpie plugin rm @magpie-community/agent-reasonix-desktop
```

The one-shot fallback is `node cli.mjs sync` from this package. After a forced
host kill, re-enable the plugin and disconnect to finish restoration.

Private backups and a replayable journal live in `~/.reasonix/.magpie-bridge/`.
They contain original credential-file contents; retain them if restoration
pauses. Writes use private files and atomic replacement. On disconnect,
untouched files return byte for byte; unrelated edits and Reasonix startup
migrations are merged and retained. TOML formatting/comments may change while
connected, and merged restoration cannot promise their original formatting.
Manual changes to managed fields pause synchronization rather than being
overwritten. Do not edit Reasonix model settings during a switch.

## Compatibility

Targets Reasonix 1.x with shared global `config.toml` and `.env` (v1.8.1+).
Verified with unmodified Magpie 0.1.2890 and Reasonix 1.38.10 against a local
model fixture. It does not target Studio 2.x. Disable an existing standalone
Reasonix plugin before enabling this package; both use `reasonix-desktop`.

Default paths target macOS/Linux. For Windows or a custom `REASONIX_HOME`,
install a local copy with the descriptor's `dir` and `config` changed to the
actual Reasonix home (Windows normally `%APPDATA%/reasonix`). The bridge derives
`config.toml` and `.env` from that config path; it cannot infer another
process's environment. Native Windows Reasonix acceptance is not claimed.

## Development

```sh
bun test ./packages/reasonix-desktop
bun scripts/check.mjs reasonix-desktop
MAGPIE_BIN=/path/to/magpie REASONIX_BIN=/path/to/reasonix node packages/reasonix-desktop/acceptance.mjs
MAGPIE_BIN=/path/to/magpie node packages/reasonix-desktop/resident-acceptance.mjs
```

Acceptance uses temporary config/state homes and a localhost model fixture.
It installs the actual package in Magpie, checks the Agent and selected model,
then optionally exercises an unchanged Reasonix binary and its assigned
credential. No real account, saved sign-in or paid request is used. See
[THIRD_PARTY.md](THIRD_PARTY.md) for source attribution and vendored code.

## 中文

把 **Reasonix 1.x** 桌面版和 CLI 加入 Magpie 的 Agent 页，ID 为
`reasonix-desktop`，与内置的 Reasonix Studio 2.x 分开。安装后选模型，
保持 Magpie 运行并等待约一秒，再重启 Reasonix、新建会话。

插件随包桥接 TOML 和独立 `.env`，不修改原程序、不安装额外守护进程。
原有供应商和无关设置保留，网关密钥只写入全局 `.env`。项目配置、CLI
参数及已有会话仍保留自己的优先级。备份含原始凭据文件，请妥善保管。

卸载前先选择 Agent 默认值完成恢复。仅用 CLI 时执行上面的 `default`
和 `plugin list --json` 两步，再卸载。Magpie 运行期间正常关闭插件宿主会
补做恢复；强制终止后需重新启用插件并断开。同步期间不要手工改动受管理
的供应商、默认模型和凭据。自定义目录及 Windows 请先按上述说明修改路径。
