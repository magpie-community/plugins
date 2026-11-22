# magpie-provider-eaichat

把 [云智助手](https://eaichat.ctyun.cn)（天翼云）的 Token 中心接入 [magpie](https://usemagpie.ai)：作为大模型供应商使用，并提供自动每日签到和用量显示。

## 功能

- **模型转发**：模型清单从上游 `/ai/portal/wenc/v1/platform/cp/models` 拉取（见下方模型目录），默认走 OpenAI Chat Completions 端点（支持思考档位），可在插件选项中切换为 Anthropic Messages 端点（从下一个请求起生效）。
- **登录**：账号 + 密码（IAM → CAS → ticketAuthorize 链路），API Key 可选。
- **自动续登**：JWT 到期前 6 小时自动重走登录链路；网页会话中途失效时自动重登并重试一次。
- **每日签到**：通过 magpie 自带的签到调度（每个北京日一次），领取 `taskDefId=3001` 的「每日签到」Token 奖励；若「连续7天签到」任务（`taskDefId=3002`）已满足条件且尚未领取，会在同一次签到中自动领取。
- **用量显示**：读取 Token 中心的 `platform/cp/usage/summry`，在账号额度卡片 / `magpie quota` / `GET /v1/magpie/quotas` 中显示已用、剩余、已过期额度。

## 登录交互

1. 必填：云智助手账号（手机号或邮箱）
2. 必填：密码
3. 可选：API Key

未填 API Key 时，自动查找账号名下名为 `magpie-provider-eaichat` 的 Key；不存在则自动创建一个。密钥只保存在 magpie 的 `plugin-auth.json`（权限 600），密码以 SHA-256 摘要保存（登录链路上游要求的就是该摘要），不会写入日志或仓库。

## 安装

```sh
magpie plugin add github:4x25/magpie-provider-eaichat
magpie plugin login eaichat
```

## 模型目录

模型清单以登录后的上游接口 `/ai/portal/wenc/v1/platform/cp/models` 为准：`model` 是请求用的上游模型 ID，`title` 是展示名，`api` 声明该模型可用的端点。插件不维护固定清单，上游新增或下线模型后，下一次刷新列表就会跟随。

当前上游清单（2026-11-21）：

| 上游模型 ID | 展示名称 | 上下文（tokens） | 最大输出 | 思考档位 | 输入 |
| --- | --- | ---: | ---: | --- | --- |
| `deepseek-v4.1-flash` | DeepSeek-V4.1-Flash-1017 | 1,048,576 | 384,000 | `none` `low` `high` `max` | text, image |
| `glm-5.3-flash` | GLM-5.3-Flash | 1,000,000 | 131,072 | `low` `high` `max` | text, image, video |
| `deepseek-v4-pro-0813-oc` | DeepSeek-V4-Pro-0813 | 1,000,000 | 384,000 | `none` `low` `high` `max` | text |
| `glm-5.3-oc` | GLM-5.3 | 1,000,000 | 131,072 | `low` `high` `max` | text |
| `qwen-3.8-flash` | Qwen-3.8-Flash | 1,000,000 | 131,072 | `none` `low` `medium` `xhigh` | text, image, video |

请求使用 `model`，展示名使用 `title`。模型列表只包含上游声明过的模型：`config` 钩子不声明模型，`provider.models` 在登录后按上游清单生成，未登录或拉取失败时返回空表。上游 `api` 字段里的 `openai-completions` / `anthropic-messages` 决定模型出现在哪种协议下；字段缺失时视为两种都可用。

magpie 根据 `limit.context` 自动显示灰色 `1M` / `1.0M` 徽标，并把 `variants` 显示为思考档位。更新插件或在供应商页面点击「重新获取模型」时，会重新请求上游清单。

### 元数据来源

上游清单不返回上下文、最大输出、多模态和思考档位，这部分仍来自 [models.dev](https://models.dev/api.json)。`src/constants.ts` 维护「已知上游模型 ID → models.dev 规范模型 ID」的映射，只用于补充元数据；`src/model-metadata.ts` 由脚本生成：

```sh
npm run update:models
```

models.dev 没有 `eaichat` 供应商，所以脚本按每个条目的 `canonical_model_id` 汇总所有列出同一规范模型的供应商：

- 上下文 / 最大输出：出现次数最多的值（并列取较大值）；
- 输入模态：至少一半条目声明的类型；
- 思考档位：出现次数最多的 `reasoning_options` 组合，`toggle` 记为 `none`。

生成的元数据带 `sourceEntries` 字段，便于核对聚合了多少条 models.dev 条目。上游新增、尚未写入映射的模型会先以保守默认值出现（128k 上下文、32k 输出、纯文本、无思考档位），补上映射后重新运行脚本即可获得准确元数据，不需要改模型清单本身。

### 思考档位

插件默认使用 OpenAI Chat Completions 协议，因为 OpenCode/magpie 把用户选的档位作为 `reasoning_effort` 发出：

- OpenAI 端点：写入 `enable_thinking` 与 `reasoning_effort`（上游合法值包括 `none`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`、`ultra`）；
- Anthropic 端点：写入 `thinking.budget_tokens` 与 `output_config.effort`，`none` 写成 `thinking: { type: "disabled" }`。

没有选档位时请求体保持原样，由上游按自己的默认值处理。Anthropic 端点没有与 OpenCode 变体等价的客户端字段，因此如果依赖思考档位，请保持默认的 OpenAI 协议；Anthropic 协议仍可用于显式发送 `thinking` / `output_config` 的客户端。

### 与上游实测的差异

2026-11-18 对 6 个模型的两个端点做了小请求探测：OpenAI 端点的 `reasoning_effort` 会实际改变推理 token 数（`low` / `high` / `max` 有差异），非法值返回 400 并列出合法枚举；Anthropic 端点的 `thinking.budget_tokens` 与 `output_config.effort` 均被接受。GLM 系列的 OpenAI 端点不接受 `enable_thinking: false` 关闭思考，因此 GLM 的档位里没有 `none`。

## 每日签到

插件实现了 magpie 的 `auth.checkin`。要每个北京日自动签到，需在 magpie 的 **设置 → 签到** 里为本供应商开启每日签到（默认关闭）；`magpie accounts checkin` 可随时手动触发一次。

一次签到会依次处理两个任务：

1. 领取 `taskDefId=3001` 的「每日签到」奖励；
2. 检查 `taskDefId=3002` 的「连续7天签到」奖励。若本次领取了每日签到，会重新读取任务列表，确认 7 天奖励是否刚解锁；满足条件且尚未领取时自动领取。

签到结果（获得多少 Token、连续天数）显示在账号的用量卡片上。连续 7 天奖励领取后，上游仍可能返回 `canReceive: true`，插件以 `status=2` 判断已领取，不会重复领取。

## 用量口径

额度窗口以「已用 + 剩余」为分母：剩余归零即 100%，与 magpie 的路由判断一致；已过期（`expTokens`）额度不参与比例，单独显示。数字保留上游精度。

## 额度耗尽

Token 余额为 0 时，上游仍返回 HTTP 200，并把充值文案塞进正常回复（OpenAI 在 `choices[].message.content`，Anthropic 在 `content[].text`，流式则在 delta 中），合成模型名为 `ctyun-smart-oc` / `ctyun-smart-claude`。插件在转发层（`src/relay.ts` → `src/quota.ts`）识别这类响应，改为协议兼容的错误：

- OpenAI：`402 Payment Required` + `{"error":{"type":"insufficient_quota","code":"insufficient_quota",...}}`
- Anthropic：`402 Payment Required` + `{"type":"error","error":{"type":"invalid_request_error",...}}`

错误 `message` 保留上游的充值说明与购买链接。流式请求也会在输出第一个 token 前转成 402，不会把充值文案当成模型回复发给客户端。用 402 而不是 429，是为了让 OpenAI/Anthropic SDK 直接报错而不自动重试（额度耗尽重试无用）。

## 实测记录（2026-11-12，magpie 0.1.1331）

- 登录链路（IAM → CAS → ticketAuthorize）、API Key 列表回显、用量读取、每日签到状态读取：全部通过。
- 两个模型端点均只认 `Authorization: Bearer <apiKey>`（Anthropic 端点对 `x-api-key` 返回 401），插件已在转发层统一改写认证头。
- Anthropic Messages（流式/非流式）与 OpenAI Chat Completions 均通过 magpie 网关全链路验证（`magpie provider test`）。
- 到期前的 `auth.refresh` 自动续登：触发后重登并把 `expires` 刷新为 +7 天，`access`/`refresh`/`apiKey` 完整写回。

## 开发

```sh
npm install
npm test        # 单元测试（模拟上游，不联网）
npm run check   # tsc --noEmit
npm run update:models   # 从 models.dev 重新生成 src/model-metadata.ts
node --experimental-strip-types --no-warnings scripts/live-check.ts   # 实机验证（读 .env，不打印凭据）
```

### 结构

```
src/
  index.ts     插件入口（config/provider/auth 钩子）
  eaichat.ts   云智助手客户端（登录链路、签名、portal 接口）
  state.ts     账号会话管理（续登、Key 解析、并发合并）
  models.ts    模型目录（上游清单 × 两种协议）
  model-metadata.ts  从 models.dev 生成的限额/模态/思考档位
  usage.ts     用量映射
  checkin.ts   签到流程与结果映射（每日签到 + 连续7天奖励）
  relay.ts     模型请求转发（URL 归一 + 认证头 + 思考档位）
  quota.ts     额度耗尽识别（把上游 200 充值文案转成 402）
  crypto.ts    加密/签名原语
  http.ts      CookieJar 等基础设施
  constants.ts 常量与规范模型映射
scripts/
  update-model-metadata.ts  重新生成 model-metadata.ts
  live-check.ts             实机验证
tests/         node --test 单元测试（含完整登录链路的假上游）
```

### 已知待校准项

- 模型限额来自 models.dev 的聚合值，不是云智助手自己的 `/platform/cp/models`（该接口只返回模型 id、展示名与可用端点，不返回限额）。若上游实际限额与聚合值不同，调整 `src/constants.ts` 的规范模型映射后重新运行 `npm run update:models`。
- `addApiKey` 的创建路径未在真实账号实测（该账号已有同名 Key，走了复用路径）；响应字段名做了多候选兼容（`apiKey`/`key`/`keySecret` 等），列表回显字段已实测为 `apiKey`。

## License

MIT
