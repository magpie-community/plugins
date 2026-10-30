# @magpie-community/middleware-codex-history

**Magpie 原生历史过滤插件 / Native history compatibility middleware**

缓解 Codex 切换供应商、账号或上游资源后，旧会话出现密文验证失败、部分历史 item ID 不属于当前资源的问题。只处理发出的 Responses 请求，不修改原会话文件或 Codex `base_url`。

**插件只提供历史过滤，不包含 ModelTrace、降智检测或模型保护。** 无独立后台服务、管理端口、运行时依赖或额外模型请求。规则默认全部关闭，在 Magpie 自带的插件 Options 中按供应商设置。

## 安装

在 Magpie 的 **Plugins → Discover → Gateway middleware** 中安装 **Codex History Filter**，或使用命令行：

```sh
magpie plugin add @magpie-community/middleware-codex-history
```

社区版本只发布历史过滤中间件；模型工作台单独本地维护，不包含在本包中。无需启动 Codex Filter Manager，不要同时启用两份过滤插件。需要支持 gateway middleware 及 `onProvider` 钩子的 Magpie；v0.1.2 已在 0.1.2131 的隔离实例中验证，其他版本需核对插件加载状态。

## 设置

打开 **Plugins → Installed → 本插件 → Options**，保存以下示例，替换 `demo` 和 `backup` 为你实际使用的 Magpie 供应商 ID：

```json
{
  "providers": {
    "magpie:demo": {
      "historyFilter": true,
      "preserveEncryptedInclude": true
    },
    "magpie:backup": {
      "historyFilter": false,
      "preserveEncryptedInclude": true
    }
  },
  "aliases": {}
}
```

- 请求模型为 `demo/gpt-6-astra` 时，使用 `magpie:demo` 的规则；ID 是模型前缀，不是供应商显示名称。
- 通过 Magpie 路由组或 fallback 发出的请求（模型名是分组），在每次实际尝试某个供应商时，按该供应商 ID 的规则过滤。不需要、也不应该为路由组单独建规则。
- `historyFilter: true` 开启过滤；`false`、删除该规则或空配置均为直通。不同会话按各自请求独立处理，可同时过滤多个供应商。
- `preserveEncryptedInclude: true` 保留客户端对**新响应**中 `reasoning.encrypted_content` 的请求，推荐开启。它不会保留**旧历史**中的密文。省略或设置为 `false` 会移除这一 include 值，不影响其他 include 项。
- 供应商改名后，旧会话可能仍发送旧前缀；可设置 `"aliases": {"old-demo": "demo"}`。别名同样作用于路由组中实际尝试的供应商 ID，只用于选择过滤规则，不改写请求模型，也不替代 Magpie 自己的路由别名。
- 无 `供应商/模型` 前缀或非 Responses 协议的请求保持原样。未配置的供应商不会被自动过滤。

保存 Options 后，Magpie 在后续请求加载规则。无需另开网页或重启 Codex；是否成功加载以 Magpie 插件页的错误统计为准。插件页的调用次数统计每次钩子调用：每个 Responses 请求经过 `onRequest`，每次供应商尝试经过 `onProvider`，没有命中规则、原样放行的请求也会计入，它不表示过滤次数。

## 原理与边界

开启后，插件移除旧 reasoning 条目、明确标记的加密内容，以及可独立携带内容的消息和工具条目中的可选服务器 ID；设置 `store: false`。保留正文、工具参数、结果、`call_id` 配对、文件引用及普通业务 ID，不改变请求模型或推理强度。

**v0.1.1：历史搜索兼容修复。** 原生 `web_search_call` 可能依赖已删除的 reasoning，导致上游提示 `was provided without its required reasoning item`。开启过滤后，历史搜索条目转为带标记的助手文字，保留已记录的动作、查询、状态和来源数据，去除服务器条目 ID 与内部回合元数据；后续结论、引用及普通工具调用配对保持原样。不重新搜索、不补造未记录的结果。该处理适用于携带明文历史的普通对话和文字总结，不解密压缩历史。

**v0.1.2：路由组与 fallback 兼容修复。** 经 Magpie 路由组或 fallback 发出的请求，模型名是分组而不是供应商，路由前的前缀匹配找不到规则，旧密文和条目 ID 会原样发给已开启过滤的成员，上游返回 `created under a different Azure OpenAI resource` 等错误。现在 `onProvider` 在每次供应商尝试时按该供应商规则过滤；直接选择供应商的请求仍在 `onRequest` 过滤，并通过 `ctx.state` 标记，不会重复处理。

`previous_response_id`、`conversation`、`item_reference`、加密压缩历史和 `/responses/compact` 无法安全跨资源迁移时，会明确拒绝，提示整理文字摘要后新建会话，不会静默丢弃这些上下文。

