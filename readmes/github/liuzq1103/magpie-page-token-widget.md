# magpie-page-token-widget

把 iPhone 桌面的额度组件接进 Magpie：装上这个插件，扫一次码，手机上就能显示 Codex、MiniMax、GLM 各家套餐的剩余额度与真实 Token 用量。

装这个插件不需要再跑安装脚本、装 Node.js、建计划任务或开 Tailscale 端口转发。插件自己把服务跑起来，自己找到尾网地址，手机扫一次码就配对好了。

> 数据来自你自己的 Magpie，脚本里不含任何密钥。组件显示的仍是 Magpie 的口径。

![插件页面](docs/console.png)

## 它做什么

- 插件页给出一个二维码。用 iPhone 的相机扫一下，Safari 打开配对页，下载组件脚本，用 Scriptable 打开它，长按桌面加组件就行了。
- 组件里显示每家订阅的剩余额度、5 小时与周额度窗口的百分比、重置倒计时、今日 Token、七日趋势和各家排行。参数可以选订阅（`codex`、`minimax`、`glm`，或 `codex@账号名`），也可以把百分比换成已用（`|used`）。
- 插件页还能改中号和大号组件里显示哪些订阅，能看到 Tailscale 的状态和同一尾网里的 iPhone。
  - 勾一个厂商＝这个厂商的所有账号都显示；只勾一个账号＝只有这个账号。勾选框显示的就是手机上会出现的卡片。
- 服务只读 Magpie 的本地接口，只在本机打开，手机经 Tailscale 的端口转发进来，令牌存放在 Magpie 自己的目录里。

## 需要什么

