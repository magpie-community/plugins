# MuseWork Plus

把 [MuseWork](https://museai.im) 接入 Magpie，支持客户端函数调用、流式文本与推理、图片输入、模型目录、积分额度和每日签到。基于 [baijiu666/magpie-MuseWork](https://github.com/baijiu666/magpie-MuseWork) 改进，沿用 MIT 许可证。

## 安装

在 Magpie 打开「插件 → 发现 → 非官方插件 → GitHub」，搜索 `magpie-musework-plus`，核对仓库所有者为 `3294798852`。也可固定版本安装。

```bash
magpie plugin add github:3294798852/magpie-musework-plus#v0.2.0
magpie plugin login musework
```

供应商 ID 仍是 `musework`。已经登录原版的用户可以复用已有账号。如果同时安装两个插件，在「已安装」内选本插件服务 MuseWork。

| 登录方式 | 所需条件 |
| --- | --- |
| 从本机 MuseWork 客户端导入 | 桌面端已登录，多账号按次导入 |
| 浏览器登录 | Chromium 浏览器和可正常登录的 MuseWork 网页账号 |
| 粘贴 Access Token | 有效的访问令牌或客户端导出的登录 JSON |

Magpie 将登录态保存在 `~/.config/magpie/plugin-auth.json`。插件的设备 ID 存在同目录的 `musework-device.json`。本机导入从 `~/.musa/` 读取登录态。

## 工具调用

在 Magpie 网关选择 `musework/deepseek-v4-1-flash` 或 `musework/gpt-6-luna`，按标准 Chat Completions 协议传入 `tools`。插件从 MuseWork 的正文解析本轮调用，返回 OpenAI 形状的 `tool_calls`。客户端执行对应函数，并在下一轮带上调用 ID 和工具结果。

- 支持 `auto`、`none`、`required`、指定函数和 `parallel_tool_calls`，支持 SSE 与 JSON。
- 参数定义随提示发送给模型。约束解码 `strict: true`、自定义 grammar 工具和旧版 `functions/function_call` 会返回参数错误。
- 工具回合取决于模型遵循输出格式。使用客户端工具的模型仍可访问其 MuseWork 账号上的云端上下文。客户端按自身的参数校验和授权规则执行函数。

## 模型与额度

已登录时读取账号可用模型和思考档位。Free 账号通常提供 DeepSeek V4.1 Flash 与 GPT-6 Luna。额度窗口合计每日和奖励积分，日额度在北京时间 00:00 重置。

插件每轮新建独立会话并在结束时清理。相同账号的并发遵守其套餐额度，账号间独立调度。

## 开发与验证

```bash
npm test
bun test
node --expose-gc scripts/benchmark.mjs .
MUSEWORK_TEST_URL=http://127.0.0.1:3425 node scripts/smoke-tools.mjs
```

工具验证使用已授权的 Magpie 网关，并消耗少量 MuseWork 积分。网关要求密钥时通过 `MUSEWORK_TEST_KEY` 提供。

[改造方案与验收记录](docs/DEVELOPMENT.md) · [上游协议](docs/REQUEST-CHAINS.md) · [模型归因方法](docs/MODEL-FINGERPRINT.md)
