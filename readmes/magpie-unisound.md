# magpie-unisound

把云知声 Token Hub（[maas.unisound.com](https://maas.unisound.com)）的 **U Plan** 接入 [magpie](https://usemagpie.ai) 的供应商插件。面向 U Plan（Token Plan）用户：积分口径计费、双池额度窗口、赠送池视觉模型。

> English README: [README.en.md](./README.en.md)
>
> **设计定位**：本插件目前主要为 **U Plan Free 档**用户设计——未粘贴 Session Cookie 时积分窗口按 Free 档额度（5h 突发池 500 / 周池 2500）显示；粘贴后直接显示服务端真值并自动识别档位（`planCode`），Standard / Plus 用户同样可用。已用积分按官方系数精算、与服务端对账一致。

## 功能

- **API Key 登录**：Token Plan key 一把接入（`控制台 > 订阅管理 > U Plan` 页面签发，`tp-` 前缀）
- **可选网页 Session Cookie**：登录时多填一项，`usage` 直接显示**服务端实时用量**——周池/5h 池真值与重置倒计时、6 个赠送池余量、`planCode` 档位自适应（Free/Standard/Plus 通吃）；不填则显示本地估算，Cookie 失效自动回落
- **U Plan 白名单目录**：只暴露 U Plan 覆盖的聊天模型；旗舰 `u2` 与第三方模型（DeepSeek / Kimi / GLM / Qwen…）需要按量付费，不进目录——Token Plan key 调它们会失败，按量 key 调它们是真实扣费
- **动态模型表**：运行时拉取 `GET /v1/models`（服务端按 key 类型隔离目录），limit 以目录为准；拉不到时兜底静态白名单
- **积分口径 cost**：官方积分系数表换算成「每百万 token 的积分数」，magpie 用量统计里的 cost 就是 U Plan 积分消耗
- **本地积分账本**：每次请求从响应 usage 按官方公式精算积分（`points = (input×coeff + cached×coeff + output×coeff) / 10000`），持久化到 magpie 配置目录，跨宿主进程共享
- **双池额度窗口**：未配 Cookie 时显示 5 小时突发池与 7 天周池的本地估算；配置 Cookie 后为服务端真值
- **流式记账**：自动为流式请求补 `stream_options.include_usage`，SSE 尾部 usage chunk 照样入账

## U Plan 模型（Free 档实测）

| 模型 | 类型 | 计费池 | context / output |
|---|---|---|---|
| `u2-flash` | 通用文本 | 积分（系数 1 / 0.2 / 2） | 1M / 256K |
| `u2-med` | 医疗文本 | 积分（系数 2 / 0.5 / 7，输出贵 3.5 倍） | 256K / — |
| `u2-radimed` | 医疗影像（图+文） | **独立赠送池**（47.5 万 Token/周，不耗积分） | 40K / — |

赠送池另有 `u2-asr`（8 小时/周）、`u2-tts`（4 万字/周）、`u2-ocr` / `u2-ocr-med`（各 737 万 Token/周），语音与文档接口后续以 MCP 工具形式接入。

**额度套利提示**：视觉请求路由到 `u2-radimed` 走赠送池，不消耗积分、不受 5 小时窗口限制。

## 实时用量（可选）：粘贴网页 Session Cookie

控制台的额度端点只认浏览器会话（API key 查不了），所以插件支持在登录时**多粘贴一项网页 Cookie**，让 usage 显示服务端实时数据：

1. 在 Edge/Chrome 登录 [maas.unisound.com](https://maas.unisound.com) 控制台
2. `F12` 打开 DevTools → **网络/Network** 面板 → 刷新页面
3. 在请求列表里**右键任意 `maas.unisound.com` 的请求** → 复制 → **以 cURL 格式复制（Copy as cURL）**
4. 从剪贴板内容里找到 `-b '…'` 这一段，把**引号内整串**粘进登录表单的「网页端 Session Cookie」输入框（粘 `Cookie: name=v; …` 请求头整行也可以）

粘贴后 usage 窗口变为服务端真值：周池已用/余量与**官方重置倒计时**、5h 突发池、全部赠送池（OCR / RadiMed / ASR / TTS）余量，并按 `planCode` 自动识别档位。Cookie 失效（重新登录控制台、服务端会话过期）时自动回落本地估算，并在 usage 备注里提示重新粘贴。

## 安装

在 magpie 里添加本插件（GitHub 或本地路径均可）：

```bash
magpie plugin add github:aqiu817/magpie-unisound
# 或本地目录
magpie plugin add ./magpie-unisound
```

登录（API 方式，key 只存本机）：

```bash
magpie plugin login unisound
```

模型即 `unisound/u2-flash`、`unisound/u2-med`、`unisound/u2-radimed`。

## 已知局限

- **未配 Cookie 时积分余量为本地估算**：从装插件起算，不含之前的消耗；窗口为滚动近似（官方的 5 小时窗口是「首次消耗起算重置」，滚动近似只会偏保守）。已与服务端对账：本地精算与控制台 `已用积分` 逐位一致。粘贴 Session Cookie 即切换为服务端实时用量（见上文「实时用量」）。
- **Session Cookie 会过期**：控制台重新登录、服务端会话到期都会让 Cookie 失效——表现为 usage 自动回落本地估算并提示重新粘贴。有效期未测得定值，以实际使用为准。
- **radimed 无积分 cost**：赠送池积分系数未公布，magpie 侧显示为 0 费用（token 统计不受影响；粘贴 Cookie 后赠送池余量会以真值显示）。

## 数据与隐私

- API key 只保存在 magpie 本机（`plugin login` 写入本机凭据存储），不进任何日志与上传
- **Session Cookie 同样只存本机**（凭据存储的 metadata 字段），仅用于向 `maas.unisound.com` 发起唯一的只读 GET 查询额度；不进日志、账本与任何发布物
- 积分账本写入 magpie 配置目录（`magpie-unisound-points.json`），仅含 token 数与积分值，不含消息内容

## 开发

```bash
node --test test/unisound.test.mjs   # 或 bun test
TP_KEY=tp-… bun scripts/smoke.mjs    # 真机冒烟（目录探测 + 双流验证）
```

## License

MIT