- Magpie（桌面版，插件宿主是 Bun）。
- Tailscale：电脑和 iPhone 都在同一个尾网里，插件靠它找到地址。
- iPhone 上的 [Scriptable](https://scriptable.app/)。

## 安装

在 Magpie 里打开插件页，或者用命令行：

```bash
magpie plugin add magpie-page-token-widget
```

从源码装：

```bash
magpie plugin add ./magpie-page-token-widget
```

## 配对

1. 在 Magpie 里打开「插件 → iPhone 额度组件」。
2. 插件页会显示 Tailscale 的状态。电脑和 iPhone 都在同一个尾网里时，这里会显示尾网地址和一张二维码。
3. iPhone 用相机扫码，在 Safari 里打开配对页，点「下载组件脚本」。
4. 在「文件」App 里打开刚下载的 `UsageWidget.js`，选「共享 → 用 Scriptable 打开」。
5. 长按 iPhone 桌面空白处，添加 Scriptable 小组件，选择 `UsageWidget`。

配对码只能用一次。手机装好组件后码就失效了；再生成一个就能装第二台。脚本里只有一个一次性配对码，第一次运行时换成自己的令牌，存进 Scriptable 的钥匙串。

不想扫码也行：插件页上有「只读令牌」，把它和「服务地址」填进 `scriptable/SetupUsageWidget.js`（在 Scriptable 里新建一个脚本粘贴运行）也行。

## 组件参数

| 尺寸 | 内容 | Widget Parameter |
|---|---|---|
| 小号 | 单家额度、重置倒计时、今日 Token | `codex`（默认）、`minimax`、`glm`；某账号写作 `codex@账号名`；加 `|used` 改显已用 |
| 中号 | 每页最多 6 个；1–4 个并排，5–6 个两行三列；今日 Token | 留空；`page=2` 查看第二页 |
| 大号 | 每页最多 6 个；两列卡片，显示主额度、重置时间及第二窗口百分比；今日与近七日 Token | 留空；`page=2` 查看第二页 |

## 生命周期

组件随 Magpie 运行。关掉 Magpie 之后，手机上显示的是最后一次拿到的结果，重新打开 Magpie 就会更新。这和原来那个用计划任务常驻的服务不同，是"插件"这个形态的取舍。

## 端口

服务默认听 8790。端口上冲突时换一个：

```bash
magpie plugin options magpie-page-token-widget '{"port":8890}'
```

改完要重启 Magpie。插件会在尾网里给这个端口建一条转发（`tailscale serve --tcp`），手机从 100.x 地址连进来；端口上已经有别人的转发时，插件不会动它。

## 卸载

```bash
magpie plugin rm magpie-page-token-widget
```

插件被移除时，它建的转发会一并撤掉。

## 隐私

- 服务只读 Magpie 的本地接口（`127.0.0.1:3425`），不写 Magpie 的配置，不碰登录信息。
- 令牌是本机随机生成的，只读，存在 Magpie 的配置目录里；只有本机的插件页和拿着配对码的手机能拿到。
- 服务只在本机（127.0.0.1）上监听，手机是经 Tailscale 的转发进来的，没有公网入口，也不需要防火墙规则。

## 开发

```bash
node --test test/service.test.mjs
```

`lib/collector.mjs` 和 `lib/normalize.mjs` 来自 [ScriptableTokenWidgets](https://github.com/liuzq1103/ScriptableTokenWidgets)，`lib/vendor/qrcode-generator.cjs` 是 [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator)。详见 [NOTICE](NOTICE)。

---

# magpie-page-token-widget (English)

An iPhone home screen widget for Magpie, brought in as a plugin: install the plugin, scan a code, and the widget shows the remaining quota and the real token usage of Codex, MiniMax and GLM.

Installing it needs no install script, no Node.js, no scheduled task and no Tailscale port forwarding. The plugin runs the service itself, finds the tailnet address itself, and the phone pairs by scanning a code once.

## Requirements

- Magpie on the desktop (the plugin host is Bun).
- Tailscale, with the computer and the iPhone in the same tailnet.
- [Scriptable](https://scriptable.app/) on the iPhone.

## Install

```bash
magpie plugin add magpie-page-token-widget
```

From a checkout: `magpie plugin add ./magpie-page-token-widget`.

## Pair

1. Open the plugin page in Magpie.
2. The page shows the state of Tailscale. When the computer and the iPhone share a tailnet it shows the tailnet address and a code to scan.
3. Scan the code with the camera of the iPhone, open the page in Safari and download the widget script.
4. Open the downloaded `UsageWidget.js` in the Files app and choose "Share → Open with Scriptable".
5. Long press the home screen, add the Scriptable widget and pick `UsageWidget`.

The pairing code works once. The script carries only that one-time code; on its first run it exchanges the code for a token of its own and keeps it in the keychain of Scriptable.

## Widget parameter

| Size | Shows | Widget Parameter |
|---|---|---|
| Small | one quota, the reset countdown, today's tokens | `codex` (default), `minimax`, `glm`; one account is written `codex@<account>`; `\|used` shows what is used |
| Medium | up to 6 per page; today's tokens | empty; `page=2` for the second page |
| Large | up to 6 per page; two columns with the quota, the reset and the second window; today's and the last seven days | empty; `page=2` for the second page |

## Lifetime

The service runs as long as Magpie runs. With Magpie closed, the phone keeps the last result it received.

## Port

The service listens on 8790 by default. Pick another one when the port is taken:

```bash
magpie plugin options magpie-page-token-widget '{"port":8890}'
```

Restart Magpie afterwards. The plugin publishes the port in the tailnet with a forwarding of Tailscale (`tailscale serve --tcp`), so the phone reaches it on the 100.x address. A forwarding of another service on that port is never touched.

## Uninstall

```bash
magpie plugin rm magpie-page-token-widget
```

The forwarding of the plugin is taken away with it.

## Privacy

The service only reads the local API of Magpie (`127.0.0.1:3425`). The token is random, read only and stays in the directory of Magpie. The service listens on this computer only (127.0.0.1); the phone comes in through the forwarding of Tailscale. There is no public entrance and no firewall rule is needed.

## Development

```bash
node --test test/service.test.mjs
```
