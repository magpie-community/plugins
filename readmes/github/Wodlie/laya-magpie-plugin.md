# laya-magpie-plugin

把 [1Panel 的 laya-server](https://github.com/1Panel-dev/laya-server) 接进 [magpie](https://usemagpie.ai/docs/zh/plugins) / OpenCode 的供应商插件。

> **只适配 1Panel 的 laya-server。** 依赖的就是它自己的形状：`POST /v1/systemone`、`auto` / `multilingual` / `english` / `typed-decisions` 四个模型名、`laya_` 开头的 key、`{"detail":{"code","message"}}` 的错误体。别人 fork 改过字段或模型名的部署，不保证能用。

laya-server 只回答结构化问题（`choice` / `score` / `noul`），没有 chat 接口，所以这是一个**决策供应商**（TypeSafe System One），不是聊天模型：

- 它的模型出现在 magpie 的**分类器**里 —— 路由组的 *Intent told by* 可以选 `laya-server/auto`，由你的本地模型判定这一轮属于哪条规则。
- 任何客户端都可以经 magpie 网关打 `POST /v1/systemone`，由插件转发到你的 laya-server。
- 它**不能**在 agent 里当聊天模型用：magpie 会拒绝发给它的 chat 请求。

## 安装

```sh
magpie plugin add owner/laya-magpie-plugin   # 或 git+https://… / 本地文件夹路径
magpie plugin login laya-server              # 问 URL 与 API key
magpie provider test laya-server             # 一次最小判定请求
```

在 app 里：Plugins → Add a plugin 给仓库或文件夹，然后在 `laya-server` 那一行登录。

登录时问两件事：

| 问题 | 说明 |
| --- | --- |
| **Laya Server URL** | 形如 `http://192.168.1.20:8080`；不带协议默认 `http://`；末尾的 `/v1` 或 `/` 会自动去掉（插件自己加 `/v1`）。反向代理的子路径（`https://example.com/laya`）保留。 |
| **API key** | laya-server 控制台 **API Keys** 页创建，只显示一次，形如 `laya_…`。 |

登录会先探 `GET /health/live` 与 `/health/ready`：地址不通或模型文件缺失当场报错。**key 本身不预检** —— key 错会在第一次请求时由 laya-server 回 401，magpie 随即把账号标成需要重新登录。一个账号一个 URL，多个 laya-server 就登录多个账号。

## 在 magpie 里用

1. Settings › Routing 建一个路由组，规则加 intent，*Intent told by* 选 `laya-server/auto`。
2. 分类器问的是 `choice`（`intent`：哪一类请求；`level`：难度档）与 `score`（`effort`：思考量）问题，由 laya-server 一次判定回答；magpie 按 `probabilities` 算置信度，低于阈值就当没有匹配的 intent。
3. 网关直连：

```sh
curl -s http://127.0.0.1:3425/v1/systemone \
  -H 'Content-Type: application/json' \
  -d '{"model":"laya-server/auto",
       "state":{"message":"I was charged twice"},
       "questions":{"refund":{"type":"choice","instructions":"Does the customer ask for a refund?",
                              "criteria":{"yes":"money back","no":"something else"}}}}'
```

## 模型

| 模型 | 何时可用 |
| --- | --- |
| `laya-server/auto` | 总是：服务端自己选它装了哪个模型 |
| `laya-server/multilingual` | 总是：官方镜像自带 |
| `laya-server/english` | 只有 `LAYA_MODEL_PROFILE=all` 构建的镜像才有；否则 422 `MODEL_NOT_AVAILABLE` |
| `laya-server/typed-decisions` | 同上 |

默认只列前两个。要另外两个，在 `plugins.json` 的该插件条目里加 options：

```json
{ "plugins": [{ "spec": "owner/laya-magpie-plugin",
                "options": { "models": ["auto", "multilingual", "english", "typed-decisions"] } }] }
```

`options.url` 也可以放一个兜底地址（账号 metadata 里的 URL 优先）。

## 插件做的事

magpie 说 System One，laya-server 说它自己的 `/v1/systemone`，中间这层翻译全在 `lib/systemone.mjs`：

- **请求**：只发 `model` / `state` / `questions`（laya-server 的 `extra="forbid"`）；`model` 不在它认的四个名字里就落到 `auto`；choice 的 `criteria` 里 `null` 描述转成 `""`（标签是键，描述只是散文）；score 的 `criteria` 保持列表。
- **应答**：laya 的 `{choice, score, noul, probabilities, confidence, …}` 原样透传；它自家测试用的 `{value}` 简写也认（字符串→`choice`，数字→`score`，布尔→`noul`）。
- **置信度**：`probabilities` 有两个以上数字时 magpie 自己算；否则用 `confidence`；两者都没有时补 `1` —— 否则 magpie 会把它当 0，低于阈值，判定结果直接作废。
- **失败**：laya-server 的错误原样返回，401 → magpie 标记账号，422 → 这个模型这次答不了。发给非 `/systemone` 的路径回 404 并说明只做判定。

## 边界

- 没有 chat 模型：laya-server 不会对话，插件也不伪造对话。
- 没有 `auth.usage`：laya-server 没有 key 级的用量接口（`/internal/usage` 要会话 cookie），所以账号上不显示配额卡。
- 不预检 key：见上，401 由 magpie 的登出状态机处理。
- 图标取自 laya-server 仓库自带的 logo，压到 256px 加浅色圆角底盘，以 `data:image/png;base64` 内嵌在 `package.json` 的 `magpie.icon` 里（magpie 只认 https URL 或 data URI）。

## 文件

```
index.mjs             插件本体：config / auth.methods（URL + key）/ loader 与 fetch
lib/systemone.mjs     System One ↔ laya-server 的翻译（纯函数）
package.json          含 magpie.* 元数据与内嵌图标
```

## 许可

WTFPL —— 见 [LICENSE](LICENSE)。
