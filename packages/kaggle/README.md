# Kaggle Models

Your [Kaggle](https://www.kaggle.com) account's free AI model credits (**$10/day, $100/month**) as a provider: Claude, Gemini, GPT, DeepSeek, Qwen, IBM Granite and more through Kaggle's Model Proxy (the Kaggle Benchmarks inference API).

## Sign-in

One method: **Kaggle API token** (`KGAT…`), created at [kaggle.com/settings](https://www.kaggle.com/settings) → API → "Create New Token" (the Kaggle CLI's `kaggle auth login` writes the same token to `~/.kaggle/access_token`). The account needs phone/identity verification for the Model Proxy. magpie keeps the token as the account key in its own auth store; the plugin never writes it anywhere.

## How requests are served

The Model Proxy speaks OpenAI Chat Completions at `<baseUri>/openapi/v1`, but its bearer token is short-lived (~2h). The plugin mints it in memory from the long-lived API token through the same endpoint the official `kaggle benchmarks auth` CLI uses, and renews it a couple of minutes before expiry — the proxy token is never stored and there is no manual re-login. magpie's short model ids are mapped to exact catalog slugs (`anthropic/claude-sonnet-5@default`, …), which the upstream requires. Streaming (SSE) works.

## Models

| id | upstream |
|---|---|
| `kaggle/sonnet-5` | `anthropic/claude-sonnet-5@default` |
| `kaggle/gemini-3-flash` | `google/gemini-3-flash-preview` |
| `kaggle/gemini-3.1-flash-lite` | `google/gemini-3.1-flash-lite-preview` |
| `kaggle/gpt-5.4-nano` | `openai/gpt-5.4-nano-2026-03-17` |
| `kaggle/gpt-oss-120b` | `openai/gpt-oss-120b` |
| `kaggle/granite-4h` | `ibm/granite-4.0-h-small` |
| `kaggle/deepseek-r1` | `deepseek-ai/deepseek-r1-0528` |
| `kaggle/qwen3-next-80b` | `qwen/qwen3-next-80b-a3b-instruct` |

## Usage

The `usage` hook reports the daily $10 / monthly $100 quota windows with reset times (Kaggle's quota API). The quota is shared with everything else that uses the proxy, including Kaggle Benchmarks runs on the website.
