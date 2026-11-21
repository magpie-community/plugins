# 同济 AGI for Magpie

用自己的同济大学套餐 API Key，在 [Magpie](https://usemagpie.ai/) 里使用同济 AGI 的 DeepSeek、Kimi、GLM、Qwen、MiMo 和 MiniMax 对话模型。插件会验证密钥，并显示该密钥当前可用、已适配的对话模型。

## 在 Magpie 中接入

1. 打开 **设置 → 插件 → 发现 → 非官方（GitHub）**，找到 **同济 AGI** 并点击 **安装**。也可以在 **添加插件** 中直接输入 `github:yzxoi/magpie-tongji-agi`。
2. 打开 [同济 AGI「我的 API Key」](https://agi.tongji.edu.cn/system/my-apikey)，通过学校统一身份认证登录，点击 **创建套餐 Key**，并复制完整密钥。
3. 在 Magpie 的插件或供应商界面找到 **同济 AGI**，点击 **登录**，粘贴自己的套餐 Key。然后在你使用的 Agent 中选择同济模型，如 `tongji-agi/Kimi-K3.1-Pro`。

### 终端安装

```sh
magpie plugin add github:yzxoi/magpie-tongji-agi
magpie plugin login tongji-agi
```

macOS 上如果终端找不到 `magpie`，可以把命令中的 `magpie` 替换为 `/Applications/magpie.app/Contents/MacOS/magpie`。

验证连接可以运行 `magpie provider test tongji-agi DeepSeek-V4.1-Flash`。这会发出一条短测试请求，计入个人套餐额度。

## 在其他兼容客户端中接入

选择 **OpenAI 兼容**，将 Base URL 设为 `https://agi.tongji.edu.cn/v1`，填写自己的 API Key。模型 ID 使用同济模型详情页上的值，例如 `DeepSeek-V4.1-Flash` 或 `Kimi-K3.1-Pro`。详见[校方接入智能体说明](https://agi.tongji.edu.cn/docs/agent-tools)。

## 模型和密钥

- 插件通过同济的 `GET /v1/models` 读取该密钥可用的模型，并与已适配的文本生成模型取交集。新模型能力确认后会在插件更新中添加。
- 请求通过 OpenAI Chat Completions 直连同济 AGI。密钥由本机 Magpie 保存，模型调用计入本人套餐额度。
- 校方使用统一身份认证访问网页，并通过个人 API Key 授权第三方客户端。首次设置需要在官方页面取 Key 并粘贴一次。
- 停用或轮换密钥可前往[我的 API Key](https://agi.tongji.edu.cn/system/my-apikey)。移除插件可运行 `magpie plugin rm magpie-tongji-agi`。

这是学生自制插件。校方服务说明见[同济大学信息化办公室](https://nic.tongji.edu.cn/fwzn/kyfw/rgznfwpt.htm)。
