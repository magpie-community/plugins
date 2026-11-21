# @magpie-community/opencode-wps-comate-auth

**中文** ｜ 接入本机已登录的 WPS Comate（金山办公）桌面端（Windows）：读取它已经登录的
账号，把厂商的 OpenAI 兼容接口作为 provider `wps-comate` 提供，并在 magpie 的额度卡上
显示今日、本对话与总计的智点消耗。

**English** ｜ Signs in to WPS Comate (金山办公 Comate), Kingsoft's AI office desktop app, by
reading the account that app is already signed in to on this machine, and
serves the vendor's OpenAI-compatible endpoint as provider `wps-comate`.

| | |
|---|---|
| Provider id | `wps-comate` |
| API | `https://comate.wps.cn/llmproxy/v1/user` (chat completions) |
| Platform | Windows (DPAPI and the desktop app's own files) |

The package exports `WpsComateAuthPlugin`.

## Signing in

**Desktop app's sign-in (automatic, nothing to paste).** On every request the
plugin reads the two files WPS Comate writes:

| File | What it holds |
|---|---|
| `%USERPROFILE%\.wpscomate\agent\auth\user_auth.json` | `token`: a DPAPI blob that decrypts to the `wps_sid` cookie of `comate.wps.cn` |
| `%USERPROFILE%\.wpscomate\config.json` | `providers.official.apiKey` (the device's key) and `providers.official.baseUrl` |

The blob is Windows DPAPI under the current user (`CryptUnprotectData`), so it
only opens for the Windows account Comate runs as. When Comate signs in again
and rewrites `user_auth.json`, the next request follows the new cookie.

Every request carries `Cookie: wps_sid=<the cookie>` and
`Authorization: Bearer <the device key>`. A 401 makes the plugin read the
account file once more and send the request again, so a sign-in that happened
while magpie was running is picked up without a restart.

**Paste a `wps_sid`** when the files cannot be read (Comate in another Windows
account, or not installed): DevTools → Application → Cookies →
`comate.wps.cn` → `wps_sid`. It is HttpOnly, so `document.cookie` will not
show it.

The plugin only reads the two files. It never writes them.

## Models

The account's own list from `GET /models` drives discovery; these are the ones
the endpoint serves today, all with a 1,000,000-token context:

| Model | |
|---|---|
| `610387340/deepseek/deepseek-v4-pro//public` | DeepSeek V4 Pro |
| `610387340/deepseek/deepseek-v4.1-flash//public` | DeepSeek V4.1 Flash |
| `610387340/minimax/MiniMax-M3//public` | MiniMax M3 |
| `610387340/xiaomi/mimo-v2.6-flash//public` | MiMo V2.6 Flash |
| `610387340/xiaomi/mimo-v2.6-pro//public` | MiMo V2.6 Pro |
| `610387340/zhipu/glm-5.2//public` | GLM 5.2 |
| `610387340/zhipu/glm-5.3-flash//public` | GLM 5.3 Flash |
| `610387340/zhipu/glm-5.3//public` | GLM 5.3 |

Streaming, tool calls and image input where the model lists it are passed
through as the endpoint answers them.

## Usage

The Usage card shows what this machine has spent, taken from the `usage.credits`
field every answer carries -- three lines: today's spend, this conversation's
spend (magpie names the conversation on each request), and the all-time total.
The counts are kept in `~/.magpie/wps-comate-usage.json`, so a restart keeps
them. Each line carries its figure in `display` only: a window with an `amount`
field has its unit rewritten to "credits", while a display-only line keeps the
vendor's own word, 智点.

It also asks `GET /credits` for a balance. An organisation account answers with
the vendor's verdict only, e.g.
`{"mode":"enforce","decision":"continue","wouldSkip":false}`: whether the next
request is allowed, not how much of the company's pool is left. For such an
account there is no quota line at all and the card is the three spend lines. An
account whose endpoint answers with a balance gets an extra `剩余额度` line. The
per-account figures need `tenant.v2.ai.stats`, which an employee account does
not have (`403 PERMISSION_DENIED`).

## Notes

- Windows only: the decryption is DPAPI and the files are the Windows desktop
  app's.
- Comate's tenant id is part of each model id (`610387340/...`); the plugin
  passes the ids the endpoint lists for the account, so another tenant's list
  works as it is.
- No runtime dependencies.

## Tests

```sh
bun test
```

The tests stub `fetch` and give the plugin a home of its own: no request
leaves the machine and no real sign-in file is read.