- 不能解密旧密文、迁移所有服务器资源引用，或保证消除全部 Azure 历史错误。移除内部推理状态也可能影响长任务连续性。
- Magpie 请求钩子限时 250 毫秒；加载失败、异常或超时可能按 Magpie 的机制放行原请求。插件不是强制安全边界。
- 只覆盖进入 Magpie agent middleware 的 Responses 请求；Magpie 自身的标题、分类器等内部请求不经过此钩子。WebSocket、Chat Completions、Lite HTTP 标头修改不在本插件范围内。
- 直接选择供应商时按模型前缀选择规则；路由组和 fallback 按每次实际尝试的供应商选择。`onProvider` 不能拒绝请求，所以上述无法迁移的内容经路由组发出时只能原样发送，由上游报错；直接选择供应商时仍会被明确拒绝。其他插件若在本插件之后再改写请求，结果不受本插件控制。
- 不采集或保存凭据、请求正文，不执行检测、重试或模型调用。上游正常请求仍按上游规则计费。

## 停用、升级与旧版迁移

在 Magpie 插件页关闭本插件即可停止全部过滤；删除某条供应商规则只停用该供应商。卸载也在 Magpie 中完成，不需要恢复 `base_url`。通过本地路径安装时，移动或删除目录前先卸载旧插件。

若此前使用 Codex Filter Manager v1.0.5 自动安装的本地 `magpie-plugin`，先在旧管理页关闭该供应商的自动保护（若有旧设置），停止旧管理服务，再在 Magpie 中停用或卸载旧的本地历史插件，最后安装本插件并复制所需历史规则。原有规则的 `stripResponsesLiteHeader` 会被忽略，可删除。不要同时启用两份历史过滤插件。

社区版本合并并完成 dist 发布后，可在 Magpie 插件页更新；现有 Options 无需改写，更新前可自行备份。不要上传 Magpie 的 `plugins.json`，它可能包含其他插件的私有设置。本插件不直接读写该文件，规则由宿主通过 Options 传入。

## English

Opt-in Magpie gateway middleware for Codex Responses history after switching providers or accounts. It strips old reasoning/encrypted items and optional server IDs from portable history, preserving readable content and tool-call pairing. **History filtering only: no model detector, guard, background server, credentials or extra upstream calls.**

Install from **Plugins → Discover → Gateway middleware**, or run `magpie plugin add @magpie-community/middleware-codex-history`. In the plugin's **Options**, configure `providers["magpie:<provider-id>"]` as shown above. Every provider defaults to passthrough. A request to `provider/model` uses that prefix's rule. A request through a Magpie group or fallback is filtered on each provider try with the tried provider's rule, so a group needs no rule of its own. Requests from different sessions remain independent. `aliases` maps an old prefix or provider ID to a rule ID only. `preserveEncryptedInclude: true` keeps requests for new encrypted response content while still removing historical ciphertext.

Unsafe server-only references and encrypted compaction are rejected explicitly when a provider is chosen directly. A provider try can't be refused, so through a group they are sent as they were. Magpie may fail open on plugin errors/timeouts. The Plugins page counts every hook call, passed-through requests included, not filtered requests. Disable or remove it in Magpie; it never edits Codex configuration.

Version 0.1.1 converts historical native `web_search_call` items to labeled assistant text after removing old reasoning. Recorded actions, queries, status and sources remain available; native item IDs and internal turn metadata are removed. Subsequent answers and ordinary tool-call pairs remain intact. No searches are rerun, absent results are not reconstructed, and encrypted compaction is not decrypted. The community package contains only the middleware; the optional model workbench is maintained separately for local use.

Version 0.1.2 filters group and fallback requests on each provider try (`onProvider`). Before it, a request named after a group matched no rule, so old ciphertext and item IDs reached providers whose filter was on. A direct request filtered by `onRequest` is marked in `ctx.state` and isn't filtered again.

## 开发与来源

```sh
bun test packages/codex-history
```

测试只使用本地虚构数据，不调用模型。核心代码来自 [Codex Filter Manager](https://github.com/unisong/codex-filter-manager)（MIT），本包的镜像源码在 [magpie-codex-history-filter](https://github.com/unisong/magpie-codex-history-filter)，来源提交和 SHA-256 记录于 [PROVENANCE.json](PROVENANCE.json)。为匹配社区 middleware 包格式，将共用算法与请求钩子合并为单个无 import 文件。

接口参考：[Magpie middleware 文档](https://usemagpie.ai/docs/plugins#middleware)。

MIT，保留原项目贡献者署名，见 [LICENSE](LICENSE)。
