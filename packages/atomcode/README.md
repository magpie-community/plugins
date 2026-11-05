# AtomCode CodingPlan

AtomGit CodingPlan and AtomCode models in magpie and OpenCode. Provider id: `atomcode`.

支持 AtomGit 编程计划与 AtomCode 本地/远程模型中继接入，提供 5 小时滚动配额保护与动态模型发现。

## Install

```sh
magpie plugin add @magpie-community/opencode-atomcode-auth
magpie plugin login atomcode
```

## Sign In / Authentication

Enter your AtomGit token or your local AtomCode relay key (default `openclaw-atomgit-local`). The credential is saved in magpies or OpenCodes `auth.json`.

```sh
magpie plugin login atomcode
```

## Options

| Option | Environment Variable | Default | Description |
| --- | --- | --- | --- |
| `baseURL` | `ATOMCODE_API_BASE` | `http://127.0.0.1:4018/v1` | Upstream AtomCode relay base URL (`:4018` bridge or `:4017` host proxy) |
| `apiKey` | `ATOMCODE_API_KEY` / `ATOMGIT_TOKEN` | `openclaw-atomgit-local` | Auth Bearer token sent to relay / upstream API |

## Models

- `atomcode/glm5.3-flash`: GLM-5.3-Flash with 512k context window and multimodal support.
- `atomcode/qwen3.8-27b`: Qwen 3.8 27B with 262k context window.
- `atomcode/deepseek-v4-flash`: DeepSeek V4 Flash with 128k context window.

Models can also be discovered dynamically from the configured `baseURL/models` endpoint.

## Quota & 5-Hour Rate Limits

AtomGit CodingPlan enforces a 5-hour rolling request window (~200 calls/5h). The plugin tracks this in `magpie quota` and prevents abrupt lockouts.
