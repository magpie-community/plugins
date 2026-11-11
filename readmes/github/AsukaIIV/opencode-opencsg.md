# opencode-opencsg-auth

开放传神（OpenCSG / 传神社区）AI 网关的 provider 插件。按 [OpenCode v1 插件](https://opencode.ai/docs/plugins/)规范写成，magpie 可以直接加载，OpenCode 也能用。

- 供应商 `opencsg`，走 OpenAI 兼容的 chat completions
- 模型列表从 `GET /v1/models` **自动发现**，不用手写
- 支持自部署实例：登录时填自己的网关地址
- 401 标记为"需要重新登录"，403（地区风控）只退回内置列表，不误判

## 安装

magpie：

```bash
magpie plugin add github:AsukaIIV/opencode-opencsg
magpie plugin login opencsg          # 粘贴 API Key
magpie plugin                        # 应显示 opencsg（N models）signed in
magpie provider test opencsg
```

本地开发时直接加载文件夹：

```bash
magpie plugin add ./opencode-opencsg-auth
```

OpenCode：把包名加进 `opencode.json` 的 `plugin` 数组。

## 登录要准备什么

1. 在传神社区 → 设置 → **API Keys** 建一把网关 Key。
   注意不要用 Git 的 Access Token，两者不通用。
2. 网关地址：
   - 社区版默认 `https://ai.space.opencsg.com/v1`，登录时直接回车
   - 自部署实例填自己的，例如 `https://hub.example.com/v1`，不带 `/v1` 会自动补

Key 存在 magpie 的 `plugin-auth.json`（权限 600），插件不落盘、不打日志。

## 模型

`models` 钩子每次登录后拉一次 `/v1/models`，把返回的条目映射成 magpie 的模型：

| 返回字段 | 映射到 |
|---|---|
| `id` / `name` | 模型 id |
| `display_name` / `label` | 显示名 |
| `context_length` / `context_window` | 上下文上限 |
| `max_output_tokens` / `max_tokens` | 输出上限 |
| `modalities.input` | 输入模态 |

拿不到就退回 128k / 8k 的保守默认值。**模型以网关实际开通的为准**，没开通的模型即使出现在列表里，调用也会报错。

## 已知限制

- 社区网关对部分 IP 返回 `403 {"message":"blocked by secops"}`（APISIX 风控）。这时插件会保留内置列表并打一行日志，不会把供应商从界面上抹掉；换网络或走自部署实例即可。
- 只实现 chat completions。`/v1/responses`、embeddings、rerank 这些端点没有包进来。
- 没有 `usage` 钩子：网关文档里没有可查额度的接口，用量请在平台后台看。

## 开发

```bash
bun test        # 10 个用例，覆盖地址归一、config/loader/models 三个钩子
```

入口只有 `index.mjs`，辅助函数挂在 `_internal` 上——magpie 会把入口的每个导出函数都当插件调用，不能裸导出工具函数。

## 许可

MIT
