# DimAgent

Read DimAgent's allowances in magpie's Usage page and menu bar through
the official [`dim usage --json`](https://dimagent.cn/docs/cli) command.
Shows plan Credits, separate add-on buckets, reported token windows and
Web Search allowance. The interface name is **DimAgent**; the provider ID
used in CLI commands remains `dimagent-usage`. The icon is DimAgent's
[official favicon](https://dimagent.cn/favicon.png).

This is an unofficial, quota-only plugin. It registers **no models** and
rejects model requests locally. `auth.usage` and keyless connection are
magpie extensions; this package is intended for magpie, not OpenCode's UI.

## Install and connect

Install the official DimAgent CLI and sign in with `dim auth login` first.
Check that `dim usage --json` succeeds. Then:

```sh
magpie plugin add @magpie-community/opencode-dimagent-usage-auth
magpie plugin login dimagent-usage
```

The plugin finds `dim` automatically and connects without a path prompt.
If it cannot find the executable, it asks for the absolute path printed
by `command -v dim`. No API key is requested. In the app,
open **Plugins → DimAgent → Sign in** and choose the local CLI method.
Select **DimAgent** under **Settings → Allowances in the menu bar**.
Web Search is a supplementary window; select it in the menu bar's window
picker if desired. magpie's Used/Left setting controls the percentages.

For an unpublished local checkout:

```sh
magpie plugin add ./packages/dimagent-usage
magpie plugin login dimagent-usage
```

The CLI path is saved as an absolute path. Common user installation
directories and mise shims are also searched when the desktop's PATH is
shorter than the terminal's. Currently tested on macOS; the process-group
timeout implementation also targets Linux. Windows is not validated.

## Data and credentials

- The only vendor operation is executing `dim usage --json`. The plugin
  does not call a private API, query models, perform sign-in or refresh
  tokens itself. The official CLI manages its own login and any renewal.
- magpie's `plugin-auth.json` stores a non-secret `local-cli-only` marker,
  the executable path and account ID. No DimAgent token or cookie is read,
  copied or saved by the plugin. magpie may retain normalized allowance
  readings in its usual quota cache.
- Each refresh verifies the CLI still uses the connected account. After
  switching DimAgent accounts, reconnect the plugin. Only one local
  account is connected at a time.
- CLI output is bounded to 512 KiB and 15 seconds. On macOS/Linux, timeout
  kills the process group, including a wrapper's child. Failed reads
  return an error, never a fabricated zero. Raw CLI output is not logged.
- Subscription and add-on denominators stay separate. Credit expiry is
  reported as `runsOutAt`. When the current subscription term explicitly
  identifies the credit bucket and matches its expiry, its end is also
  the chart's deadline (`resetsAt`). The billing term is not supplied as
  an allowance-window duration. Like Cursor's credit pools, the curve
  starts at magpie's first reading in the current cycle. This does not
  enable or promise automatic renewal. Expiry alone, including an
  add-on's expiry, never invents a cycle.
- Web Search uses only its own reported period start; missing starts
  are not borrowed from the billing term or guessed as 30 days. Token
  windows retain their own duration and reset time, as MiniMax's quota
  windows do. Curves use magpie's standard renderer and contain only
  collected readings; earlier usage and future consumption are not
  fabricated. Unknown/malformed counts are errors; expired buckets are
  omitted.
- Unlimited Credits show “Unlimited” without a percentage. Any reported
  token limits remain separate windows.

## Development and checks

No runtime dependencies. From this package, use its pinned mise runtime:

```sh
mise trust
mise run test                  # offline fixtures and fake CLI processes
mise run check                 # opt-in: reads the real local account
```

From the repository root:

```sh
mise exec -- bun scripts/check.mjs dimagent-usage
mise run test-dimagent
```

`scripts/read.mjs` accepts an optional absolute CLI path and masks the
account ID in its output. The committed fixture is the relevant subset
of a real `dimcode` 0.5.21 reply read on 2026-11-02, with account and bucket
IDs anonymized. Add-on and token-window cases are synthetic boundary
tests; the observed account had neither. Tests never query a real account.

## 中文

这是独立的 **DimAgent** 额度插件，只通过官方 `dim usage --json`
读取当前账户，不提供模型、不转发请求，也不导入 DimAgent 登录凭据。

先在终端确认 DimAgent 已登录，再添加插件并连接。插件会先自动查找 `dim`，
只有找不到时才询问 `command -v dim` 给出的绝对路径。连接后，在“设置 → 菜单栏显示额度”
里勾选 **DimAgent**；搜索额度可在窗口选择器中另外勾选。

界面显示名为 **DimAgent**，使用官方图标。插件目录和命令中的 ID 仍为
`dimagent-usage`；npm 包按社区规范命名为
`@magpie-community/opencode-dimagent-usage-auth`。社区维护者合并后由仓库
发布流程发布，未发布前可从本地目录安装。

额度折线图复用 Cursor、MiniMax 使用的原生图表。Credits 从当前周期首次采集
额度的时刻画到截止日，不把套餐购买日当作采样起点，也不生成未来预测。
搜索和 Token 限额只采用各自明确返回的额度窗口；加购包独立计算。

## License

MIT, as in the repository's LICENSE.
