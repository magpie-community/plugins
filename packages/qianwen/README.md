# Qianwen (千问 App)

OpenCode / magpie provider plugin for the **Qianwen consumer app** (`Qianwen.app`,
bundle id `com.alibaba.tongyi`, web service `qianwen.com`) and its membership
subscription. Provider id: `qianwen`. Unofficial.

Models are used as `qianwen/<model>` (for example `qianwen/Qwen`,
`qianwen/tongyi-qwen37-max-model`).

## How it differs from the other Alibaba entries

This signs in to a **different channel** from the already-listed QwenWork and
Qoder packages. It is not a duplicate of either:

| | This package (`qianwen`) | QwenWork (`qwenwork`, in `opencode-qoder-auth`) |
|---|---|---|
| App | Qianwen consumer app (`Qianwen.app`, `com.alibaba.tongyi`) | QwenWork desktop (`QwenWorkCN.app`) |
| Web service | `chat2.qianwen.com` / `qianwen.com` | `gateway.qwenwork.cn` |
| Signing | Baxia reverse-engineered locally: register for a `sacsft` token pool, then HMAC-SHA256 the request entirely in code | COSY-style signing against the QwenWork gateway |
| Browser | None — pure HTTP, no browser or DOM | Per its own package |

Qoder / Qoder CN (`qoder.com`, `qoder.cn`) is a separate vendor service again.
In short: the already-listed entries cover QwenWork and Qoder; this one covers
the ordinary Qianwen **App** membership, which neither of them signs in to.

## How it works

1. Reads the desktop sign-in cookies saved by Qianwen.app (decrypted with the
   macOS Keychain entry `Qianwen Safe Storage`). No credentials are copied
   into the plugin directory.
2. Calls `sec.qianwen.com/security/external/access/register` to exchange the
   sign-in for a pool of Baxia tokens (`sacsft`, 100 at a time).
3. Each request consumes one token and computes the `clt-acs-*` signing
   headers locally with HMAC-SHA256:

   ```
   bodyKey  = sacsft + ":" + timestamp
   bodyHmac = HMAC-SHA256(body, bodyKey)
   signText = deviceId + version + kp + queryParams + bodyHmac
   sign     = HMAC-SHA256(signText, bodyKey)
   ```

4. POSTs `chat2.qianwen.com/api/v2/chat` and parses its streaming response,
   wrapping it as OpenAI Chat Completions for the agent.
5. Caches the token pool at `~/.config/magpie/qianwen/baxia-Default.json` so a
   restart reuses it instead of re-registering.

Multi-turn context is kept with the server's `parent_req_id`: each turn's
request id becomes the next turn's parent.

## Sign in

```sh
magpie plugin login qianwen
```

Then sign in to Qianwen.app on this Mac. `authorize()` reads the desktop
session; nothing is typed into the plugin.

## Risk control

Heavy or rapid testing can trip Alibaba's risk control
(`FAIL_SYS_USER_VALIDATE`, `RGV587_ERROR`). The plugin detects these, backs
off once, then reports the error honestly. Completing a verification in the
Qianwen web app clears it.

## Notes

- macOS only (reads the Qianwen.app Chromium cookie store via Keychain).
- Depends on an active Qianwen App membership; no API key is used.
- Models are discovered live from `chat2-api.qianwen.com/api/v1/model/list`.
