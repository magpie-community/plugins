## 中文说明

在 Magpie 窗口里管理一个 **iPhone 桌面组件**：扫一次码，手机上就能看到 Codex、MiniMax、GLM 各家套餐的剩余额度和真实 Token 用量。

插件自己把服务跑起来，自己找到 Tailscale 尾网地址，手机扫一次码就配对好了。装它不需要运行安装脚本、装 Node.js、建计划任务或手工开端口转发。

```sh
magpie plugin add @magpie-community/page-token-widget
```

和社区里已列的用量页面不同：**数字落在另一台设备上**。usage、page-usage-board、page-usage-tree 把用量画在跑 magpie 的那台机器的窗口里；这个页把各家订阅的额度窗口本身（5 小时与每周的剩余比例、重置时间）送到 iPhone 桌面，额度不是按模型摊开的 token。手机通过 Tailscale 尾网连进本机服务。

# @magpie-community/page-token-widget

## English

A page in Magpie's window that puts a **quota widget on the home screen of your
iPhone**: scan one code, and the phone shows the remaining quota and the real
token usage of Codex, MiniMax and GLM.

The plugin runs the service itself, finds the tailnet address itself, and the
phone pairs by scanning a code once. Installing it needs no install script, no
Node.js, no scheduled task and no manual port forwarding.

```sh
magpie plugin add @magpie-community/page-token-widget
```

## What it does

- The plugin page shows a QR code. The camera of the iPhone opens the pairing
  page in Safari, the widget script is downloaded, Scriptable opens it, and the
  widget goes on the home screen.
- The widget shows the remaining quota of every subscription, the percentage and
  the reset countdown of the 5-hour and the weekly window, today's tokens, the
  last seven days and the ranking per provider. A widget parameter picks the
  subscription (`codex`, `minimax`, `glm`, or `codex@<account>`) and turns the
  percentage into what is used (`|used`).
- The plugin page chooses which subscriptions the medium and the large widget
  show, and shows the state of Tailscale and the iPhones in the same tailnet.
  A checked vendor means every account of that vendor, a checked account means
  that account alone. The checkboxes are the cards the phone will show.
- The service only reads the local API of Magpie. It opens on this computer
  only, the phone comes in through the forwarding of Tailscale, and the token
  stays in the directory of Magpie.

## Requirements

- Magpie on the desktop (the plugin host is Bun). Version **0.1.3681** or newer.
- Tailscale, with the computer and the iPhone in the same tailnet. The plugin
  finds the address through it.
- [Scriptable](https://scriptable.app/) on the iPhone.

## Pair

1. Open the page of this plugin in Magpie.
2. The page shows the state of Tailscale. When the computer and the iPhone
   share a tailnet, it shows the tailnet address and a code to scan.
3. Scan the code with the camera of the iPhone, open the page in Safari and
   download the widget script.
4. Open the downloaded `UsageWidget.js` in the Files app and choose
   "Share → Open with Scriptable".
5. Long press the home screen, add the Scriptable widget and pick `UsageWidget`.

The pairing code works once. The script carries only that one-time code; on its
first run it exchanges the code for a token of its own and keeps it in the
keychain of Scriptable. To pair without the camera, copy the read-only token
and the service address from the plugin page into `scriptable/SetupUsageWidget.js`
and run that in Scriptable.

## Widget parameter

| Size | Shows | Widget Parameter |
|---|---|---|
| Small | one quota, the reset countdown, today's tokens | `codex` (default), `minimax`, `glm`; one account is written `codex@<account>`; `\|used` shows what is used |
| Medium | up to 6 per page; today's tokens | empty; `page=2` for the second page |
| Large | up to 6 per page; two columns with the quota, the reset and the second window; today's and the last seven days | empty; `page=2` for the second page |

## Lifetime

The service runs as long as Magpie runs. With Magpie closed, the phone keeps the
last result it received and updates when Magpie is back. That is the trade of
being a plugin instead of a task that stays in the background.

## Port

The service listens on 3498. Pick another one when the port is taken:

```sh
magpie plugin options @magpie-community/page-token-widget '{"port":8890}'
```

Restart Magpie afterwards. The plugin publishes the port in the tailnet with a
forwarding of Tailscale (`tailscale serve --tcp`), so the phone reaches it on
the 100.x address. A forwarding of another service on that port is never
touched.

The forwarding points at the phone side of the service (by default one port
above the service port, so 3499), while the console stays on
127.0.0.1:3498. A request that comes in through the tailnet lands on that
phone port and is never taken for a request of this computer, so the phone
cannot read the console or the token.

`tailscale serve --bg --tcp=3498` is a standing setting of Tailscale: it stays
there when the plugin is removed or crashes, and only a clean uninstall takes
it away. `tailscale serve status` shows what is published right now.

## Uninstall

```sh
magpie plugin rm @magpie-community/page-token-widget
```

The forwarding of the plugin is taken away with it.

## Privacy

- The service only reads the local API of Magpie (`127.0.0.1:3425`). It writes
  no configuration of Magpie and touches no login.
- The token is random, read only and stays in the directory of Magpie. Only the
  plugin page on this computer and a phone that holds the pairing code can get
  it.
- The console listens on this computer only (127.0.0.1). The phone comes in
  through the forwarding of Tailscale, which lands on the phone side of the
  service; every console route answers 403 there, so a device in the tailnet
  cannot read the console or the token whatever it puts in the Host header.
  There is no public entrance and no firewall rule is needed.

## How it differs from the pages that are listed

- **[usage](https://github.com/magpie-community/plugins/tree/main/packages/usage)**
  and **[page-usage-board](https://github.com/magpie-community/plugins/tree/main/packages/page-usage-board)**
  read the usage of Magpie and draw it inside the window of Magpie. This page
  puts the numbers on **another device**: the home screen of an iPhone, with the
  quota of every subscription and its reset countdown, and it reaches the phone
  over Tailscale.
- **[page-model-quota](https://github.com/magpie-community/plugins/tree/main/packages/page-model-quota)**
  turns a quota window into tokens **per model** by the share each model had in
  the window. This page keeps the quota of the **subscription** as Magpie
  reports it: the remaining percentage of the 5-hour and the weekly window, the
  reset time, and today's tokens next to it.
- **[page-usage-tree](https://github.com/magpie-community/plugins/tree/main/packages/page-usage-tree)**
  adds the account layer to the usage of Magpie inside the window. This page
  reads the quota and the usage of the accounts you sign in, and gives it to the
  phone.

## Tests

```sh
node --test test/*.test.mjs
```

`lib/collector.mjs` and `lib/normalize.mjs` come from
[ScriptableTokenWidgets](https://github.com/liuzq1103/ScriptableTokenWidgets),
`lib/vendor/qrcode-generator.cjs` is
[qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator). See
[NOTICE](NOTICE) and [LICENSE](LICENSE).
