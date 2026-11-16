# magpie-strip-harness

一个 [magpie](https://usemagpie.ai) 请求中间件：在请求路由前，按明确配置谨慎清理受支持协议中的 harness 身份提示。只修改请求，不处理回复或流事件。

## 配置

随包规则位于 `package.json` 的 `magpie.options.rules`。规则采用有版本号、按顺序执行的统一结构：

```json
{
  "rules": {
    "version": 1,
    "rules": [
      {
        "id": "agent.identity-opening",
        "roles": ["system"],
        "unit": "line",
        "match": {
          "type": "regex",
          "value": "^\\s*You are ExampleAgent, an interactive agent\\.?\\s*$",
          "flags": "i"
        },
        "action": { "type": "delete" }
      }
    ]
  }
}
```

每条规则显式声明 `id`、`roles`、`unit`、`match` 和 `action`。匹配类型为 `exact`、`contains`、`regex`。正则 flags 仅接受 `i`、`m`、`s`、`u`；会引入状态行为的 `g`、`y` 不接受。规则严格按配置顺序执行，前一条替换后的文本可供后续规则匹配。

匹配单位为 `span`、`line`、`block`、`target`。`delete` / `replace` 只作用于声明的单位；只有 `target` 规则可以使用 `drop-target` 删除整个逻辑 system 目标。没有段落降级、隐式扩大范围或全局 `stripAll` 覆盖。文本块边界会保留；只有显式的 target 规则才会合并检查多个文本片段。非文本块及其元数据不参与匹配并保持原样。

随包默认规则中，ZCode 部分依据 `example/` 中的 ZCode 请求样本；Codex CLI 部分依据 `example/` 中的 CodexCli 请求样本；Pi 部分依据 `example/` 中的 Pi 请求样本；DSH 部分只删除已知的 DSH 身份开场行，不依赖样本文件。默认规则只处理精确、高置信度的身份内容：DSH/ZCode 删除 system 消息中的身份开场行，ZCode 规则还将 `# ZCode Desktop Context` 改为 `# Desktop Context`；Codex CLI 把 developer 消息中的两条身份开场行替换为去品牌通用表述，去掉 `As Codex, you are` 前缀，并删除身份行移除后失去指代对象的 `Within this context, Codex refers to...` 说明行；Pi 把 developer 消息中的身份开场行替换为去品牌表述（去掉 `running inside pi, a coding agent harness`）。样本中的有效工具/安全指令、工作目录、`window.zcode` API、pi 的 `PI_*` 环境变量与 `<docs>` 文档指引会保留；正文中的路径、工具名、API token 等功能性提及不会单独触发删除。只有确认对应内容确实由 harness 注入且不影响指令功能时，才应添加范围明确的规则。

`rules: { "version": 1, "rules": [] }` 表示禁用清理；未提供规则也不处理。随包默认规则由 magpie 通过 `magpie.options` 注入。配置无效时，开启 `debug` 会记录错误，请求保持不变；程序不会静默回退到更宽泛的规则。

## 协议

中间件通过 `ctx.protocol` 选择唯一适配器。未知协议保持不变。

| 协议 | 处理目标 |
| --- | --- |
| `chat` | `messages[]` 中的 system/developer 消息 |
| `anthropic` | `system` 字符串或文本 blocks |
| `responses` | `instructions` 及 `input[]` 中的 system/developer 项 |
| `gemini` | `systemInstruction` / `system_instruction` 字符串或 parts |

规则通过 `roles` 限定角色。默认规则中 DSH/ZCode 处理 `system`；Codex CLI 和 Pi 规则处理 `developer`（两者都将身份提示注入 developer 消息），其余 `developer` 内容仍需显式规则才处理。未修改的消息、字段、block 和非文本内容都会保留。经显式删除后变空的目标会按各自协议结构移除。

## 安装与验证

```sh
git clone https://github.com/aqiu817/magpie-strip-harness.git
magpie plugin add ./magpie-strip-harness
node test.mjs
```

在插件选项中设置 `debug: true`，可记录配置错误和规则修改摘要。仍需在真实 magpie 网关环境验证，因为本地 Node 测试不能证明运行时 `ctx.protocol` 与 options 注入形状。

## 边界

- 文本匹配无法证明内容来源。优先使用完整、高置信度的身份声明，不要把产品名或 token 的出现本身当作删除依据。
- `span` 和 `line` 只在单个文本片段中匹配。`target` 检测时会用换行符连接目标的文本片段，应仅用于明确的整目标删除。
- 正则长度有限制，并拒绝有状态 flags；管理员仍应避免不必要的复杂正则。
- 修改 system/developer 提示可能导致供应商侧提示缓存对该请求失效。
