# Codex History Filter

**Magpie 原生过滤中间件 · MIT**

缓解 Codex 切换供应商、账号或上游资源后，旧会话出现加密验证、历史条目依赖及 DeepSeek 工具 Schema 错误。规则按供应商独立配置，默认全部关闭。无 UI、工作台、模型监测、额外模型请求或独立后台；不修改 Codex `base_url` 与会话文件。

## 安装

在 Magpie 官方社区插件市场 **Plugins → Discover → Gateway middleware** 搜索 **Codex History Filter**，或执行：

```sh
magpie plugin add @magpie-community/middleware-codex-history
```

市场版本以 Magpie 插件页显示为准；社区包合并分发后会自动更新。GitHub 的同版本标签与社区包安装文件一致，市场尚未分发某个版本时，可以按标签安装：

```sh
magpie plugin add github:unisong/magpie-codex-history-filter#v0.1.2
```

需要 Magpie 实际支持 gateway middleware 和 `onProvider` 钩子；版本号本身不作为安装限制。完整本地工作台在[主仓库](https://github.com/unisong/codex-filter-manager)维护，请只启用一份过滤插件。

## 设置

打开 **Plugins → Installed → Codex History Filter → Options**。下面的 `demo`、`deepseek-demo` 是虚构 ID，请替换成自己的供应商 ID：

```json
{
  "providers": {
    "magpie:demo": {
      "historyFilter": true,
      "preserveEncryptedInclude": true
    },
    "magpie:deepseek-demo": {
      "historyFilter": false,
      "deepSeekObjectRoot": true
    }
  },
  "aliases": {}
}
```

| 选项 | 作用与建议 |
| --- | --- |
| `historyFilter` | 清理 Responses 请求的旧推理、协议密文及可移植条目 ID。旧会话出现密文或跨资源错误时开启。 |
| `preserveEncryptedInclude` | 仅在 `historyFilter` 开启时生效。保留客户端对**新响应**的 `reasoning.encrypted_content` 请求，通常建议为 `true`；不会保留旧历史密文。省略或 `false` 会移除该 include 项。 |
| `deepSeekObjectRoot` | 针对 DeepSeek 的协议转码兼容；严格 DeepSeek 上游拒绝 `automation_update` 根联合 Schema 时开启。独立于历史过滤，仅显式 `true` 生效。 |

历史规则按请求的 `供应商/模型` 前缀匹配；DeepSeek 兼容按 Magpie 本次候选供应商及实际模型匹配。不同会话可同时使用不同规则。旧前缀可通过 `"aliases": {"old-demo": "demo"}` 映射到规则 ID；不会改写请求模型或替代 Magpie 路由。

保存后后续请求使用新规则，无需重启 Codex。请在 Magpie 插件页查看调用统计和加载错误；停用插件或把对应开关改为 `false` 即可关闭。

## 能缓解哪些错误，如何处理

| 上游错误 | 处理原理 |
| --- | --- |
| `encrypted content hydration failed` / `The encrypted content ... could not be verified` | 移除历史 `reasoning` 和明确标记为 `type: "encrypted_content"` 的嵌套协议块，保留可读正文和工具配对。 |
| `The requested item was created under a different Azure OpenAI resource` | 清除可独立重放的消息、工具历史的服务器 `id`，保留 `call_id`、业务资源引用及正文。无法恢复的服务器上下文会明确拒绝。 |
| `web_search_call ... was provided without its required reasoning item` | 将旧搜索条目转换为带说明的助手文字，保留已记录查询、动作、状态和来源；去掉服务器 ID 和内部回合信息。不重搜、不补造结果。 |
| 工具 Schema 根类型错误（`type: null`、`schema must be ... object`） | `onProvider` 钩子只对已开启的 DeepSeek 候选供应商，把 `automation_update` 根 `anyOf` / `oneOf` / `allOf` 折叠为对象；同时处理顶层 `tools`、`tool_search_output.tools` 和 `additional_tools.tools`。 |

这些上游错误有时仅在 Codex 中显示为 `stream disconnected before completion: response.failed event received`。插件通过修正**引发失败的请求内容**缓解相关断流；它不拦截或伪造失败事件，也不是对所有网络断流的通用修复。遇到此消息，应同时查看上游具体错误，选择对应开关。

Schema 折叠保留属性、局部 `$defs` 与共有必填字段，但会放宽根联合分支之间的互斥约束，实际执行仍由工具校验输入。只适用于已经出现兼容错误的 DeepSeek 上游，不修改其他工具的 Schema 或普通工具结果。

## 边界与隐私

- 历史过滤仅覆盖进入请求钩子的 Responses；DeepSeek Schema 钩子可用于 Magpie 后续向上游转发 Responses 或 Chat Completions 的候选尝试。标题、分类器等宿主内部请求不保证经过这些钩子。
- `previous_response_id`、`conversation`、`item_reference`、加密压缩历史与 `/responses/compact` 无法安全迁移时明确拒绝；不解密、不静默删掉上下文。必要时整理明文摘要后开新会话。
- 历史过滤在路由前按模型前缀匹配，组路由、fallback 或其他插件后续改写可能影响对应关系。DeepSeek Schema 在候选供应商阶段匹配，未开启的其他候选保持原样。
- 插件错误或执行超时可能由宿主放行原请求；运行状态以 Magpie 插件页为准。它不能修复余额、限流、网络、认证问题或所有原生工具的推理依赖。
- 不记录凭据和对话、不执行检测或重试，不产生额外模型请求。移除旧推理状态可能影响长任务连续性。

## 开发

```sh
node --test test/*.test.mjs web-search.test.mjs
npm pack --ignore-scripts --dry-run
```

社区仓库中运行 `bun test packages/codex-history`。测试只使用虚构数据。安装包只含 `package.json`、中间件、README、LICENSE 和 PROVENANCE，后续 GitHub 与社区提交均使用相同版本和文件。

## 许可与致谢

本项目采用 [MIT](LICENSE)，保留原项目贡献者署名。感谢以下参考项目：

- [Codex Filter Manager](https://github.com/unisong/codex-filter-manager)：共享历史过滤与 DeepSeek Schema 兼容实现；本包不包含其模型检测组件。
- [Responses 历史回放补丁](https://github.com/yunhanhai/agentrouter-responses-shim-sentry-fix)：嵌套协议密文清理场景及回归测试参考。
- [Magpie](https://github.com/yetone/magpie) 与[社区插件仓库](https://github.com/magpie-community/plugins)：中间件接口、候选供应商钩子及分发方式参考。

接口文档：[Magpie middleware](https://usemagpie.ai/docs/plugins#middleware)。来源记录见 [PROVENANCE.json](PROVENANCE.json)。

## English

Opt-in Magpie middleware for Codex history compatibility, with independent per-provider DeepSeek tool-schema conversion. It removes protocol ciphertext and portable server IDs, turns recorded native web search history into text, and folds only `automation_update` root unions for explicitly enabled DeepSeek candidates. Top-level and resumed tool declarations are covered. No UI, probes, credentials, background server, or Codex configuration edits.

`response.failed event received` is a generic client symptom: this package addresses the documented request compatibility causes, not every streaming or network failure. Defaults are off. Install it from Magpie's community market; each GitHub version tag holds the same install files, for use before the market distributes that version.
