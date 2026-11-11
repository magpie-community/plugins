# Magpie Session Patcher

Magpie 原生出站历史处理插件。**仅处理发给模型的请求，不读写本地会话，不改当前模型输出。**

Opt-in Magpie gateway middleware for outbound assistant history. No filesystem access, model calls, credentials, live reply rewriting, or automatic retries.

## 安装

在 Magpie 的 **Plugins → Discover → Unofficial, on GitHub** 搜索 `magpie-session-patcher` 或 `session patcher`。

也可以直接安装：

```sh
magpie plugin add github:sdloghub/magpie-session-patcher
```

这是 GitHub 分发的插件，尚未发布到 npm 或官方社区列表。根目录内的 `private: true` 防止意外发布 npm 包，不影响从 GitHub 安装。

**默认关闭。** 安装后打开本插件的 **Options**，保存：

```json
{
  "enabled": true,
  "replaceRefusals": true,
  "cleanReasoning": false,
  "appendPrompt": "",
  "detection": "conservative",
  "agents": [],
  "models": []
}
```

只对原本经过 Magpie 的请求生效；无需更改客户端连接设置。设置 `enabled: false` 或停用插件即可恢复直通。

## 功能

- 用明确标记替换历史助手拒绝文字；可自定义关键词和替换内容。
- 可选清理旧推理；存在工具调用依赖、签名或不可见服务器历史时保守跳过。
- 可选追加自定义系统提示词，保留原有指令。
- 支持 Responses、Chat Completions、Anthropic Messages、Gemini；可按客户端与模型前缀限定范围。

用户输入、工具参数、工具结果、工具配对、模型与推理预算保持原样。替换标记不表示模型已经执行任何工作。规则是启发式检测，存在误判或漏判可能。

详细选项、协议边界、安装方式与验证记录见 **[MAGPIE.md](MAGPIE.md)**。

## 自查与测试

```sh
npm test
npm pack --dry-run
```

`npm test` 不安装依赖、不连接模型。真实 Magpie 与本机模拟上游的复验脚本为 `scripts/magpie-smoke.mjs`；不会使用真实模型账号。

## 来源

从 [sdloghub/codex-session-patcher-magpie](https://github.com/sdloghub/codex-session-patcher-magpie) 提取插件部分，历史拒绝短语来源于 [ryfineZ/codex-session-patcher](https://github.com/ryfineZ/codex-session-patcher)。来源快照、权利归属与适配说明见 [NOTICE](NOTICE) 和 [LICENSE](LICENSE)。

原 Python / Web 工具说明保留在 [docs/UPSTREAM_README.md](docs/UPSTREAM_README.md)。插件独立仓库仅包含适配层；原 fork 仓库保留完整 Python / Web 工具。
