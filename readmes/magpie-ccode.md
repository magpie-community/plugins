# magpie-ccode

把 [CCode](https://ccode.si)（`api.ccode.si` 聚合网关）接入 [magpie](https://usemagpie.ai) 的供应商插件。

- **Plan 覆盖**：free（$10/月）/ Starter（$1 买 $5）/ Pro（$10 买 $70），同一份 API key，登录即用。
- **模型**：GLM 5.3 / GLM 5.3 Flash / Kimi K3.1 Pro / DeepSeek V4.1 Flash / Qwen 4 Max / Qwen 3.8 Max（全部 1M 上下文），目录运行时拉取（`GET /v1/models`），拉不到时回落到内置静态表。
- **计量**：美元口径的三档额度窗口（5 小时池 / 周池 / 月池，`GET /v1/limits`）+ 付费 plan 的 credits 余额（`GET /v1/key`），显示在 magpie 的账号用量里。

## 安装

在 magpie 的插件设置里以 GitHub 源安装：

```
aqiu817/magpie-ccode
```

## 登录

1. 在 [app.ccode.si/keys](https://app.ccode.si/keys) 创建 API key。
2. magpie 里对 CCode 供应商点登录，粘贴 key。

## 工作方式

- chat 请求走 OpenAI 兼容的 `/v1/chat/completions`（magpie 网关自动转换），插件在每只请求上补 `x-ccode-client: ccode/1.12.2` 客户端标识头与自定义 User-Agent。
- 免费额度：CCode free plan 每月 $10（5 小时 $2 / 周 $5），并发 4、30 RPM。额度按模型官方价扣（GLM 5.3 Flash 最省，约 5.6K 次/月；DeepSeek V4.1 Flash 约 23K 次/月）。

## 已知边界（请读）

- **free plan 的外部调用是弱门兼容**：CCode 文档写明 free plan "仅在官方应用内使用"；实测服务端只校验 `x-ccode-client` 客户端标识头（版本号不校验、大小写不敏感）。本插件带上该头即可从外部调用，但这与文档口径存在出入——官方随时可能收紧校验。届时 free key 的请求会收到 `403 plan_required`，插件会把它翻译成友好提示（升级 Starter/Pro 或回官方应用），不会重试打爆额度。
- `-free` 后缀的孪生模型（目录里与正名同价）被有意过滤：外部调用同样消耗月池且上游会额外注入系统 prompt，没有收益。
- 不支持服务端工具（web search 等，上游 400 `unsupported_feature`）；magpie 的工具都是客户端 function tool，不受影响。
- 429 / 503 / 529 按 `Retry-After` 退避；目录刷新 60s 一次，限流时退避到 `Retry-After`。

## 开发

```bash
npm test        # node --test test/
```

单测 22 个，fixture 取自 2026-11-28 free key 真机响应实录。

## License

MIT
