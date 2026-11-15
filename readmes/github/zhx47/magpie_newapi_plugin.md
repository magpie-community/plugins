# Magpie New API 插件

把 New API 站点接入 Magpie：使用站点访问令牌登录，发现分组和模型，为推理请求选择分组 key，并显示余额、执行每日签到。

所有站点都属于供应商 `newapi`。每个站点账号保存自己的地址、凭据和分组；同一站点可以添加多个账号。

## 安装与登录

在插件目录的上一级执行：

```sh
magpie plugin add ./magpie_newapi_plugin
magpie plugin login newapi
```

登录时按提示填写：

| 字段 | 填写方式 |
| --- | --- |
| Base URL | 站点地址，例如 `https://newapi.example.com`。可以保留部署子路径；末尾的 `/v1`、`/v1beta`、`/api` 会被去掉。 |
| Access token | 站点个人设置里的访问令牌，用于读取账号、分组和 token。这里不能填 `sk-` 开头的推理 key。 |
| User id | 通常留空；站点需要 `New-Api-User` 时填写自己的用户 ID。 |
| Site label | 模型 ID 的站点前缀，留空使用主机名。不同站点应使用不同标识。 |

插件会先从站点已有 token 中读取分组 key。有分组仍缺 key 时，会询问是否创建 token；选择不创建或创建后仍取不到 key，再逐个填写。输入框留空可以跳过该分组。

完整 key 的读取按 New API 版本选择：旧版直接用列表明文，`v0.11.4-alpha.4` 起用单个 POST，`v0.12.3` 起用批量接口。已有 token 只是无法读取 key 时不会再创建一个；确实缺少多组 token 时，创建后集中读取一次列表。版本不明的定制站点采用有限的兼容流程，细节见 [完整 key 的读取](docs/plugin.md#完整-key-的读取)。

以后补 key 或增加站点，再运行 `magpie plugin login newapi`。选择已有账号可以复用已保存的访问令牌和分组 key。

## 模型与请求

模型 ID 包含站点和分组，例如：

```text
newapi/example.com/default/gpt-4o
newapi/example.com/vip/gpt-5
```

模型名称同时显示站点、分组和倍率。同一站点、同一分组的多个账号可以共用一个模型条目；请求仍使用当前账号自己的地址和 key。

默认协议只按上游模型名选择，不受站点上报的端点限制：`gpt-5`、`gpt-6` 开头使用 Responses，`claude` 开头使用 Anthropic Messages，`gemini` 开头使用 Gemini，其他名称使用 Chat Completions；匹配不区分大小写。

每个模型只保留一个条目，通过现有的 `api.npm` 字段向 Magpie 声明默认协议。站点只上报 Chat 或没有端点信息时，也按上述模型名前缀选择；接口是否可用以站点实际响应为准。

手动切换的选项由 Magpie 宿主决定。当前上游面板没有提供插件 Gemini 的切换入口，因此仅修改插件无法实现同一模型条目下四种协议都可切换。插件没有增加宿主不识别的字段，也没有生成多个协议变体。

## 余额与签到

余额卡把已用额度和剩余额度合成一个钱包窗口，按站点设置显示美元、人民币、自定义货币或原始 quota。需要处理的分组会显示缺 key、key 被拒或分组已消失的提示。

读用量时会顺带同步分组和 key，同步间隔为 10 分钟；签到钩子会强制同步一次。模型列表会联网读取模型，但不会创建 token 或同步账号状态。

每日签到由 Magpie 的签到开关控制，接口统一为 `GET/POST /api/user/checkin`。遇到 Cloudflare 或 Turnstile 验证会提示到站点手动签到。`runanytime.hxi.me` 另有 PoW 签到适配，插件会按站点要求计算并提交答案。

## 插件选项

在 Magpie 的插件设置中调整：

| 选项 | 默认 | 作用 |
| --- | --- | --- |
| `auto-create-keys` | 关闭 | 后续同步时为缺 key 的分组尝试创建站点 token。首次登录是否创建由登录提问决定。 |

开启自动创建会在站点写入名为 `magpie-...` 的 token。只想使用已有 key 时，保持关闭，并在登录时选择手动填写。

## 已适配的站点差异

| 主机 | 适配内容 |
| --- | --- |
| `hyxware.com` | 从 token 详情补齐分组和额度，支持一个 token 服务多个分组。 |
| `agentrouter.org`、`ps.air-outer.com` | 使用当前用户组，按站点列表顺序选择第一条可用 token。 |
| `runanytime.hxi.me` | 获取 PoW 题目、计算 nonce、提交签到；跳过该站点的签到状态预读。 |

其他主机使用通用 New API 流程。

## 常见问题

| 现象 | 处理方式 |
| --- | --- |
| 登录时访问令牌被拒 | 确认填写的是管理访问令牌，并检查站点权限及 User id。 |
| 某个分组没有模型或提示缺 key | 重新登录选择这个账号，补充该分组的 key；确认 key 在站点上可用。 |
| 签到提示需要验证 | 到站点完成签到。站点验证设置变化后，可以重新登录更新账号状态。 |
| 默认协议不适合当前站点 | 查看 Magpie 对该模型提供的协议选项；当前插件不能补齐上游面板缺少的切换入口。 |

完整的功能说明、接口流程、账号结构和当前限制见 [功能与实现文档](docs/plugin.md)。

## 开发检查

`index.mjs` 是插件入口，`src` 按功能分为九个目录：

```text
src/
├── api/       # HTTP 请求、具体接口、版本判断
├── auth/      # 登录提问、站点快照、登录会话
├── account/   # 账号状态、分组 key、同步
├── provider/  # 模型发现、协议选择、推理请求转发
├── checkin/   # 签到流程、RunAnyTime PoW
├── usage/     # 钱包显示、额度换算
├── sites/     # 站点适配、设置与定价缓存
├── i18n/      # 翻译、语言选择
└── shared/    # 缓存、并发控制、共用工具
```

各模块的职责和接口见 [源码和接口索引](docs/plugin.md#源码和接口索引)。

开发脚本使用 Node.js 内置模块，无需安装第三方依赖。CI 使用 Node.js 20。

```sh
npm test
npm run check
npm run scan
```

真实站点联调使用 `npm run live`，配置方法见 [联调说明](docs/plugin.md#真实站点联调)。该脚本会发送真实推理请求，可能产生费用；默认只读取签到状态。
