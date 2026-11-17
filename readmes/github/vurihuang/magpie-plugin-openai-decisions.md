# magpie-plugin-openai-decisions

OpenAI 的 Decisions API（`POST /v1/decisions`，仅 `gpt-6-luna`）作为 Magpie 的 System One 决策模型。

Magpie 的路由 group 只能放“全是决策模型”或“全是对话模型”；`openai/gpt-6-luna` 属于对话模型，进不了和 `typesafe/jev-latest` 同一个 group。本插件把 OpenAI 注册成 `decide` provider（`openai-decide/gpt-6-luna`），在插件自己的 `fetch` 里把 System One 请求翻译成 Decisions 请求并译回。客户端继续发 `POST /v1/systemone`，由 group 完成“OpenAI 优先、额度/故障时回落 typesafe”。

这是标准的 OpenCode 插件包（无依赖、无构建），Magpie 的 `decide` 机制见其 [provider-plugins 文档](https://github.com/yetone/magpie/blob/main/docs/subsystems/provider-plugins.md#a-plugins-decision-api)。

## 目录

```text
index.mjs        插件入口：provider 注册、鉴权 loader、/systemone 的 fetch
translate.mjs    System One <-> Decisions 互译，纯函数
test/            bun test，使用本地假 OpenAI 服务，不访问网络
```

## 安装

准备 Typesafe API key 与 OpenAI API key（需能调用 Decisions API）。key 只交给 Magpie，不写进仓库或环境变量。

```sh
# 1. Typesafe（兜底）
magpie provider add typesafe <TYPESAFE_API_KEY>

# 2. 插件：从 GitHub 安装，或填 Magpie 所在机器上的本地绝对路径
magpie plugin add github:vurihuang/magpie-plugin-openai-decisions
# magpie plugin add /abs/path/to/magpie-plugin-openai-decisions
magpie plugin login openai-decide            # 按提示粘贴 OpenAI API key

# 3. 路由 group：OpenAI 优先，失败再 Typesafe；stays=off 必须设
magpie group add jev-latest models=openai-decide/gpt-6-luna,typesafe/jev-latest routing=order stays=off
#    已有 jev-latest 时改用 set，保留原成员作后备：
# magpie group set jev-latest models=openai-decide/gpt-6-luna,typesafe/jev-latest stays=off
```

客户端的 System One 请求使用 `model: "jev-latest"`（group 名）。`typesafe/jev-latest` 是直连 provider，不经过 group，网关中间件也改写不了 `/v1/systemone`，所以必须用裸名。

- `stays=off`：默认的 `stays=auto` 会黏住上一个回答的 provider，OpenAI 失败回落后即使恢复也不会再被优先尝试。
- 保存 group 后网关需要片刻重载，个别紧随其后的请求可能仍按旧成员回答。
- 没有 OpenAI key 时，不要装插件，也不要把它留在 group 里。想先装好而不调用 OpenAI，可用占位 key `openai-decide-not-configured` 登录：插件本地返回 503，网关回落到下一个成员，零上游调用。

## 验证

```sh
bun test                                     # 离线单元测试

curl -s http://127.0.0.1:3425/v1/systemone -H 'Authorization: Bearer magpie' -H 'Content-Type: application/json' \
  -d '{"model":"jev-latest","state":"Sedus makes office chairs.","questions":{"q":{"type":"noul","instructions":"Does it make furniture?"}}}'
```

响应的 `model` 为 `gpt-6-luna` 表示 OpenAI 在答；`jev-*` 表示已回落。`~/.config/magpie/routing/<日期>.jsonl` 的 `tries` 记录每次尝试的成员与状态。

## 行为

- `choice`、`noul`、`score` 三种题型与 TypeSafe 的响应格式一致；`state` 为对象时按键排序后以 `input_json` 传给 OpenAI，与 Magpie 内置翻译一致。
- 失败不会变成答案：OpenAI 的 401/402/429/5xx 保持原状态码（Magpie 据此回落）；超时 504；不完整、被拒答、概率不自洽或数量不符的响应为 502。回落后失败成员约退避 1 分钟再恢复。
- 选项（`magpie plugin options <路径> '<json>'`，`off` 清除）：`timeoutMs`（默认 8000）、`upstream`（默认 `https://api.openai.com/v1/decisions`，测试时指向假服务）。
- OpenAI 与 Jev 的置信度分布不同；若客户端按置信度门槛取舍，切为主用前先做影子对比。

## 许可

MIT，见 [LICENSE](LICENSE)。仓库带 `magpie-plugin` topic，会出现在 Magpie 的 Plugins → Discover → Unofficial。
