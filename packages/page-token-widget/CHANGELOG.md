# Changelog

## 0.4.6 · 2026-11-14

The unit of a quota window is written the same way for every provider, and the
name of a card stands at the left of its card again.

> 额度的单位统一了：网关那边有的窗口叫「5 hours」、有的叫「4 hours」，组件以前一个写「5h」、
> 一个原样写「4 hours」；现在统一写「5h」「4h」「7d」。组件上的厂商名和数字回到左边——0.4.5
> 为了让卡片的高度稳当把文字居中了，这一版去掉。

### Fixed

- **The unit of a window is the same for every provider.** The gateway names
  one window "5 hours" and another one "4 hours"; the widget wrote "5h" for
  the first and "4 hours" for the second. Every hour-ish label is now
  written "<n>h" and every day-ish label "<n>d". The phone page writes the
  same window as "5 小时剩余" and "4 小时剩余".
- **The name of a card and the number under it stand at the left.** The 0.4.5
  release centred the text of a line to keep the height of every card the
  same; the text stands at the left again.

## 0.4.5 · 2026-11-14

The bars of the cards of the medium widget sit on one line now. Nothing else
changed: the paired phones, the token format, the widget parameter and the
port are the same as in 0.4.4.

> 中号组件里四张卡的额度条现在在同一条线上。没有账号的厂商（MiniMax、GLM）以前那一行写的是
> 一个不换行空格，高度由手机自己来量，于是它们的条比 Codex 那两张卡高了一截。现在每一行都有
> 自己固定的高度，四张卡的条就在同一条线上。

### Fixed

- **A card without an account of its own no longer puts its bar out of line.**
  The empty line of the account used to be a space whose height the phone
  measured by itself, so the MiniMax and GLM bars sat a little higher than the
  two cards of Codex. Every line of a card now has a height of its own.
- The large widget puts two cards in a row; the two bars of a row sit on one
  line as well. A row that mixes a card with an account and a card without one
  had the same fault (the bars were 11 points apart), and the three-row layout
  of the large widget now keeps the line of the name the same height for
  every card too.
- A test keeps it that way: the four cards of a real page are drawn and the
  line of every bar is read — 55, 55, 45, 45 before, one line now.

## 0.4.4 · 2026-11-14

The code of the standalone plugin (`magpie-page-token-widget`, 0.4.4) is now in this
package, with the community's own name, port and data directory kept.

The two versions are the same number from here on: this package follows the
version of the standalone plugin, so that the two never drift apart in the eyes
of a user. Nothing was published under 0.2.0, so the line starts here.

> 这一版把独立插件（`magpie-page-token-widget` 0.4.4）的代码同步进社区包，保留社区自己的
> 名字、端口和数据目录。最要紧的一件：谁能看控制台，由连接真正落在哪个监听器上决定，不再由
> 请求头决定——尾网上的设备即使伪造 `Host: 127.0.0.1:<端口>`，也只能拿到手机那一份页面，
> 拿不到控制台页面里的服务令牌，也碰不到 `/api/v1/console/*`。

### Fixed

- **The console of this computer is out of reach of the tailnet.** Who may ask is
  decided by the socket a request came in on, not by a header a caller can write:
  the console page (the one that carries the service token) and every
  `/api/v1/console/*` route are served only by the listener on `127.0.0.1`, and a
  request that arrives on the tailnet, the LAN or the phone listener gets the
  phone side whatever its `Host`, `Origin` or `X-Forwarded-*` say. A device in the
  tailnet that sends `Host: 127.0.0.1:<port>` gets the phone page, not the
  console. (`test/boundary.test.mjs` says so out loud.)

### Added

- The plugin's own tests (unit, integration and the boundary ones) travel with
  the package: `node scripts/run-tests.mjs`.
- `options.tailnetAddress` — the address the tailnet listener binds to. It
  exists for the tests and for the rare case of a machine with several
  addresses; the permission of a request does not depend on it.
- A changelog of its own, and a README that tells the whole story: the three
  ways to connect (Tailscale, an address of your own, the LAN), the ports, the
  security boundary, the pairing, the device list, the phone page, the widget
  parameter, the troubleshooting and the uninstall.

### Changed

- The service answers under its community name, `@magpie-community/page-token-widget`,
  and the phone page and the widget script recognise that name when the service
  says "no" — a token that no longer works is wiped and the phone is told to
  pair again.
- The port is 3498 (the phone's 3499), the data directory is `page-token-widget`,
  and the summary in the registry is the same text as `magpie.summary` in
  `package.json`.
- The plugin's entry exports the plugin and nothing else: the cleanup of the
  Tailscale forwarding moved to `lib/cleanup.mjs`.

## 0.1.1 · 2026-11-13

### Fixed

- The phone opens its own page (the page of the service on the phone's port),
  not the console.

## 0.1.0 · 2026-11-13

### Added

- The first version: a local service that reads Magpie's local gateway, a
  console page, a phone page and the Scriptable widget that shows the remaining
  quota of Codex, MiniMax and GLM on the iPhone's home screen.
