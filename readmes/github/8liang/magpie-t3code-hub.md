# magpie-t3code-hub

把 [Magpie](https://usemagpie.ai) 的额度数据以 CLIProxyAPI Hub 的形式提供给 T3 Code，让 T3 Code 的额度页显示 Magpie 里所有账号的用量。

## 中文说明

**用法**

1. 安装插件：`magpie plugin add /插件所在的绝对路径`，装好后在 Magpie 里打开它。插件启动后会在 `127.0.0.1:4319` 监听。
2. 取 Hub 地址和 management key：打开 Magpie **设置 → 插件 → T3 Code Hub** 面板，第一次用时点“生成 key”，然后复制地址和 key。（也可以在终端运行 `bun run token`。）
3. 在 T3 Code 中打开 **Settings → Providers → Usage providers → Add a CLIProxyAPI hub**，填入第 2 步的地址和 key。

**显示效果**

- Claude Code、Codex 账号按 T3 原生方式显示：Session、Weekly 进度条。
- Cursor、Qoder、WorkBuddy 等其他供应商，放在 Claude 组里单独一列 “Magpie”，每个账号一行 `Weekly · <供应商>`，显示用量最高的那个窗口。T3 只认 Claude、Codex 两类账号，`Weekly ·` 前缀是 T3 自己加的。
- 在 Magpie 里显示为“中间件 + 请求 Hook + 面板”，不改动任何请求。

**排查**：`bun run verify` 会按 T3 的请求顺序把 hub 跑一遍；完整文档从 [docs/index.md](docs/index.md) 开始（中文）。

## English

A Magpie gateway-middleware plugin that exposes [Magpie](https://usemagpie.ai)'s quota data as a
CLIProxyAPI-compatible usage hub for T3 Code.

```
Magpie gateway (:3425) ──GET /v1/magpie/quotas──▶ Magpie plugin host (Bun)
                                                      │
                                                      ▼
                                              T3 Code Hub (:4319)
                                                      ▲
                         GET  v0/management/auth-files │
                         POST v0/management/api-call  │
                                                      │
                                                  T3 Code
```

## Quick start

```bash
# 1. Run the tests
bun test

# 2. Run the hub without Magpie (reads the local Magpie gateway)
bun run dev

# 3. Print the management key T3 Code asks for
bun run token

# 4. Replay T3 Code's exact requests against the hub
bun run verify
```

If `bun` is not on your PATH, add it (`export PATH="$HOME/.real/.bin:$PATH"`)
or call the files directly with your Bun binary.

Then install the package as a Magpie plugin:

```bash
magpie plugin add /absolute/path/to/magpie-t3code-hub
```

In T3 Code: **Settings → Providers → Usage providers → Add a CLIProxyAPI hub**,
enter `http://127.0.0.1:4319` and the key shown in Magpie's **Settings → Plugins →
T3 Code Hub** panel (or printed by `bun run token`).

The full knowledge base starts at [docs/index.md](docs/index.md).

## Layout

| Path | Purpose |
|---|---|
| `src/hooks.ts` | Magpie entry (`magpie.hooks`, no `main`, so no Provider chip); starts the Bun HTTP listener |
| `src/hub.middleware.js` | No-op gateway middleware so Magpie lists the plugin as middleware |
| `ui/key.*` | Magpie Settings panel showing the hub address and management key (from the plugin's options) |
| `src/hub/server.ts` | CLIProxyAPI management API consumed by T3 Code |
| `src/hub/mapping.ts` | Magpie quotas → CLIProxyAPI accounts and provider-native usage |
| `src/hub/magpie.ts` | Magpie `/v1/magpie/quotas` client with a short cache |
| `src/standalone.ts` | Development/standalone entry |
| `src/cli/` | `token` and `verify` helpers |
| `tests/` | Mapping and HTTP contract tests |
| `docs/` | Architecture, protocols, operations and decisions |
| `.mcp.json` | CodeGraph MCP server configuration |

## Status

Version `0.1.0`. Read [docs/index.md](docs/index.md) for limitations: T3 Code's
CLIProxyAPI adapter only understands `codex` and `claude` accounts, so other
Magpie providers ride on a separate "Magpie" account in the Claude group, one
`Weekly · <provider>` row each. It has no email, so T3 never merges it with its
own Claude sign-in (a merge keeps only the newer copy and would drop the rows).
