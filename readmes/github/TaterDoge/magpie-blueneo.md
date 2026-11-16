# magpie-blueneo

BlueNeo Cloud 的 magpie 供应商插件：把 BlueNeo 的模型接进 magpie，并显示额度、到期时间和每日签到。

## 安装

```bash
magpie plugin add opencode-blueneo-auth
magpie plugin login blueneo
magpie provider test blueneo
magpie quota blueneo
```

在应用里：插件 → 添加插件 → 填 `opencode-blueneo-auth` → 在 `blueneo` 那一行登录。

## 登录

默认问两件事：**用户名**、**密码**。不打开浏览器，也不碰验证码：

1. `POST /api/auth/login` 拿到 web 会话 JWT（登录页的 Geetest 只在前端拦，服务端不校验）；
2. 用它 `POST /api/api_key/list` 取回账号自己的 API key（优先 `default`，其次最新的）；
3. JWT 的 `exp` 存为过期时间，提前一小时用存下的密码自动重登（BlueNeo 没有 refresh 接口，重登就是续期）。

存下来的东西（`plugin-auth.json`，权限 600）：API key、JWT、**密码**（用于续期）、用户名。`magpie plugin logout blueneo` 全部清掉。

**备用方式**：`Web 会话 token（备用）` —— 填 API key + 浏览器里 `document.cookie` 的那个 JWT。账号开了两步验证（2FA）或密码登录被拒时用它。

> 为什么不能"点一下自动拿 token"：跨源读不到 BlueNeo 的 cookie，浏览器不让。BlueNeo 也没有 OAuth / 设备码。

## 模型与思考档位

模型名单只读网关 `GET /v1/models`，不内置型号，也不按 GPT、Kimi 等名称分支。新型号在宿主下次刷新模型列表时自动接入，统一开放 `none / low / medium / high / xhigh / max` 六档，并声明推理与工具调用能力。实际支持的推理强度由上游决定。

控制台目录只补显示名和上下文长度，失败不影响模型发现。网关拉取失败时保留宿主已有列表；首次加载且拉取失败时列表为空，不再用静态型号兜底。

## 显示什么

`magpie quota`（应用里在供应商的账号卡上）：

和概览页的「额度总览」对齐，三张卡 + 一个签到。窗口按 Trae 插件的写法只写 `amount` / `limit` / `unit`，数字和「已用 N%」由 magpie 自己排版，不再自己拼 `display`：

| 窗口 | 内容 | 来源 |
| --- | --- | --- |
| Tokens Plan | 已用 / 总额 Credit、下次重置、周期长度；供应商行上也显示套餐到期日 | `credit_plan/account`、`settle-switches` |
| 加量包 | 已用 / 总额（只算生效中的包）、几个生效中、最早作废那一笔的时间与金额 | `asset/my_packs`、`settle-switches` |
| 算能包 | 累计消耗 / 累计获得 | `asset/periodic_account`、`settle-switches` |
| 签到 | 连签天数（名字里）、今天签了没、累计签到额度 | `checkin/status` |

加量包和算能包在 BlueNeo 里被停用时标 `aside`，不参与路由；用户把它们启用后 `aside` 自动取消。

BlueNeo 的接口会间歇性断连或拖到几十秒（`credit_plan/account`、`my_packs` 实测都有过）。`usage` 把每个请求单独兜住、各重试一次：一个接口坏掉只少一张卡，`credit_plan/account` 彻底读不到时把原因写在额度卡上，而不是抛错让 magpie 静默保留旧快照。单次请求 20 秒超时，开关接口（`settle-switches`）只等 8 秒，读不到就当作三个来源都开着。

## 签到

`auth.checkin` 走 `GET /api/checkin/status`：

- 今天签过 → `done`，带上连签天数。
- 活动没开 / 账号不合格 → `inactive` / `ineligible`。
- **BlueNeo 要求人机验证（Geetest）→ 返回 `captcha`**，按 magpie 的约定不去解，请用户在 BlueNeo 网页上签。
- 站点关掉 Geetest 时，插件直接 `POST /api/checkin` 拿到额度，报 `claimed` 和这次的额度数。

## 接口

| 用途 | 接口 |
| --- | --- |
| 推理 | `https://llm-api.blueneo.cloud/v1`，通过 `@ai-sdk/openai` 使用 Responses API，`Authorization: Bearer <API key>` |
| 模型列表 | `GET /v1/models`；`GET /api/model/prices`（控制台）补显示名和上下文长度 |
| 额度 | `GET /api/credit_plan/account`、`POST /api/asset/my_packs` |
| 签到 | `GET /api/checkin/status`、`POST /api/checkin` |

控制台接口用 `Authorization: Bearer <web 会话 JWT>`，成败在 body 的 `code`（一律 HTTP 200）。

## 测试

```bash
bun test              # 或 node index.test.mjs，跑 _internal 上的纯函数
```

## 许可

MIT
