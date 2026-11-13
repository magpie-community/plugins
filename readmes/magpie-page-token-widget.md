# magpie-page-token-widget

把 iPhone 桌面的额度组件接进 Magpie：装上这个插件，扫一次码，手机上就能显示 Codex、MiniMax、GLM 各家套餐的剩余额度与真实 Token 用量。

装这个插件不需要再跑安装脚本、装 Node.js、建计划任务或开 Tailscale 端口转发。插件自己把服务跑起来，自己找到尾网地址，手机扫一次码就配对好了。

> 数据来自你自己的 Magpie，脚本里不含任何密钥。组件显示的仍是 Magpie 的口径。

插件页长这样：上面是扫码配对，下面依次是状态、数据更新、网络连接、设备管理、显示哪些订阅、高级设置。

## 它做什么

- 插件页给出一个二维码。用 iPhone 的相机扫一下，Safari 打开配对页，下载组件脚本，用 Scriptable 打开它，长按桌面加组件就行了。
- 组件里显示每家订阅的剩余额度、5 小时与周额度窗口的百分比、重置倒计时、今日 Token、七日趋势和各家排行。参数可以选订阅（`codex`、`minimax`、`glm`，或 `codex@账号名`），也可以把百分比换成已用（`|used`）。
- 插件页是一个配置中心，分五块：**订阅展示**（勾选手机上要出现的卡片）、**数据更新**（多久读一次）、**网络连接**（尾网状态、连接路径、本机网卡）、**设备管理**（已配对的手机，可单独撤销）、**高级设置**（端口、网关等少改的参数）。
- 点一下手机上的组件，Safari 会打开手机版用量页：每家订阅的剩余额度、今日与近七日的 Token、模型／厂商／客户端排行，和电脑上看到的是同一份数据。
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

配对码只能用一次，而且只活十分钟：十分钟之后它自己就废了，重新生成一个就行；用掉之后旧码立刻作废。每配一台手机，它都会拿到属于自己的那枚只读令牌，服务端只留这枚令牌的哈希，明文只在配对的那一次出现，之后再也拿不出来。

猜配对码是没有便宜的：同一个配对码连续猜错十次就锁五分钟，锁的是这个码本身，不是那台机器。原因是转发过来的手机在服务器看来都是本机的回环地址，按地址锁的话，尾网上任何一个人猜错十次就能把所有人的配对都关上。请求头里的 `X-Forwarded-For` 谁都能写，服务器不看它。

服务还有一本总账：五分钟里猜错一百次（不管猜的是哪个码），配对页、组件脚本和配对接口一起先关上，等五分钟满了自动恢复。电脑上点一次「重新生成配对码」会把总账清空，手动马上就能再配。真正让配对码难猜的不是这两道门，而是它有九十六位随机数、只活十分钟、只能用一次。

手机脚本把令牌存在 Scriptable 的钥匙串里，同一台 iPhone 上的三个组件共用这一枚令牌。

不想扫码也行：插件页的「设备管理」里可以给某台手机单独发一枚令牌，把它和「服务地址」填进 `scriptable/SetupUsageWidget.js`（在 Scriptable 里新建一个脚本粘贴运行）也行。

### 旧手机怎么办

升级到 0.2 之后，0.1 时代配好的手机**不会失效**：老版本那枚共享令牌会被迁成一个名叫「旧版共享令牌」的设备授权，手机照常用它读数。只有在「设备管理」里把这一条撤销，0.1 时代的手机才会一起失效。新配的手机拿到的都是自己的令牌，和别人无关，撤销哪一台就只停哪一台。

## 设备管理

「设备管理」里列出所有配过的设备：名字、什么时候配的、最后一次是什么时候、什么时候撤销的。每一条都能改名字，都能单独撤销；撤销一台手机，别的手机照常读数。想加一台新手机，点「给这台手机一个令牌」，把生成的那枚明文令牌填进手机即可（只显示这一次）。

## 数据更新

服务不会每个手机请求都去读一遍 Magpie。它拿着一份快照，快照一分钟内是新鲜的，直接给；过期了才去读，而且所有同时来的请求共用同一次读取。

读的时候最多等两三秒：读回来了就立刻给新的；还没回来就先给旧的，标成「旧数据」，后台继续读。

平时多久读一次可以选：

| 策略 | 说明 |
|---|---|
| 智能更新（默认） | 有人看的时候每分钟一次；十分钟没人看改成五分钟一次；半小时没人看就基本不自己读了，等有人来再说 |
| 每分钟 | 固定每分钟读一次 |
| 每两分钟 | 固定每两分钟读一次 |
| 每五分钟 | 固定每五分钟读一次 |

