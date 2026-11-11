# magpie-qiniu-plugin

Magpie (OpenCode-compatible) provider plugin for [Qiniu](https://qiniu.com) AI API gateway (七牛 AI 推理服务).

## What it does

Signs in to Qiniu's AI API with an API key and lists the models available to the account. All requests go through the OpenAI-compatible Chat Completions endpoint (`/v1/chat/completions`); magpie's gateway converts Anthropic Messages and Responses API requests to that format, so Claude Code, Codex, OpenAI SDK, and other agents can all use it.

## Endpoints

| API | Base URL | Path |
|-----|----------|------|
| OpenAI-compatible | `https://api.qnaigc.com/v1` | `/chat/completions` |
| Anthropic-compatible | `https://api.qnaigc.com` | `/v1/messages` |

The plugin uses the OpenAI-compatible endpoint. Magpie's gateway handles protocol conversion from Anthropic/Responses to Chat Completions automatically.

## Install

```sh
git clone https://github.com/tk103331/magpie-qiniu-plugin.git
magpie plugin add ./magpie-qiniu-plugin   # from folder
# or
magpie plugin add magpie-qiniu-plugin     # from npm (after publishing)
```

## Sign in

```sh
magpie plugin login qiniu
```

Enter your Qiniu API key (starts with `sk-`).

## Use

```sh
magpie provider test qiniu                 # test connectivity
magpie quota                               # check usage
```

Models are referenced as `qiniu/<model-id>`, e.g.:

- `qiniu/deepseek/deepseek-v3.1`
- `qiniu/qwen3-coder-480b-a35b-instruct`
- `qiniu/kimi-k2`

## Where sign-in is kept

The API key is stored in `~/.config/magpie/plugin-auth.json` (mode 600), the same format OpenCode uses.

## License

MIT
