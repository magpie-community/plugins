# Changelog

## 0.2.0 · 2026-11-14

The code of the standalone plugin (`magpie-page-token-widget`, 0.4.4) is now in this
package, with the community's own name, port and data directory kept.

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
