# Magpie Factory Identity

A Magpie gateway middleware that rewrites OMP's default identity sentence only in system/developer instructions for the `factory` provider. It preserves other prompt content and does not change user messages or tool results.

这个中间件在 Magpie 选定 Factory 上游后，将 OMP 默认的开头身份声明替换为：

```text
You are droid's trusted coding assistant.
```

Engineering、Personality、Tone、工具策略和工作流程等其余内容保持原样。插件在使用者自己的 Magpie 网关内运行，没有运行时依赖，也不发起网络请求。使用者需要自行配置 Factory 提供商和账号。

## 安装

需要支持 `onProvider` 中间件钩子的 Magpie；已有使用反馈的版本为 `v0.1.4402`。

在 Magpie Web 或桌面应用的插件页，手动添加：

```text
github:HarryWang29/magpie-factory-identity
```

也可以使用命令行：

```sh
magpie plugin add github:HarryWang29/magpie-factory-identity
```

已有本地单文件版本时，先停用旧条目，再安装仓库版本，避免同时维护两个副本。

## 处理范围

- 仅匹配实际选中的 provider ID `factory`，因此也适用于最终选择 Factory 的路由组请求。
- 支持 Anthropic Messages、OpenAI Chat Completions、OpenAI Responses 和 Gemini 的系统指令字段。
- OpenAI 消息数组中，仅处理 `system` 和 `developer` 消息，包括这些角色出现在历史数组中的情况。
- 保留用户、助手、工具结果、工具定义、缓存标记和推理签名。
- 在上述指令字段中替换源码里定义的完整句子，命中的每一处都会替换；未命中时保持请求不变。

`onProvider` 接收到的仍是客户端协议格式。Magpie 为每次上游尝试提供独立的请求，因此对 Factory 的改写不会传播到其他 provider 的尝试。

## 验证与限制

已有 12 组本地 JSON 转换检查通过，覆盖协议格式、Factory 范围、历史内容保留、原请求不变和重复调用。Factory 的接受结果取决于上游当时的规则，不能保证解决所有 `content_policy_rejected`。

验证时使用 OMP 默认提示词和全新会话，先发送普通消息，再完成一次只读工具调用。若检查请求正文，应查看 Magpie 发往 Factory 的请求；OMP 发往 Magpie 的入站正文仍会保留原句。

本插件不清理用户消息、助手回复或工具输出历史里的引用，也不处理其他客户端的身份声明。旧请求日志或源码中的触发文本进入这些历史内容后，仍可能被上游拒绝；不能将本插件视为全量历史替换工具。

背景讨论：[oh-my-pi #19553](https://github.com/can1357/oh-my-pi/issues/19553)。本项目独立维护，与 Factory、Magpie 官方及 OMP 官方无隶属关系。

## 发布这个仓库

将 `package.json`、`factory-identity.middleware.mjs`、`README.md` 和 `LICENSE` 放在公开仓库根目录。纯中间件通过 `magpie.middleware` 声明入口，无需添加 `main`、`exports` 或构建步骤。

在 GitHub 仓库的 About 中添加 topic `magpie-plugin`，Magpie 的“发现 → 非官方插件 · GitHub”即可按其发现规则检索这个仓库。首次检索有缓存延迟。

若使用不同的 GitHub 用户名或仓库名，请同步修改 `package.json` 的 `repository.url` 及本文件的安装地址。

参考：[Magpie 发布与上架文档](https://usemagpie.ai/docs/zh/plugins#publish)。

## 许可证

[MIT](LICENSE)
