# 私有化部署验证

日期：2026-10-25，Asia/Shanghai。版本：0.2.3。企业地址、账号和凭据已隐去。

| 项目 | 实测结果 |
| --- | --- |
| macOS，Magpie 0.1.1482 | 浏览器授权完成，`userJwt` 解析并通过 GetUserInfo 核验；宿主保存账号，via=sso |
| Linux，Magpie 0.1.1318 | 服务器运行 Magpie，本地浏览器认证；最终 loopback 页面无法直达，将地址回填 CLI 后登录成功，退出 0，凭据保存在服务器 |
| 模型目录 | 两端均列出 21 个可用模型 |
| 用量 | macOS 读取席位及基础／超额／内置模型四类窗口；Linux 无网页会话，读取席位窗口正常 |
| token 续期 | 使用实际 Magpie 插件宿主，将测试账号的到期元数据设为临近到期后触发续期，连续两次成功；每次新 access、refresh、到期时间及 lastRefresh 均保存到账号文件，随后用量读取成功 |
| 非流式请求 | 实际发送 stream=false；上游额度拒绝，插件返回 429，错误码保留，登录状态 kept |
| 流式请求 | 实际发送 stream=true；首个有效帧为额度错误，插件在开始输出流前返回相同 429，登录状态 kept |

## 实际协议

部署的 `GetLoginGuidance` 返回 `Result.LoginHost`。浏览器最终回调包含 `userJwt` JSON，字段为 `Token`、`RefreshToken`、`TokenExpireAt`、`RefreshExpireAt`、`TokenExpireDuration`。本次登录不使用授权码兑换，也不尝试猜测的 grant 请求体。

续期请求为 `POST /cloudide/api/v3/trae/oauth/ExchangeToken`，body 使用 `RefreshToken` 与 `ClientID`。本轮真实轮换通过宿主的刷新及持久化路径执行；未等待自然到期。

## 额度拒绝

用量读取确认基础和超额窗口均超过 100%。两端、两种请求方式均获得：

```text
HTTP 200
Content-Type: text/event-stream

event: error
data: {"code":4222,"error":"biz error: rpc error: code = ErrAllModelUserQuotaExceeded desc = , origin err = entitlement check failed","message":"","extra":null}
```

插件返回：

```text
HTTP 429
X-Magpie-Sign-In: kept
Content-Type: application/json

{"error":{"message":"TRAE 模型额度已用尽","type":"insufficient_quota","code":"ErrAllModelUserQuotaExceeded"}}
```

原实现将其折叠为 502／entitlement check failed，本轮已用同一真实请求复验修正结果。

## 成功响应与边界

成功响应的转换由离线协议用例验证：`output` 正文／推理／工具分片，`done` 结束状态与内嵌 usage，`token_usage` 统计。stream=true 转换为 OpenAI SSE，结束后输出 `[DONE]`；stream=false 或缺省时聚合为 `chat.completion`。未结束即断流及中途错误不能伪造成成功。

本轮收到的是额度拒绝，未把协议分析或离线通过写成真实成功生成。48 项隔离回归及安装包解包测试通过；Windows 本轮未实装，macOS 和 Linux 的结果不替代 Windows 验收。
