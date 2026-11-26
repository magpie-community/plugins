# ZenMux Builder & PAYG for Magpie

在 Magpie 里使用 ZenMux Builder 订阅和按量付费。Builder 显示 5 小时、7 天用量与重置时间、剩余提前重置次数，以及 ZenMux 返回的账号异常。PAYG 显示美元余额。

## 安装

建议使用 Magpie 0.1.4839 或更新版本。在 Magpie 的 **插件 → 发现** 安装框输入以下地址。

```text
github:Alcatraz-Zhang/magpie-zenmux-platform
```

也可以用命令行安装。

```sh
magpie plugin add github:Alcatraz-Zhang/magpie-zenmux-platform
```

如果使用本地源码，在同一个安装框旁点文件夹按钮，选择含有 `package.json` 的目录。

## 登录

| Magpie 供应商 | 推理 Key | 可选的 Platform Key |
| --- | --- | --- |
| ZenMux Builder Plan | 订阅 Key（提示 `sk-subs-…`） | `sk-mgmt-…`，读取当前套餐、5 小时和 7 天额度、剩余提前重置次数及账号状态 |
| ZenMux PAYG | 按量 Key（提示 `sk-payg-…`） | `sk-mgmt-…`，读取 PAYG 余额 |

至少登录一个推理入口。只用 Builder 时可以跳过 PAYG 登录，只用 PAYG 时可以跳过 Builder 登录。先在 Magpie 输入可选的 Platform Key，再填写推理 Key 并提交。两个字段都使用密码框，登录在 Magpie 内完成。前缀是输入提示，插件依据输入项区分用途，服务端负责认证。每个登录项的 Platform Key 由 Magpie 随该项保存。配额或余额查询失败时，Usage 页面会显示原因。

Builder 的模型列表取 ZenMux 推理目录和实际套餐的交集，包括套餐目录里的限时模型。跳过 Platform Key 时，只展示付费 Builder 套餐共有的模型。套餐目录查询失败时会报告错误。PAYG 使用 ZenMux 的推理模型目录。

如果当前 Magpie 在 PAYG 行显示「套餐」，可以在 **ZenMux PAYG → 编辑 → 高级 → 计费** 选择 **按量付费** 后保存。

## Extra Usage 和路由

在 **ZenMux Builder Plan → 编辑 → 插件选项** 里设置 **由 ZenMux 处理 Extra Usage**。请与 [ZenMux 订阅控制台](https://zenmux.ai/platform/subscription) 的 Extra Usage 状态保持一致。Magpie 中的开关只改变本地路由行为。路由组顺序、条件规则、会话设置和用户设置的用量上限仍由 Magpie 执行。

- **开启**时，Magpie 仍能读取额度，Builder 用完额度后仍是可选项。如果 Magpie 选中 Builder，ZenMux 会用同一个 Sub Key 处理超额计费。要在 ZenMux 控制台为 Extra Usage 关联 PAYG Key。
- **关闭**时（默认），Magpie 可根据 Builder 的额度做路由。要用 Magpie 做 PAYG 兜底，请登录两个供应商，创建一个顺序路由组，把 Builder 模型放前面、PAYG 模型放后面，并在客户端选择该路由组。跳过 Platform Key 时，Magpie 无法预知剩余额度，仍可在上游返回额度耗尽错误后尝试下一项。

插件按 ZenMux 目录声明每个模型支持的协议。请求可以经 OpenAI Responses、OpenAI Chat Completions、Anthropic Messages 或 Gemini Vertex 原生转发，流式响应直接传回 Magpie。公开目录临时不可用时，以 OpenAI 兼容模型列表提供 Chat Completions。当前目录针对文本对话模型，带图片输入的对话模型也可列出。

凭证只随对应请求发给 `https://zenmux.ai`。推理、额度和余额使用各自的 API，带凭证的请求禁用 HTTP 重定向。插件没有运行时第三方依赖。可用 Node.js 22 或更新版本运行 `npm test`。

## English

Enter `github:Alcatraz-Zhang/magpie-zenmux-platform` in Magpie → Plugins → Discover. Sign in to **ZenMux Builder Plan** with a subscription key or **ZenMux PAYG** with a pay-as-you-go key. Add an optional Platform Key for quota, resets, account status or balance. Builder uses the intersection of paid plans when the key is omitted. Match the Builder provider’s Extra Usage toggle to the ZenMux console. Turn it on for ZenMux-managed overage using the original subscription key. Turn it off to let a Magpie routing group use Builder quota and fall back to PAYG.

[Magpie plugin documentation](https://usemagpie.ai/docs/plugins) · [ZenMux Platform API](https://zenmux.ai/docs/api/platform/subscription-detail.html) · [ZenMux Extra Usage](https://zenmux.ai/docs/guide/subscription.html#extra-usage-automatic-overage-switching)

The plugin uses Magpie's documented provider hooks. [NieiR/magpie-zenmux](https://github.com/NieiR/magpie-zenmux) and [DylanLIiii/magpie-zenmux](https://github.com/DylanLIiii/magpie-zenmux) were used as references for ZenMux behavior.

The ZenMux icon comes from DylanLIiii’s plugin. Its MIT notice is included in [assets/LICENSE](assets/LICENSE). [Original SVG](https://github.com/DylanLIiii/magpie-zenmux/blob/3c3f017/logo.svg)
