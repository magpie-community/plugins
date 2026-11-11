# MonkeyCode provider plugin for magpie / OpenCode

把 [MonkeyCode](https://monkeycode-ai.com)（长亭百智云，官方客户端 ohmyagent）的托管模型接进 magpie。
装上之后，Claude Code、Codex、OpenCode 等 Agent 都能选 `monkeycode/basic/…`、`monkeycode/pro/…`、`monkeycode/ultra/…`。

## 安装

```sh
magpie plugin add xxhhlk/magpie-monkeycode-plugin
magpie plugin login monkeycode
magpie provider test monkeycode
magpie models | grep monkeycode
```

开发时也可以就地加载本地目录：

```sh
magpie plugin add ./magpie-monkeycode-plugin
```

也可以在 magpie 窗口的「插件 › 发现 › 从文件夹添加」里选这个目录。插件就地加载，不装任何依赖。

## 登录

### 方式一：读取本机客户端登录态（推荐）

选「读取本机 MonkeyCode 客户端登录态」。插件只读下面这份配置，不改动它：

| 系统 | settings.json |
| --- | --- |
| Windows | `%APPDATA%\com.chaitin.baizhi.monkeycode\ohmyagent\settings.json` |
| macOS | `~/Library/Application Support/com.chaitin.baizhi.monkeycode/ohmyagent/settings.json` |
| Linux | `~/.config/com.chaitin.baizhi.monkeycode/ohmyagent/settings.json` |

`MONKEYCODE_CONFIG_DIR` 可以覆盖这个目录。控制台 Cookie 从同级的
`monkeycode-cookies.json` 里取（`monkeycode_ai_session`，过期就不用）。

### 方式二：手动填写

从同一份 `settings.json` 里取两个值：

- `signing_secret`：顶层字段，形如 `omas_…`
- `models` 里任意 `monkeycode-*` 条目的 `api_key`：形如 `oma_…`

第三个问题问控制台 Cookie，只用于查积分和签到状态，没有就填 `-`。

两把密钥是**不同的东西**：`oma_` 是请求身份，`omas_` 用来算请求签名，缺一个都发不出去。

## 模型

上游没有模型目录接口（`GET /models` 返回 405），所以模型表是静态的，取自官方客户端的托管清单：

| 档位 | 模型 |
| --- | --- |
| `basic/` | deepseek-flash、glm-5.3-flash、kimi-k2.5、minimax-m2.5、qwen3.5-plus、qwen3.8-flash |
| `pro/` | deepseek-flash、glm-5、hy3、kimi-k2.6、minimax-m3、qwen3.6-plus、gpt-5.6-terra |
| `ultra/` | glm-5.1、qwen3.7-max、gpt-5.6-sol、gpt-6-astra |
| 无档位 | deepseek-flash、glm-5.1、glm-5、kimi-k2.6、minimax-m2.5、minimax-m3、qwen3.6-plus、qwen3.7-max |

上下文 200K、输出上限 32K，全部支持工具调用。

四个模型走 OpenAI Responses 而不是 Anthropic Messages：`basic/qwen3.8-flash`、`pro/gpt-5.6-terra`、`ultra/gpt-5.6-sol`、`ultra/gpt-6-astra`。插件已经按模型切换，不用手动配。

## 请求是怎么发出去的

MonkeyCode 的托管端点收 Anthropic Messages 形状的请求，但要求每个请求带一枚签名头：

```
X-Ohmyagent-Signature: v1=hex(HMAC-SHA256(signing_secret, system[0].text))
```

它只校验签名和实际发出的内容对得上，不要求 system[0] 是官方那段提示词。
所以插件固定把 `You are a helpful assistant.` 放在 system 第一条，Agent 自己的系统提示词接在后面（后续条目不参与签名）。
Responses 面同理，签名对象换成 `input[0].content`。

另外两条请求头也照官方客户端设置：`User-Agent: ohmyagent f6b21ad`、`Anthropic-Version: 2023-06-01`（仅 Messages 面）。

## 用量与签到

「用量」里的积分和每日 Token 来自控制台钱包接口，需要控制台 Cookie：

- 积分余额：钱包 `balance` 除以 1000（与网页控制台一致）
- 每日 Token：当日已用 / 当日上限

控制台会话大约 6 天过期（由约 29 天的百智云会话派生），过期后用量会提示重新登录，**不影响对话**（对话只用 `oma_` + `omas_`）。插件不做自动续期：`oma_` key 无过期，控制台会话要续得回官方客户端重新登录。

签到支持自动领取：查询今日状态；未签时完成 Cap.js 的 SHA-256 工作量证明（PoW），兑换
`captcha_token` 后领取；已签则直接返回「今日已签到」。PoW 是本机计算，无需看图或拖滑块。
计算有参数和时间上限，领取回执必须明确返回 `checked_in: true` 才显示成功。
上游回执不提供奖励金额，插件不填固定积分数。控制台会话过期时需重新导入登录态。

## 积分倍率

magpie 的模型列表里，模型名旁边那个灰色小徽章就是积分倍率（每次请求消耗多少倍积分）。
MonkeyCode 没有「倍率」字段，它给的是每个模型的 `input_price`；实测扣分与价格严格成正比
（同一批 197 token 请求：价格 100/200/400/600/800 分别扣 4/8/15/23/30 积分），
所以插件的 `provider.models` 钩子去控制台读价，除以 basic 档的 200 得到倍率：

| 模型 | 控制台价 | 倍率 |
|---|---|---|
| `qwen3.5-plus` | 100 | 0.5× |
| basic 档全部、`deepseek-flash`、`minimax-m2.5`、`qwen3.6-plus` | 200 | 1× |
| `glm-5` | 400 | 2× |
| `minimax-m3`、`qwen3.7-max` | 600 | 3× |
| `glm-5.1`、`kimi-k2.6` | 800 | 4× |

读价需要控制台 Cookie（与用量同一个）。没有 Cookie、或者控制台没给某个模型定价时，
那个模型就不带倍率——不猜、不显示错的数字。pro/ultra 档在账号无权限时控制台不下发价格，
所以这些模型通常没有徽章。

结果缓存 10 分钟，控制台短暂不可达时沿用上次读到的值。

## 已知限制

- 静态表与控制台可见模型集一致（2026-10-23 对过线上目录）。控制台目录另有 20 个 `is_hidden` 条目（父级占位、灰度模型），与官方客户端一样不展示；上游上新模型要改 `MODEL_IDS` 后重装。
- `pro/`、`ultra/` 档要对应账号权限。没有权限时上游回 `403 Forbidden`，属正常拒绝，不会标记账号登录失效。
- 未知模型上游会静默回落到默认模型，插件因此只暴露清单里的模型。
- 控制台 Cookie 过期后积分/签到读不到，对话不受影响。
- 并发默认 4（`package.json` 的 `magpie.maxConcurrency`），需要更高可以改。

## 测试

离线单测，不联网、不需要凭据：

```sh
node --test test/index.test.mjs
```

签名黄金向量（用 python hmac 独立算出）、模型映射、两套请求体的注入与去重、凭据解析、
客户端配置读取、钱包到用量的换算都由它覆盖。`_internal` 导出纯函数供测试用，入口本身只导出插件函数。

装好并登录之后，对着运行中的 magpie 和真实账号再跑两条验收：

```sh
# 1) 经网关端到端：模型列表、两个面各跑普通/流式回复、工具调用、
#    系统提示词透传、未知模型与无权限档位的错误分类
node verify/verify-installed.mjs          # 可选 [gateway] [anthropic模型] [responses模型]

# 2) 插件钩子直连真实账号：usage 出数字、自动签到并确认重复调用为已签、
#    loader 的签名请求被上游接受、错签名被 403 拒绝
node verify/verify-hooks.mjs              # 可选 [插件目录]
```

两个脚本都不打印、不写入任何凭据。`verify-hooks.mjs` 会实际领取当天尚未领取的签到奖励，
并从 `~/.config/magpie/plugin-auth.json` 就地读取已保存的登录，`MONKEYCODE_AUTH` 可换文件路径。`verify-installed.mjs` 的 ultra 档用例
在账号无权限时同样 PASS——`403` 且未标记登录失效即符合预期，明细注明 expected。
