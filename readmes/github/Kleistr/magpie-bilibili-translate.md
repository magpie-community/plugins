# magpie-bilibili-translate

v0.1.0 · MIT · magpie 供应商插件，接入 [Index-Translate](https://github.com/bilibili/Index-Translate)（bilibili 翻译模型家族，免费公网 API，兼容 OpenAI chat completions，无需 API key）。

## 安装

```bash
magpie plugin add ./magpie-bilibili-translate
magpie plugin login index-translate    # 两个问题均可留空，使用免费公网 API
magpie provider test index-translate
```

登录可选项：

| 问题 | 留空 | 填写 |
| --- | --- | --- |
| Base URL | `https://index-translate.bilibili.com/v1` | 自建端点，如 `http://127.0.0.1:8000/v1` |
| API key | 不带鉴权头 | 以 `Authorization: Bearer <key>` 发出 |

## 模型

| 模型 | 上下文 | 说明 |
| --- | --- | --- |
| `Index-Translate-35B-A3B` | 24,576 | 文本 + 图片翻译 |
| `Index-Translate-9B` | 32,768 | 均衡文本翻译 |
| `Index-Translate-2B` | 32,768 | 轻量最快 |
| `Index-Homura-9B` / `-2B` | 32,768 | 按音节数控制译文长度（字幕/配音） |
| `Index-Nailong-9B` / `-2B` | 229,376 / 262,144 | 超长文档，术语一致 |

加载时请求一次 `<Base URL>/models` 刷新上下文长度与能力，请求失败则用内置表。`Index-Echo` 是语音管线，不在此列。

模型不支持 function calling，插件会剥离 `tools` / `tool_choice` / `response_format` 等字段再发出。

## 插件对请求做的处理

- 注入 `chat_template_kwargs.enable_thinking = false`（开着 thinking 时 CoT 会挤掉译文）
- 未指定时补 `temperature: 0`
- `User-Agent: Index-Translate-Client/1.0`
- 移除 `Origin`（浏览器 Origin 会触发 WAF）

响应（含 SSE）原样返回。

## 用法

```bash
magpie claude index-translate/Index-Translate-9B
```

提示词示例：

```text
请将以下文本翻译为英语，直接输出翻译结果，不要进行任何解释。

你好，世界。
```

## 本地部署

用 vLLM / SGLang 部署后，登录时 Base URL 填以 `/v1` 结尾的地址，key 留空即可：

```bash
vllm serve IndexTeam/Index-Translate-9B --served-model-name Index-Translate-9B --max-model-len 32768
```

## 开发

```bash
bun test
```

纯函数挂在 `_internal` 下（`prepareBody`、`fetchUpstream`、`listModels` 等），测试不需要网络。

## 许可

MIT。模型与 API 属于 bilibili（Apache-2.0）。
