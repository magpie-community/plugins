# moonup Magpie 插件

用 moonup API Key 在 [Magpie](https://usemagpie.ai) 中调用模型，查看钱包余额、订阅和 Key 限额。支持 `https://moonup.dev` 和 `https://api.moonup.dev`，登录时选择地址。插件无运行时依赖，无需构建。Magpie 使用 Bun 运行插件，本地测试需要 Node.js 20 或更高版本。

## 安装和连接

在 Magpie 的 Plugins → Discover → Unofficial, on GitHub 中查找 `moonup`，或直接粘贴 GitHub 安装地址。此插件尚未发布 npm，npm 搜索区不会返回它。命令行安装：

```sh
magpie plugin add github:ferguson089347/magpie-moonup
magpie plugin login moonup
```

登录时先选择 `moonup.dev` 或 `api.moonup.dev`，再填写 API Key。不需要手动输入网址、账号名、模型列表或协议。没有提交地址选择时默认使用 `moonup.dev`。

如果固定使用一个地址，可以预设该地址。之后添加账号时只填 API Key：

```sh
magpie plugin options magpie-moonup '{"baseURL":"https://api.moonup.dev"}'
magpie plugin login moonup
```

`baseURL` 是新账号的默认地址，已保存账号继续使用自己的地址。高级配置也可以通过它指定测试或自托管地址。重复登录可添加其他 Key。新账号显示为 `moonup.dev · 密钥尾号 cbed`，完整地址和 Key 的摘要保存在内部，用于区分同尾号账号。已有账号保留身份和模型设置，因此更新后仍可能显示旧名称。提供商显示为 `moonup`，模型显示为 `moonup/<模型 ID>`，复合 Key 的分组前缀会保留。

插件通过 GitHub 分发，尚未发布 npm。安装后运行 `magpie plugin update` 更新。

账号卡片中的「未暴露模型」由 Magpie 显示，表示当前提供商没有启用供客户端调用的模型。展开 `moonup`，点击「获取模型」或「重新获取模型」，勾选需要的模型或「全选」，再保存。如果列表仍为空，检查 moonup 密钥所属分组和模型权限。插件确认后台列表中没有可用对话模型时，也会在用量区域提示检查权限。

## 自动发现模型

插件读取 `GET /v1/models?include=capabilities`。服务端返回 `protocols` 时按允许的文本接口选择，优先使用 `native_protocols` 中的原生接口。

| 服务端协议                | 请求接口                                         |
| ------------------------- | ------------------------------------------------ |
| `anthropic_messages`      | `/v1/messages`                                   |
| `openai_responses`        | `/v1/responses`                                  |
| `openai_chat_completions` | `/v1/chat/completions`                           |
| `gemini_generate_content` | `/v1beta/models/{id}:generateContent` 或流式接口 |

同一优先级按表中顺序选择。有明确协议信息时，只支持图片、音频等非对话接口的模型不会出现在插件的对话模型列表里，模型别名也不需要另外配置协议。

`0.1.3` 兼容没有 `protocols` 的标准模型列表。Claude 使用 Messages，GPT / Codex / o 系列使用 Responses，Gemini 使用原生接口，其他名称使用 Chat Completions。复合前缀只在识别型号时略去，发送的完整模型 ID 保持原样。有明确协议字段时始终按服务端权限处理，包括空数组。

旧格式列表中的自定义别名，或仅开放特定协议的分组，可以按完整模型 ID 配置：

```sh
magpie plugin options magpie-moonup '{"modelProtocols":{"自定义别名":"anthropic_messages","work/gpt-model":"openai_chat_completions"}}'
```

覆盖值使用上表中的服务端协议名称，只作用于没有 `protocols` 字段的条目。按名称识别不能代替真实协议权限；后台拒绝某种接口时，按分组实际开放的协议填写。上下文、输出上限、模态、工具调用和推理档位仍使用站点返回的属性，缺失信息保持未知。查询失败由 Magpie 保留此前发现的模型。

`0.1.1` 合并同一账号的并发查询，模型列表缓存 30 秒，额度缓存 5 秒，减少打开页面和刷新卡片时的重复等待。不同地址、Key 和查询接口相互隔离；失败结果立即清除，下次刷新重新请求。模型或额度权限在缓存有效期内可能延迟显示，实际调用仍以后台权限校验为准。后台返回 401 时清除该账号的所有查询缓存。

插件在缓存前检查模型和额度数据的格式。空模型列表正常显示为空，缺少型号、协议字段格式错误或能力格式错误的条目会让本次刷新失败，由 Magpie 保留此前的列表。后台修复后，下次刷新即可重新读取，不必等异常缓存到期。未知名称的消费窗口保留实际用量，长度保持未知。

查询的超时为 15 秒，JSON 响应上限为 4 MiB。插件区分连接失败、查询超时、权限不足和无效 JSON，方便检查站点配置。模型生成响应直接转发，不使用这些查询缓存和时限。Gemini 的原生 `countTokens` 请求也会使用正确的 `/v1beta` 路径。

## 余额和额度

插件读取 `GET /v1/usage`，在 Magpie 用量卡片中显示：

- 当前套餐及到期时间。
- 钱包余额及服务端配置的额度单位，账号摘要直接显示 `余额 12.34 USD`。零余额显示为 `余额 0.00 USD`，未返回金额时显示「余额未返回」。
- 「密钥总额度」以及密钥的 5 小时、24 小时和 7 天消费窗口。
- 当前扣费订阅的「每日额度」「每周额度」「每月额度」。Key 同时设置限额时，两者一起显示。

旧版后台在无限额钱包模式下返回的 `remaining` 也可作为余额；密钥额度模式的 `remaining` 表示密钥剩余额度。小于 0.01 的正余额保留更多小数，防止被显示为零。只有服务端提供了重置时间才显示倒计时。窗口会把已用百分比交给 Magpie 参与路由；钱包余额没有时间窗口。余额不足、订阅不可用或到期时显示处理提示，保留现有登录；HTTP 401 才标记 Key 需要重新添加。

## 凭据和请求

Key 由 Magpie 的 `plugin-auth.json` 保存，插件不额外创建凭据文件、不请求控制台令牌。模型发现和用量查询只访问该 Key 的站点，不请求 models.dev 或其他目录。

发送模型请求时，插件替换调用方的认证头，保留请求体、取消信号和响应流。请求只允许发往当前账号的文本接口，禁止跟随重定向。分组路由、提供商切换和实际扣费由 TokenRouter 完成，多个插件账号之间的切换由 Magpie 完成。

查询错误不会回显服务端响应正文，避免错误页反射凭据。中文错误提示区分 Key 无效、权限不足、查询限流、网络故障和返回数据格式错误。误填过短的 Key 时，账号名省略尾号，防止把完整值显示在账号列表中。

## 参考与取舍

| 参考项目                                                                                           | 适合借鉴的做法                                 | 本插件的处理                                              |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------- |
| [magpie-sub2api](https://github.com/broven/magpie-sub2api)                                         | 将订阅和 Key 限额转成 Magpie 窗口              | 同时展示 Key 限额和实际扣费订阅                           |
| [sub2api-magpie-plugin](https://github.com/FischelChern/sub2api-magpie-plugin)                     | 预设地址后只填 Key、稳定账号名、保留原始响应流 | 使用同样的接入流程，由站点报告协议来支持别名              |
| [magpie-packycode](https://github.com/egenchen/magpie-packycode)                                   | 跨分组选价、故障切换和用量展示                 | 使用 TokenRouter 已有的服务端路由，不在插件内创建分组 Key |
| [Open Design](https://github.com/magpie-community/plugins/blob/main/packages/opendesign/index.mjs) | 账号身份和资金信息分别展示                     | 新账号使用站点和密钥尾号，区分码保存在内部                |
| [Cline](https://github.com/magpie-community/plugins/blob/main/packages/cline/index.mjs)            | 余额显示具体金额和单位                         | 钱包摘要展示金额，密钥和订阅额度使用独立窗口              |

接口契约见 [Magpie 插件文档](https://usemagpie.ai/docs/plugins)。浏览器授权、自动安装插件和 npm 发布不属于当前功能；网站已有的「导入 Magpie」继续用于创建普通自定义提供商。

## 验证

```sh
git clone https://github.com/ferguson089347/magpie-moonup.git
cd magpie-moonup
npm run check
npm test
npm pack --dry-run
```

测试使用本地 HTTP 服务，覆盖四种协议、别名、账号凭据隔离、取消、额度组合和错误处理，不调用收费模型。服务端模型列表测试随 TokenRouter 后端维护，插件仓库只包含插件和本地测试。

## 许可

沿用 TokenRouter 仓库的 LGPL-3.0 许可，见 [LICENSE](LICENSE)。包图标使用 `moonup.dev` 的站点 favicon，内嵌在 manifest 中。
