## 中文说明

在 Magpie 窗口里管理一个 **iPhone 桌面组件**：扫一次码，手机上就能看到 Codex、MiniMax、GLM 各家套餐的剩余额度和真实 Token 用量。

插件自己把服务跑起来，自己找到 Tailscale 尾网地址，手机扫一次码就配对好了。装它不需要运行安装脚本、装 Node.js、建计划任务或手工开端口转发。

```sh
magpie plugin add @magpie-community/page-token-widget
```

和社区里已列的用量页面不同：**数字落在另一台设备上**。usage、page-usage-board、page-usage-tree 把用量画在跑 magpie 的那台机器的窗口里；这个页把各家订阅的额度窗口本身（5 小时与每周的剩余比例、重置时间）送到 iPhone 桌面，额度不是按模型摊开的 token。

点一下手机上的组件，Safari 会打开手机版的用量页：各家订阅的额度、今日 Token、近七日趋势，以及按模型、厂商、Agent 和电脑排的榜。数字和电脑上看到的一样。这一页只在手机这一侧提供，页里不带任何密钥——令牌只在地址栏的 `#token=` 一段里出现一下，页面读完就抹掉，Scriptable 自己把令牌存在钥匙串里。

**控制台永远留在本机**：它只听 `127.0.0.1`，尾网里的设备够不到它，伪造 `Host` 头也没有用（见下面的「安全边界」）。

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
  last seven days and the ranking per provider.
- The plugin page chooses which subscriptions the medium and the large widget
  show, and it can drag them into the order you want. The phone and the widgets
  follow that order.
- The plugin page also chooses what the **small** widget shows: the quota that
  is left or the quota that is used, and which subscription the small widget
  follows. A widget parameter may still override both, for that one widget.
- The service only reads the local API of Magpie. It opens on this computer
  only, the phone comes in through the forwarding of Tailscale, and the token
  stays in the directory of Magpie.

## Requirements

- Magpie on the desktop (the plugin host is Bun). Version **0.1.3681** or newer.
- Tailscale, with the computer and the iPhone in the same tailnet. **Only the
  default way of connecting needs it** — see "Three ways to connect" below for
  a server of your own and for a plain LAN.