在插件页改一下就立刻生效，不用重启 Magpie。

## 网络连接

「网络连接」里能看到：Tailscale 装没装、连上没有、本机的尾网地址、MagicDNS 名字、同一尾网里的 iPhone，以及现在这通连接走的是哪条路。

连接分三种，看的时候别混：

- **直连（Direct）**：Tailscale 在两台机器之间直接加密通信，通常是同一个局域网里自动找到对方地址之后走这条路，最快。
- **经由尾网中继设备（Peer Relay）**：两台机器之间没有直连路径，借了尾网里第三台设备转发。
- **经由 Tailscale 中继服务器（DERP）**：连不上也没有中继设备时，流量走 Tailscale 自己的中继服务器兜底，最慢但最稳。

读不出来的时候显示「还不知道」，不猜。「诊断连接」按钮会真的 ping 一次那台手机，把结果写出来；平时不会自己 ping，省得一直起 Tailscale 子进程。

本机的网卡也在这一块里列着：网卡名、IPv4、IPv6、子网前缀、是 Tailscale 网卡还是 Wi-Fi／有线／虚拟网卡。**这些地址只给电脑上的你看，手机接口拿不到。** 列出它们是为了排障：手机连不上的时候，先看看这台电脑在局域网里的地址，再看尾网地址是不是变了。

**默认仍然走 Tailscale**，不会因为这台电脑有个 192.168.x.x 就让手机改走局域网直连。原因是：局域网直连要处理明文 HTTP（或另配 HTTPS）、DHCP 换地址、iOS 的本地网络权限等等一串事情，做不好就是新的安全口子；而且尾网地址在手机和电脑上都是稳的。局域网直连这次没有实现，只做了地址发现。

## 手机上的用量页

点一下桌面上的组件，Safari 会打开手机版的用量页：每家订阅的剩余额度、今日与近七日的 Token、模型／厂商／客户端排行，和电脑上看到的是同一份数据。

页面用组件里的那个只读令牌打开，令牌只走地址栏的 `#token=` 一段，页面打开后立刻把它抹掉，之后由 Scriptable 自己记着。手机版页面只在尾网这一侧提供，电脑上的控制台仍然只在本机。

## 组件参数

| 尺寸 | 内容 | Widget Parameter |
|---|---|---|
| 小号 | 单家额度、重置倒计时、今日 Token | `codex`（默认）、`minimax`、`glm`；某账号写作 `codex@账号名`；加 `|used` 改显已用 |
| 中号 | 每页最多 6 个；1–4 个并排，5–6 个两行三列；今日 Token | 留空；`page=2` 查看第二页 |
| 大号 | 每页最多 6 个；两列卡片，显示主额度、重置时间及第二窗口百分比；今日与近七日 Token | 留空；`page=2` 查看第二页 |

## 生命周期

组件随 Magpie 运行。关掉 Magpie 之后，手机上显示的是最后一次拿到的结果，重新打开 Magpie 就会更新。这和原来那个用计划任务常驻的服务不同，是"插件"这个形态的取舍。

## 端口

服务默认听 8790，手机那一侧是 8791。端口上冲突时换一个：

```bash
magpie plugin options magpie-page-token-widget '{"port":8890}'
```

改完要重启 Magpie。插件会在尾网里给这个端口建一条转发（`tailscale serve --tcp`），手机从 100.x 地址连进来；端口上已经有别人的转发时，插件不会动它。

转发指向的是手机那一侧的端口（默认比服务端口大 1，即 8791），控制台留在 127.0.0.1:8790。尾网里的请求落在这条转发上，不会被当成本机的请求，所以手机看不到控制台，也拿不到令牌。

插件会把自己建的转发记在配置文件里（端口和指向哪里）。重启之后它认得自己的转发，不会重复建；老版本留下的转发会被搬到手机那一侧；别人的转发它既不碰也不删。只有插件正常卸载、并且那条转发仍然指向它记下的地方时，它才会把转发撤掉。

`tailscale serve --bg --tcp=8790` 是 Tailscale 里的长期设置：它留在那儿，插件被移除或崩溃都不会自己消失。想知道现在有哪些转发，看 `tailscale serve status`。

## 兼容性

