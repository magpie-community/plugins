# AtomCode CodingPlan

AtomGit CodingPlan and AtomCode models in magpie and OpenCode. Provider id: `atomcode`.

支持 AtomGit 编程计划与 AtomCode 原生纯内存 HKDF/HMAC 签名直连与本地中继接入，提供 5 小时滚动配额保护与动态模型发现。

## Features

- **Native In-Memory Request Signing**: Built-in RFC 5869 HKDF-SHA256 and HMAC-SHA256 signer matching official AtomCode binary specification (`X-AtomCode-Sig`, `X-AtomCode-Ts`, `X-AtomCode-Nonce`, `X-AtomCode-Alg`, `X-AtomCode-Ver`).
- **Zero Background Daemon Required**: Directly communicates with official upstream gateways (`https://llm-api.atomgit.com/v1`) in pure JavaScript without requiring external Python proxies or background daemons.
- **Relay Fallback**: Compatible with existing local relays (`:4018` bridge / `:4017` host proxy) for constrained environments or legacy setups.
- **Quota & Window Guard**: Tracks 5-hour rolling request windows (~200 calls/5h) in `magpie quota` to avoid unexpected rate-limit exhaustion.
- **Dynamic Model Discovery**: Auto-detects models from upstream (`glm5.3-flash`, `qwen3.8-27b`, `deepseek-v4-flash`).

## Install

```sh
magpie plugin add @magpie-community/opencode-atomcode-auth
magpie plugin login atomcode
```

## Sign In / Authentication

Enter your AtomGit token or your local AtomCode relay key (default `openclaw-atomgit-local`). The credential is saved in magpie or OpenCode `auth.json`.

```sh
magpie plugin login atomcode
```

## Options

| Option | Environment Variable | Default | Description |
| --- | --- | --- | --- |
| `direct` | `ATOMCODE_DIRECT` | `false` | When true, directly targets official AtomGit gateway with in-memory signing |
| `baseURL` | `ATOMCODE_API_BASE` | `http://127.0.0.1:4018/v1` | Upstream API base URL (or `https://llm-api.atomgit.com/v1`) |
| `apiKey` | `ATOMCODE_API_KEY` / `ATOMGIT_TOKEN` | `openclaw-atomgit-local` | Auth Bearer token sent to upstream API |

## Models

- `atomcode/glm5.3-flash`: GLM-5.3-Flash with 512k context window and multimodal support.
- `atomcode/qwen3.8-27b`: Qwen 3.8 27B with 262k context window.
- `atomcode/deepseek-v4-flash`: DeepSeek V4 Flash with 128k context window.

Models can also be discovered dynamically from the configured `baseURL/models` endpoint.
