# SCNet (超算互联网) for OpenCode and magpie

把 [超算互联网](https://www.scnet.cn)（SCNet）接入 magpie 的 provider 插件。
它把 SCNet 模型服务的**两个独立档位**分开处理，避免把两套 API Key 混用。

## 为什么两套 Key 不能混用

| | Token Plan（套餐） | 免费额度（Free Quota） |
| --- | --- | --- |
| Key 前缀 | `sk-t…` | `sk-N…`（通用模型服务 Key） |
| 获取位置 | 控制台 → 模型服务 → **Token Plan** → API Key | 控制台 → 模型服务 → **API Key**（按量付费下） |
| 可用模型 | 套餐内模型，目前 `DeepSeek-V4.1-Flash-1017-Event` | `GLM-5.3-Flash` |
| 扣费 | 套餐 Credits（50,000 Credits/月，按模型倍率） | 免费额度（1 亿 tokens / 30 天）；额度用完或换模型会转按量付费 |
| 控制台页面 | `#/llm/token-plan` | `#/llm/free-credit` |

两档共用同一组接口地址：

```text
OpenAI 兼容：   https://api.scnet.cn/api/llm/v1
Anthropic 兼容：https://api.scnet.cn/api/llm/anthropic
```

但 Key 不同、模型不同、扣费来源不同。例如：

- 把 `sk-t…` 填进免费档：`/v1/models` 看不到 `GLM-5.3-Flash`，插件会直接拒绝登录；
- 把 `sk-N…` 填进 Token Plan 档：前缀不是 `sk-t`，插件会提示去 Token Plan 页面取专属 Key；
- 用通用 Key 调 `DeepSeek-V4.1-Flash-1017-Event`：会走**按量付费**，不会扣套餐 Credits。

插件登录时做两层校验：**Key 前缀** + **`GET /v1/models` 实际返回的模型**，
两道都过才保存账号。

## 安装

```sh
magpie plugin add @magpie-community/opencode-scnet-auth
```

## 登录

```sh
magpie plugin login scnet
```

依次填写：

| # | 问题 | 填什么 |
| --- | --- | --- |
| 1 | 档位 | Token Plan 或 免费额度（两档 Key 不通用） |
| 2 | API Key | 对应档位的 Key |
| 3 | 控制台 Cookie | 可选；填了才能看额度，留空只做模型调用 |

### Token Plan 档

1. 控制台 → 模型服务 → **Token Plan**
2. 页面底部「API Key」区域复制 `sk-t…`
3. 可选：同一页面能看 Credits 用量

### 免费额度档

1. 控制台 → 模型服务 → **免费额度**，确认 `GLM-5.3-Flash` 仍在有效期
2. 控制台 → 模型服务 → **API Key**，复制「按量付费 / 模型服务」下的 `sk-N…`
3. 免费额度按「未命中输入 + 缓存读 + 输出」扣减

> 免费额度档只暴露 `GLM-5.3-Flash` 一个模型。即使通用 Key 还能访问其他模型，
> 插件也不会列出它们，避免你在 magpie 里误选后走按量付费。

### 控制台 Cookie（仅额度查询需要）

1. 在浏览器登录 https://www.scnet.cn
2. F12 → Network → 任意 `/acx/` 请求 → Request Headers → 复制整段 `Cookie` 的值
3. 粘贴到登录向导第 3 项

Cookie 等同于登录凭据，只保存在本机 magpie 的账号文件里，不要外发。

## 额度怎么显示

Token Plan 档：

```text
scnet · DeepSeek-V4.1-Flash-1017首单5千万 · Token Plan · api.scnet.cn …MzE=
  Token Plan Credits  0% (已用 0.15 / 共 50,000 Credits)
  49,999.85 Credits left
```

免费额度档：

```text
scnet · GLM-5.3-Flash 免费额度 · 免费额度 · api.scnet.cn …xxxx
  免费额度 GLM-5.3-Flash  0% (已用 358 / 共 100,000,000 MTOKENS)
  99,999,642 MTOKENS
```

数据来源：

| 档位 | 接口 | 说明 |
| --- | --- | --- |
| Token Plan | `GET /acx/charge/account/currentuser/tokenplan/list` | `usedAmount` / `totalAmount` / `maxExpireTime` |
| 免费额度 | `POST /acx/charge/account/llmapi/resource/list/statistics` | `purchaseCount - balance` 算已用 |

两个接口都需要网页 Cookie；SCNet 的模型 API 没有 `/v1/usage` 之类的额度端点（实测 401）。

## 限制

- 控制台 Cookie 会过期，过期后额度显示「用户未登录」，重新登录一次即可；模型调用不受影响。
- 免费额度档只支持 `GLM-5.3-Flash`；Token Plan 档的模型以 `/v1/models` 为准。
- 额度是套餐/资源级，不按 Key 拆分，也不提供每日用量。
- 插件只实现 OpenAI 兼容协议（chat completions）；SCNet 的 Anthropic 兼容地址未接入。

## 开发

```sh
node --check index.mjs
node --test            # 31 项：纯函数 + 本地假站点集成测试
```

测试覆盖：两档 Key 混用拦截、前缀校验、`/v1/models` 能力校验、
Token Plan/免费额度换算、Cookie 缺失与过期、免费档模型过滤。