- 需要 Magpie `0.1.3681` 以上（`package.json` 里写着）。
- 额度读的是 Magpie 已经缓存好的那份（`/v1/magpie/quotas?kept=1`），不额外去问供应商。
- 今天的 Token 读 `/v1/magpie/usage?period=today`，一次请求就拿到总数、分时、各厂商和各账号。**老版本 Magpie 没有这个接口时会自动退回老办法**（`/v1/magpie/usage/requests?period=today` 加逐账号的请求），组件上的数字照常有。
- 七日趋势和模型／厂商排行读 `/v1/magpie/usage/requests?period=7d&limit=1`：这个接口才带 `by.model`、`by.agent` 这些分组，换成别的接口会把排行和趋势丢掉，所以保留。
- 周期参数 `week` 在 Magpie 里不认（会被当成 30 天），七日要用 `7d`。

## 卸载

```bash
magpie plugin rm magpie-page-token-widget
```

插件被移除时，它建的转发会一并撤掉。

## 隐私

- 服务只读 Magpie 的本地接口（`127.0.0.1:3425`），不写 Magpie 的配置，不碰登录信息。
- 令牌是本机随机生成的，只读，存在 Magpie 的配置目录里；服务端只留哈希。只有本机的插件页和拿着配对码的手机能拿到。
- 局域网地址只出现在电脑上的控制台里，手机接口不提供。
- 服务只在本机（127.0.0.1）上监听，手机是经 Tailscale 的转发进来的，没有公网入口，也不需要防火墙规则。

## 开发

```bash
npm test
```

测试里不会碰真的 Tailscale：所有和 Tailscale 命令打交道的测试都用一个自己的假命令（`test/helpers.mjs` 里的 `mockTailscale`），也不会去改真的 `tailscale serve` 设置。Magpie 网关同样是测试自己起的一个。

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

The pairing code works once and lives ten minutes at most: after that it is dead, and a new one replaces it at once. Every phone that pairs gets a read-only token of its own. The service keeps only the hash of that token; the plain text is handed over exactly once, at the moment of pairing, and never again.

Guessing a code is not cheap: ten wrong tries at one code lock that code for five minutes. The lock follows the code, not the machine — behind the Tailscale forward every phone arrives as the loopback of this computer, so a lock per address would let anybody on the tailnet shut the pairing of everybody else. An `X-Forwarded-For` header can be written by anybody, so it is not believed.

The service keeps one budget for the whole of it: a hundred wrong tries in five minutes, whichever code they were aimed at, and the pairing page, the widget script and the pairing door all close until the five minutes are up. Asking for a new pairing code at the computer empties that budget at once, so a person can open the door again without waiting. What really makes a code hard to guess is neither of those two doors: it has ninety-six bits of randomness, it lives ten minutes and it opens the door once.

The script keeps the token in the keychain of Scriptable, and the three widgets of one iPhone share it.

Without the code you can also use "Device management": give a phone a token of its own and put it, with the service address, into `scriptable/SetupUsageWidget.js`.

### The phones of the older version

Updating to 0.2 does not lock out the phones that were paired with 0.1: the shared token of the old version is migrated into a device named "旧版共享令牌" and those phones keep reading with it. Only revoking that entry stops them. Every new phone gets a token of its own, and revoking one phone stops that phone alone.

## Device management

The list holds every device that was paired: its name, when it was paired, when it was last seen and when it was revoked. Every entry can be renamed and revoked on its own. To add a phone, press "give this phone a token" and put the token that appears once into the phone.

## Data update

The service does not read Magpie for every request of the phone. It keeps a snapshot that is good for a minute: a fresh snapshot is given right away, an old one triggers a reading, and all the requests that come at that moment share that one reading.

A reader waits at most a few seconds: it gets the new numbers when they arrive, and the old ones marked as old when they do not, while the reading continues in the background.

How often the service reads on its own:

| Strategy | What it does |
|---|---|
| Smart (the default) | every minute while somebody is looking, every five minutes after ten quiet minutes, and almost never after half an hour of quiet |
| Every minute | a fixed rhythm |
| Every two minutes | a fixed rhythm |
| Every five minutes | a fixed rhythm |

Changing it in the plugin page takes effect at once; Magpie does not have to be restarted.

## Network

The page shows whether Tailscale is installed and connected, the address of this computer in the tailnet, the MagicDNS name, the iPhones of the tailnet and the way the connection is made. Three ways are told apart:

- **Direct**: Tailscale talks to the phone itself, encrypted end to end; on one LAN it usually finds the other side on its own, and that is the fastest way.
- **Peer relay**: there is no direct path, so another device of the tailnet carries the traffic.
- **DERP**: Tailscale's own relay server carries the traffic; the slowest way, but it always works.

When the way cannot be read, the page says so instead of guessing. The button "diagnose" pings the phone once and writes down the answer; the service never pings on its own.

The network cards of this computer are listed as well: name, IPv4, IPv6, the length of the network part, and whether the card is Tailscale, Wi-Fi, wired or virtual. **These addresses are for the computer only; the phone API never gets them.** They are there to help: when the phone cannot be reached, look at the address of this computer in the LAN and at the address of the tailnet.