- [Scriptable](https://scriptable.app/) on the iPhone.

## Install

```sh
magpie plugin add @magpie-community/page-token-widget
```

Then open the page of the plugin in Magpie: it shows the QR code and the state
of the tailnet. The phone pairs by scanning that code (see "Pair").

### Configure

The plugin takes two options, both set in the settings of Magpie:

| Option | Default | What it is for |
|---|---|---|
| `port` | `3498` | The port the service listens on. The phone side is one port above it (`3499`). Change it when the port is taken. |
| `gatewayURL` | `http://127.0.0.1:3425` | The Magpie gateway this plugin reads. It **has to be on this computer** (`127.0.0.1`, `::1` or `localhost`): anything else is refused with a reason, and the plugin does not send its requests there. |

```sh
magpie plugin options @magpie-community/page-token-widget '{"port":8890}'
```

Restart Magpie afterwards. The port that is given to the phone changes with it,
so the phone has to be told the new address once (run `scriptable/SetupUsageWidget.js`
in Scriptable again); the token of the phone stays valid and it does not have to
pair again.

Two more options exist for the unusual cases: `phonePort` (the port of the phone
side, when it cannot be the port above the service port) and `tailnetAddress`
(the address the listener of the tailnet binds, when the tailnet address of this
computer is not the one to use).

## Pair

1. Open the page of this plugin in Magpie.
2. The page shows the state of Tailscale. When the computer and the iPhone
   share a tailnet, it shows the tailnet address and a code to scan.
3. Scan the code with the camera of the iPhone, open the page in Safari and
   download the widget script.
4. Open the downloaded `UsageWidget.js` in the Files app and choose
   "Share → Open with Scriptable".
5. Long press the home screen, add the Scriptable widget and pick `UsageWidget`.

The pairing code works once and lives ten minutes. The script carries only that
one-time code; on its first run it exchanges the code for a token of its own and
keeps it in the keychain of Scriptable. To pair without the camera, copy the
read-only token and the service address from the plugin page into
`scriptable/SetupUsageWidget.js` and run that in Scriptable.

A phone that cannot be paired any more can say goodbye on its own: the widget
tries to swap its token for the current one first, and when the service says the
token is no good, it drops the token, forgets the pairing and writes "令牌无效，
请重新配对".

## Device management

The plugin page lists the phones that paired with it. Every phone has a token of
its own; the page shows the name and the last visit, never the token.

- **Rename** changes the name of the row.
- **Revoke** stops the token of that phone: the widget of that phone says the
  token is no good, the phone can be paired again, and the row stays as a record.
- **Delete** takes a revoked row off the list for good. A phone that still uses
  its token has to be revoked first — the console says so instead of throwing
  the row away while the phone is still walking around with it.

The hash of a phone's token is what is written down, so the file of the plugin
cannot be read back into a token. The token of the console itself stays in the
state file of the service on this computer, where only this user can read it.

## Three ways to connect

### One, the default: Tailscale

The plugin finds the tailnet address of this computer and builds a forwarding of
Tailscale for it (`tailscale serve --tcp`), so the phone reaches the service on
the 100.x address. Nothing has to be set up by hand, and a forwarding of another
service on that port is never touched.

The forwarding points at the **phone side** of the service (by default one port
above the service port, so 3499), while the console stays on 127.0.0.1:3498.

The three ways a tailnet connects are the direct route (both devices on the same
network), a peer relay through another device of the tailnet, and DERP through
the servers of Tailscale. Which one is used depends on the network; none of
them is a promise that the connection works.

### Two, an address of your own

If this computer is not in the tailnet of the phone, the phone can come in
through an address of your own: an HTTPS domain with a reverse proxy in front of
it, or a server of your own.

- Over **HTTPS** any name is accepted.
- Over **plain HTTP** only a network of the user is accepted: RFC1918
  (192.168/10/172.16), the range of Tailscale (100.64/10), IPv6 ULA and ::1, and
  names of a local network (`.local`, a single name).
- A **public plain HTTP address is refused**, on the phone's installer and on
  the service: the token would travel in the open.
- A **path prefix is refused**: use a domain of its own and point its root at
  the plugin, not `https://my-server/widget`.
- The proxy has to pass the `Host` header on, and it may end the HTTPS itself
  and speak plain HTTP to the service. The `X-Forwarded-Proto` and
  `X-Forwarded-Host` headers are never believed.

### Three, a direct way over the LAN

Without Tailscale, on one LAN only: the phone side opens a door on an address of
this computer and the phone comes in over the LAN.

- Only the **phone side** opens a door; the console stays on this computer
  (127.0.0.1) for good, and the phone API carries no console.
- Press "the phone comes in here" behind a network card in the "Network" part,
  or write the address yourself (`http://192.168.1.50:3499`) and pick one of the
  addresses of this computer.
- The iPhone asks for the "local network" permission — allow it; the firewall of
  Windows has to let the door through once.
- The address of the LAN moves when the router hands out a new one, and then the
  phone cannot find the service; go back to the console and pick it again.
- That road is plain HTTP, and the token travels inside it.

**How to shut it down for good**: press **"restore the Tailscale default"** in the
"Network" part. That action empties the address you wrote, empties the network
settings that were written down, **really closes the door of the LAN** (it is
not only a change of the settings), and builds the Tailscale forward again.

## The security boundary

Who may do what is decided by **the listener that took the connection**, not by
a header the client can write.

- **The console listens on 127.0.0.1 only.** No other machine, no other network
  card, no device of the tailnet reaches it; the console page carries the token
  of the service, and only this computer can open it.
- **The phone side** (the listener of the tailnet, the door of the LAN, the
  connections that come through the forward) answers the phone and nothing else:
  the page of the phone, the pairing, the numbers. **There is no console on the
  phone side**: the console routes answer 403 there, and neither the page nor
  the script of the console is there.
- `Host`, `Origin`, `X-Forwarded-Proto` and `X-Forwarded-Host` are things a
  client can write, so the plugin does not take them for a pass. `Host` only
  stops an address that was written down wrong: the console knows `127.0.0.1` /
  `localhost` and nothing else, and a forwarded header is never believed.
- So a forged `Host: 127.0.0.1:3498` in the tailnet is of no use: that
  connection lands on the phone side and gets the page of the phone, not the
  console.
- The forward of Tailscale points at the **port of the phone side**; the console
  stays on this computer.
- The tokens of the phones are kept as hashes; the device management shows the
  name and the last visit, never the token itself. The token of the console
  itself stays in the state file of the service on this computer (0600, readable
  by this user alone), and the page that carries it is served on 127.0.0.1 only.

Tests keep these lines (in `test/boundary.test.mjs`): the forged Host, the
access across the listeners, the console routes from the wrong side, the token
that does not leak, and the pairing that still works.

## The page on the phone

Tapping the widget on the home screen opens a page in Safari: the quotas of
every subscription, today's tokens, the last seven days and the rankings by
model, provider, agent and computer. It shows the same numbers as the plugin
page.

That page is served on the phone side of the service only, so it never carries
a secret. The token travels in the address of the phone as `#token=…` and the
page drops it from the address as soon as it has read it; Scriptable keeps the
token in its own keychain. The console of the computer stays on the loopback
address and is never reachable from the tailnet.

The page remembers the token on the phone for a month, so opening it again does
not ask for it every time. The **断开** button in the corner wipes it.

## Widget parameter

The parameter is optional now: the plugin page chooses the quota and the
subscription of the small widget, and the parameter overrides that for one
widget only.

| Size | Shows | Widget Parameter |
|---|---|---|
| Small | one quota, the reset countdown, today's tokens | empty (the plugin page decides); `codex`, `minimax`, `glm`, or one account written `codex@<account>`; `\|used` shows what is used |
| Medium | up to 6 per page; today's tokens | empty; `page=2` for the second page |
| Large | up to 6 per page; two columns with the quota, the reset and the second window; today's and the last seven days | empty; `page=2` for the second page |

## When something does not work

| What you see | What it means | What to do |
|---|---|---|
| The page of the plugin is empty or the buttons do nothing | The page was opened in an old version, or the plugin was not reloaded | Reload the plugin in Magpie (the page of the plugin is served by the service, so the service has to be running) |
| The phone cannot open the pairing page | The phone is not in the tailnet, or the address of the tailnet moved | Look at the "Network" part of the plugin page: it writes the address the phone has to use |
| The widget says "令牌无效，请重新配对" | The token of this phone was revoked, or the phone was deleted | Pair the phone again: run `scriptable/SetupUsageWidget.js` in Scriptable with the address and the token of the plugin page |
| The widget says "连不上服务" | The service is not running, or the phone cannot reach the address | Check that Magpie runs, and that the phone is in the tailnet (or on the LAN the door was opened on) |
| The numbers are old | The gateway did not answer, so the last reading is kept and marked as old | The next reading replaces it; the "Data update" part of the plugin page says what happened |
| The service refuses an address of your own | Plain HTTP to a public address, a path prefix, a user name in the address, or a port that cannot be | Use HTTPS with a domain of its own, and point its root at the phone port |
| The console answers 403 in the browser | The console only answers this computer | Open it on the computer of the service: `http://127.0.0.1:3498/` |

## Lifetime

The service runs as long as Magpie runs. With Magpie closed, the phone keeps the
last result it received and updates when Magpie is back. That is the trade of
being a plugin instead of a task that stays in the background.

Magpie stops or reloads this plugin, the plugin goes through its own cleanup: it
closes the listeners it opened and takes away the forwarding it built. A process
that is killed cannot do that; see "Uninstall".

## Port

The service listens on 3498, the phone side on 3499.

The plugin publishes the port in the tailnet with a forwarding of Tailscale
(`tailscale serve --tcp`), so the phone reaches it on the 100.x address. A
forwarding of another service on that port is never touched.

`tailscale serve --bg --tcp=3498` is a standing setting of Tailscale: it stays
there when the plugin is removed or crashes, and only a clean uninstall takes
it away. `tailscale serve status` shows what is published right now; to take a
forwarding away by hand:

```sh
tailscale serve --tcp=3498 off
```

## Uninstall

```sh
magpie plugin rm @magpie-community/page-token-widget
```

The forwarding of the plugin is taken away with it — when the plugin is stopped
or removed, and only when the forwarding still points where the plugin left it.
A forwarding of somebody else is never touched.

A process that was killed (a crash, a power cut) cannot clean up after itself;
then the forwarding of Tailscale stays behind. It is a setting of Tailscale, it
outlives the plugin, and it is taken away by hand:

```sh
tailscale serve --tcp=3498 off
```

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
node scripts/run-tests.mjs
```

The tests never touch the real Tailscale, the real gateway or the real home
directory of this computer.

`lib/collector.mjs` and `lib/normalize.mjs` come from
[ScriptableTokenWidgets](https://github.com/liuzq1103/ScriptableTokenWidgets),
`lib/vendor/qrcode-generator.cjs` is
[qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator). See
[NOTICE](NOTICE) and [LICENSE](LICENSE).

## Changelog

See [CHANGELOG.md](CHANGELOG.md).
