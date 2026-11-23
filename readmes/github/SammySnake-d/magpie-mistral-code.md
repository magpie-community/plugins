# Mistral Vibe Code for magpie / OpenCode

> 把你的 **Mistral Vibe Code 订阅**接进 [magpie](https://github.com/yetone/magpie) 与 OpenCode，让 Claude Code、Codex、OpenCode 等 agent 直接消耗订阅的**月度 Vibe 预算**，而不是按 API 列表价烧平台额度。

非官方插件，与 Mistral AI 无隶属关系。Provider id：`mistral-vibe`。

---

## 为什么需要它

同一个 Mistral 账号下有两本账，**用哪一本取决于 key 的出身，不取决于模型**：

| key 的来源 | `whoami` 身份 | 调用 `api.mistral.ai/v1` 扣哪本账 |
| --- | --- | --- |
| **本插件浏览器登录铸出**（官方 CLI 同款流程） | `CHAT / INDIVIDUAL` | ✅ 套餐的 **Monthly Vibe Code 预算** |
| 在 console 的 `api-keys` 页面手工创建 | `API / FREE` | ❌ La Plateforme 的 **API 额度**（按列表价） |

实测对照（同账号、同模型 `deepseek-v4-1-flash-1017`、同一条 `Reply with exactly: OK`）：

```
浏览器铸出的 key ：vibe 0.0000150% → 0.0000167%     api 不变
console 创建的 key：vibe 不变                        api 0.017989% → 0.018139%
```

所以本插件做的事只有一件：**复刻官方 CLI 的浏览器登录流程**（`POST console.mistral.ai/api/vibe/sign-in` → PKCE → 轮询 → `POST /api/vibe/sign-in/{id}/exchange`，响应体直接是 `api_key`），拿到绑定订阅身份的 key，再把 agent 的请求转发到 `https://api.mistral.ai/v1`。

## 安装

```powershell
magpie plugin add github:hxquan-q/magpie-mistral-code
magpie plugin login mistral-vibe          # 浏览器登录；窗口别关，链接出现后立刻点
```

装完在 agent 里挑 `mistral-vibe/<模型>` 即可。

## 登录：只走浏览器

- `magpie plugin login mistral-vibe`（或 GUI 里「添加账号」）→ 生成 `console.mistral.ai/codestral/cli/authenticate?...` 链接
- 链接 **10 分钟有效**；登录完成后 magpie 自动交换出 key，无需其他操作
- ⚠️ **不要**改成粘贴 console `api-keys` 页面的平台 key —— 那会把用量记到 API 额度上（见上表）

登录后可核对身份：

```powershell
curl -H "Authorization: Bearer <key>" https://console.mistral.ai/api/vibe/whoami
# 期望 plan_type=CHAT, plan_name=INDIVIDUAL
```

## 额度展示

provider 行展示套餐与两本账，单位美元：

```
Monthly Vibe Code       0.00005 / 300 USD   ↻ Dec 1
Platform API credits    0.005487 / 30 USD   ↻ Dec 1
plan: INDIVIDUAL
```

`Platform API credits` 是 `aside` 只读窗口：只展示，不参与 magpie 的路由限额判定。

命令行核对：

```powershell
magpie quota mistral-vibe --json
```

对应上游端点：

| 用途 | 端点 |
| --- | --- |
| 套餐名 / PAYG 状态 | `GET api.mistral.ai/v1/billing/subscription` |
| 两本预算与重置时间 | `GET api.mistral.ai/v1/billing/budget` |
| 账号身份与权益 | `GET console.mistral.ai/api/vibe/whoami` |

## 模型

模型表来自 `GET /v1/models`（共 62 个，含 Codestral / Mistral / Ministral / GLM / DeepSeek 系列），上下文长度取接口的 `max_context_length`，名称与输出上限优先取 models.dev，价格用插件内置的官方定价表做估算。TTS、OCR、embedding 这类不产出文本的模型不会进入聊天模型列表。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `MISTRAL_VIBE_API_BASE` | 覆盖 LLM 基址（默认 `https://api.mistral.ai/v1`） |
| `MISTRAL_VIBE_CONSOLE_API` | 覆盖 console API 基址（默认 `https://console.mistral.ai/api`） |
| `MISTRAL_VIBE_UA` | 覆盖出站 User-Agent（默认 `mistral-client-python/Mistral-Vibe/3.1.3`） |

## 请求适配（为什么能直连）

agent 回传历史时会带 `reasoning_content` / `reasoning` / `reasoning_details`，而 Mistral 对未知字段返回 `422 Extra inputs are not permitted`。插件把这些思考内容改写成 Mistral 的 typed content part（thinking 块）放到该轮文本之前，因此带思考轮的会话不会中断。

出站请求的 `User-Agent` 与官方客户端一致：`mistral-client-python/Mistral-Vibe/3.1.3`（对应 Vibe Desktop 1.2.0 内置的 `mistral_vibe-3.1.3`）。

## 排错

| 现象 | 处理 |
| --- | --- |
| `sign-in could not start (429)` | 登录发起端点有频率限制，停 15–30 分钟后**只试一次**，不要连点 |
| `context deadline exceeded` / poll 429 | 链接 10 分钟内没点，重新 `magpie plugin login mistral-vibe` |
| 界面显示「暂无额度数据」 | GUI 缓存，重开设置页或重启 magpie 窗口 |
| 扣的是 API 额度 | 用的是 console 平台 key，删掉该账号后用浏览器登录重铸 |
| 模型列表为空 | 未登录成功；先 `magpie plugin list --json` 看 `signedIn` |

## 关于风控

个人自用（单账号、单 key、交互式使用）在应用层与官方 CLI 一致：端点、鉴权方式、请求体语义、模型 id、User-Agent 全部对齐。建议避免：

- 高并发/批量化调用（套餐有 fair-use 条款，先兆通常是限速而非封禁）
- 在同一订阅上轮换多个 key（会被看作 key farming）
- 频繁重复登录（登录端点有频率统计）

## 致谢

上游：[songlairui/magpie-mistral-code](https://github.com/songlairui/magpie-mistral-code)。本 fork 的两处改动：额度按美元展示、出站 UA 对齐官方客户端。

## License

MIT，见 [LICENSE](LICENSE)。Mistral、Vibe 等名称与商标归 Mistral AI 所有。