**Tailscale stays the default way in.** The phone does not go around the tailnet just because this computer has a 192.168.x.x: a direct way over the LAN would have to deal with plain HTTP (or with HTTPS of its own), with addresses that move when the router hands out new ones, and with the local network permission of iOS. That is a new hole to look after, and the tailnet address is stable on both sides. The direct way over the LAN is not implemented in this release; only the addresses are discovered.

## The page on the phone

Tapping the widget opens the usage page on the phone: the remaining quota of every subscription, today's tokens, the last seven days and the rankings by model, vendor and client, the same numbers the computer shows.

The page opens with the read-only token of the widget. The token travels in the `#token=` part of the address and is wiped from there as soon as the page is open; Scriptable keeps it from then on. The page is served on the tailnet side only, the console of the computer stays on this computer.

## Widget parameter

| Size | Shows | Widget Parameter |
|---|---|---|
| Small | one quota, the reset countdown, today's tokens | `codex` (default), `minimax`, `glm`; one account is written `codex@<account>`; `\|used` shows what is used |
| Medium | up to 6 per page; today's tokens | empty; `page=2` for the second page |
| Large | up to 6 per page; two columns with the quota, the reset and the second window; today's and the last seven days | empty; `page=2` for the second page |

## Lifetime

The service runs as long as Magpie runs. With Magpie closed, the phone keeps the last result it received.

## Port

The service listens on 8790 by default, the phone side on 8791. Pick another one when the port is taken:

```bash
magpie plugin options magpie-page-token-widget '{"port":8890}'
```

Restart Magpie afterwards. The plugin publishes the port in the tailnet with a forwarding of Tailscale (`tailscale serve --tcp`), so the phone reaches it on the 100.x address. A forwarding of another service on that port is never touched.

The forwarding points at the phone side of the service (by default one port above the service port, so 8791), while the console stays on 127.0.0.1:8790. A request that comes in through the tailnet lands on that phone port and is never taken for a request of this computer, so the phone cannot read the console or the token.

The plugin writes down the forwarding it made (the port and where it points) in its own file. After a restart it recognizes it and does not make it twice; a forwarding of an older version is moved to the phone side; the forwarding of somebody else is neither touched nor removed. It is taken away only when the plugin is uninstalled properly and the forwarding still points where it was written down.

`tailscale serve --bg --tcp=8790` is a standing setting of Tailscale: it stays there when the plugin is removed or crashes. `tailscale serve status` shows what is published right now.

## Compatibility

- Magpie `0.1.3681` or later is needed (`package.json` says so).
- The quota is read from the report Magpie has already cached (`/v1/magpie/quotas?kept=1`); the vendors are not asked again.
- Today's tokens come from one request to `/v1/magpie/usage?period=today`, which holds the totals, the hours, the vendors and the accounts. **When an older Magpie does not know that endpoint, the old way is used instead** (`/v1/magpie/usage/requests?period=today` plus one request per account) and the widget keeps its numbers.
- The trend of the last seven days and the rankings by model and vendor come from `/v1/magpie/usage/requests?period=7d&limit=1`: this is the only endpoint that carries the groups `by.model` and `by.agent`, and another endpoint would lose the rankings and the trend, so it stays.
- Magpie does not know the period `week` (it is taken for 30 days); seven days is `7d`.

## Uninstall

```bash
magpie plugin rm magpie-page-token-widget
```

The forwarding of the plugin is taken away with it.

## Privacy

- The service only reads the local API of Magpie (`127.0.0.1:3425`). It does not write the configuration of Magpie and does not touch the logins.
- The tokens are random, read only and stay in the directory of Magpie; the service keeps only their hashes. Only the plugin page of this computer and the phone that carries a pairing code can get one.
- The addresses of the LAN are only shown in the console of the computer; the phone API does not have them.
- The service listens on this computer only (127.0.0.1); the phone comes in through the forwarding of Tailscale. There is no public entrance and no firewall rule is needed.

## Development

```bash
npm test
```

The tests never touch the real Tailscale: everything that speaks with the command of Tailscale talks to a fake one instead (`mockTailscale` in `test/helpers.mjs`), and the real `tailscale serve` settings are never changed. The gateway of Magpie is one the tests start themselves.

`lib/collector.mjs` and `lib/normalize.mjs` come from [ScriptableTokenWidgets](https://github.com/liuzq1103/ScriptableTokenWidgets), `lib/vendor/qrcode-generator.cjs` is [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator). See [NOTICE](NOTICE).
