# ZCode Keyring Auth — a magpie plugin

Wraps the official `@magpie-community/opencode-zcode-auth` plugin and adds two sign-in methods:

- **ZCode: local ZCode 3.18 keyring** — reads the OS-keyring credentials (`enc:v2:os`) of a ZCode 3.18 desktop client already signed in on this machine. The upstream "ZCode app's sign-in" only understands legacy `enc:v1` and cannot read 3.18 stores. This entry follows ZCode's sign-ins and token refreshes while the desktop app stays on the same account.
- **ZCode: import JSON token file** — imports a plain JSON token file produced by [`zcode-sync export-json`](https://github.com/netcaty/zcode-sync), for machines where **ZCode is not installed**. No browser sign-in, no keyring.

中文：包装官方 zcode 插件，新增两种登录方式 —— 读取本机 ZCode 3.18 系统钥匙串凭据（官方 app 登录只支持旧版 `enc:v1`），以及导入 [zcode-sync](https://github.com/netcaty/zcode-sync) 导出的 JSON token 文件，供未安装 ZCode 的机器使用。沿用官方插件的 API key 解析、模型列表、赠送额度与用量卡片。

## Install in magpie

This repo carries the `magpie-plugin` GitHub topic, so it should appear in magpie's Plugins → Discover. You can also install it directly:

```sh
magpie plugin add github:netcaty/magpie-zcode-keyring-auth
magpie plugin
```

Then add a ZCode account and pick one of the two new methods.

## Difference from the existing ZCode plugin

This is the **same channel** (`zcode`) as `@magpie-community/opencode-zcode-auth`, not a replacement for a different service. It exists because the official package cannot read ZCode 3.18's `enc:v2:os` credentials and has no way to sign in on a machine without ZCode:

| | official `opencode-zcode-auth` | this package |
|---|---|---|
| ZCode 3.18 keyring (`enc:v2:os`) | no (reads `enc:v1` only) | yes, via Windows Credential Manager |
| machine without ZCode | API key or browser OAuth only | JSON token import |
| local ZCode re-login / token refresh | — | followed for the keyring entry |
| models, gift plans, usage, daily claim | yes | inherited unchanged |

Only install one of the two: registering both adds two `zcode` auth hooks.

## How it works

ZCode 3.18 stores tokens plus a **key location** (`project-key-location:v1:`), not the API key itself. The new sign-in methods emit `{ site, token, jwt, loc, device }`; the upstream plugin's `located()` resolves the location into a real key on every request. No key is written into magpie's auth store by this package.

The credential-decryption modules in `lib/` are vendored from [zcode-sync](https://github.com/netcaty/zcode-sync), so the package is self-contained and does not need that checkout at runtime.

## Security

- The JSON token file is **plain text** with full access/refresh tokens. Transfer it only over trusted channels and delete it after importing. Use the encrypted `.zcs` bundle ([`zcode-sync export`](https://github.com/netcaty/zcode-sync)) when a passphrase is needed.
- The plugin only reads ZCode's own credential store; it never writes to it.
- The keyring method requires Windows (PowerShell + Windows Credential Manager). JSON token import is platform-independent.

## Development

```sh
npm install
npm test
```

`npm install` pulls the pinned upstream plugin; tests use synthetic `enc:v2:os` credentials and never print token values. The integration test checks that the package exports a plugin function in the shape magpie's loader expects, and that its auth entries are understood by upstream `stateOf()`.

This repo is public, carries the `magpie-plugin` GitHub topic, and is not a fork; magpie discovers it through `topic:magpie-plugin archived:false fork:false` and refreshes its catalog every few hours.

## License

MIT
