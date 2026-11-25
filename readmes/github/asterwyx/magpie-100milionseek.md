# 100milionseek

[100milionseek](https://100milionseek.top/docs) 的 Magpie Router 供应商插件。

```sh
magpie plugin add ./magpie-100milionseek
```

在 Magpie 的 Providers 中选择 `100milionseek`，输入 API Key。插件通过 `GET /v1/models` 验证 Key、读取模型列表，并从同一响应的 `x-quota-*` 头读取每日 Token 额度和重置时间。额度于 UTC 00:00 重置，无需签到。

Magpie 使用账号的 Key 把 OpenAI 兼容聊天请求（含流式请求）发往 `https://100milionseek.top/v1`。插件和供应商均使用内置的官网 favicon。

本地测试：`npm test`。
