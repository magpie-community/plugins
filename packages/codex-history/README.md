# @magpie-community/middleware-codex-history

**Magpie 原生历史过滤插件 / Native history compatibility middleware**

缓解 Codex 切换供应商、账号或上游资源后，旧会话出现密文验证失败、部分历史 item ID 不属于当前资源的问题。只处理发出的 Responses 请求，不修改原会话文件或 Codex `base_url`。

**插件只提供历史过滤，不包含 ModelTrace、降智检测或模型保护。** 无独立后台服务、管理端口、运行时依赖或额外模型请求。规则默认全部关闭，在 Magpie 自带的插件 Options 中按供应商设置。

## 安装

在 Magpie 的 **Plugins → Discover → Gateway middleware** 中安装 **Codex History Filter**，或使用命令行：

```sh
magpie plugin add @magpie-community/middleware-codex-history
```

也可从 [独立 GitHub 仓库](https://github.com/unisong/magpie-codex-history-filter) 安装同一份过滤代码。无需启动 Codex Filter Manager，不要同时安装两份。需要支持 gateway middleware 的 Magpie；本包已在 0.1.1265 的隔离实例中验证，其他版本需核对插件加载状态。

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
- `historyFilter: true` 开启过滤；`false`、删除该规则或空配置均为直通。不同会话按各自请求独立处理，可同时过滤多个供应商。
- `preserveEncryptedInclude: true` 保留客户端对**新响应**中 `reasoning.encrypted_content` 的请求，推荐开启。它不会保留**旧历史**中的密文。省略或设置为 `false` 会移除这一 include 值，不影响其他 include 项。
- 供应商改名后，旧会话可能仍发送旧前缀；可设置 `"aliases": {"old-demo": "demo"}`。别名只用于选择过滤规则，不改写请求模型，也不替代 Magpie 自己的路由别名。
- 无 `供应商/模型` 前缀或非 Responses 协议的请求保持原样。未配置的供应商不会被自动过滤。

保存 Options 后，Magpie 在后续请求加载规则。无需另开网页或重启 Codex；是否成功加载以 Magpie 插件页的错误与调用统计为准。

## 原理与边界

开启后，插件移除旧 reasoning 条目、明确标记的加密内容，以及可独立携带内容的消息和工具条目中的可选服务器 ID；设置 `store: false`。保留正文、工具参数、结果、`call_id` 配对、文件引用及普通业务 ID，不改变请求模型或推理强度。

`previous_response_id`、`conversation`、`item_reference`、加密压缩历史和 `/responses/compact` 无法安全跨资源迁移时，会明确拒绝，提示整理文字摘要后新建会话，不会静默丢弃这些上下文。

- 不能解密旧密文、迁移所有服务器资源引用，或保证消除全部 Azure 历史错误。移除内部推理状态也可能影响长任务连续性。
- Magpie 请求钩子限时 250 毫秒；加载失败、异常或超时可能按 Magpie 的机制放行原请求。插件不是强制安全边界。
- 只覆盖进入 Magpie agent middleware 的 Responses 请求；Magpie 自身的标题、分类器等内部请求不经过此钩子。WebSocket、Chat Completions、Lite HTTP 标头修改不在本插件范围内。
- 规则按进入钩子时的模型前缀选择。自动路由组、fallback、其他插件随后改写路由时，不保证规则对应最终上游。
- 不采集或保存凭据、请求正文，不执行检测、重试或模型调用。上游正常请求仍按上游规则计费。

## 停用、升级与旧版迁移

在 Magpie 插件页关闭本插件即可停止全部过滤；删除某条供应商规则只停用该供应商。卸载也在 Magpie 中完成，不需要恢复 `base_url`。通过本地路径安装时，移动或删除目录前先卸载旧插件。

若此前使用 Codex Filter Manager v1.0.5 自动安装的本地 `magpie-plugin`，先在旧管理页关闭该供应商的自动保护（若有旧设置），停止旧管理服务，再在 Magpie 中停用或卸载旧的本地历史插件，最后安装本插件并复制所需历史规则。原有规则的 `stripResponsesLiteHeader` 会被忽略，可删除。不要同时启用两份历史过滤插件。

升级固定 GitHub 标签时，在 Magpie 中用新标签地址更新；现有配置存于 Magpie 的 `plugins.json`，更新前可备份自己的 Options。不要上传该文件，它可能包含其他插件的私有设置。

## English

Opt-in Magpie gateway middleware for Codex Responses history after switching providers or accounts. It strips old reasoning/encrypted items and optional server IDs from portable history, preserving readable content and tool-call pairing. **History filtering only: no model detector, guard, background server, credentials or extra upstream calls.**

Install from **Plugins → Discover → Gateway middleware**, or run `magpie plugin add @magpie-community/middleware-codex-history`. In the plugin's **Options**, configure `providers["magpie:<provider-id>"]` as shown above. Every provider defaults to passthrough. The request's `provider/model` prefix selects its rule; requests from different sessions remain independent. `aliases` maps an old prefix to a rule ID only. `preserveEncryptedInclude: true` keeps requests for new encrypted response content while still removing historical ciphertext.

Unsafe server-only references and encrypted compaction are rejected explicitly. Magpie may fail open on plugin errors/timeouts, and downstream route changes are outside the plugin's control. Disable or remove it in Magpie; it never edits Codex configuration.

## 开发与来源

```sh
bun test packages/codex-history
```

测试只使用本地虚构数据，不调用模型。核心代码来自 [Codex Filter Manager v1.0.5](https://github.com/unisong/codex-filter-manager/tree/v1.0.5)，来源和 SHA-256 记录于 [PROVENANCE.json](PROVENANCE.json)。为匹配社区 middleware 包格式，将共用算法与请求钩子合并为单个无 import 文件。

接口参考：[Magpie middleware 文档](https://usemagpie.ai/docs/plugins#middleware)。

MIT，保留原项目贡献者署名，见 [LICENSE](LICENSE)。
