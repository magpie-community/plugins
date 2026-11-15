# 腾讯 Marvis Plus · magpie 供应商插件

[![Release](https://img.shields.io/github/v/release/BangShou1st/magpie-marvis-plus?label=release)](https://github.com/BangShou1st/magpie-marvis-plus/releases)
[![License](https://img.shields.io/github/license/BangShou1st/magpie-marvis-plus)](https://github.com/BangShou1st/magpie-marvis-plus/blob/main/LICENSE)
[![Tests](https://img.shields.io/github/actions/workflow/status/BangShou1st/magpie-marvis-plus/ci.yml?label=tests)](https://github.com/BangShou1st/magpie-marvis-plus/actions)

把**腾讯 Marvis**（应用宝 AI 助手）背后的模型接进 [magpie](https://usemagpie.ai)：
不用 API key，用 QQ / 微信登录，直接使用 DeepSeek、Claude、GPT-5.4、Hy3 等模型。

> 非官方插件。Marvis 是腾讯的产品，本插件只是把它的模型网关接到 magpie，与腾讯无关。
>
> 独立维护 fork：基于 [MYCF711/magpie-marvis](https://github.com/MYCF711/magpie-marvis)（MIT）。
> provider id 保持 `marvis`，与上游插件互斥，安装其一。仅通过 GitHub 分发，不发布 npm。

## 为什么用 Plus

- **GPT-6 Codex 身份句自动归一**：把 `Codex, an agent based on GPT-6` 归一成
  `Codex — an agent based on GPT-6`，覆盖空格、Unicode 连字符和全角变体
- **403 内容过滤兜底**：命中 `403 + 非法请求` 时，在 system 最前面插入兼容前言并重试一次；
  原 prompt、工具定义和历史消息一个字不删
- **真实提示词回归**：覆盖 OpenAI Codex、Claude Code、DSH、Cursor、Windsurf、Devin、
  Replit、Trae、Kiro、Qoder、Warp、VS Code、CodeBuddy、Augment、Manus、Perplexity 等

## 模型

| 模型 | 说明 |
|---|---|
| DeepSeek V4.1 Flash | 主路由 + 防降级路由，两条都支持识图 |
| DeepSeek V4 Flash | 快速推理 |
| Hy3 | 腾讯混元 |
| Claude Sonnet 4.6 | Anthropic |
| Claude Opus 4.6 | Anthropic |
| GPT-5.4 | OpenAI |
| HY-Vision 2.0 instruct | 识图 |

共 8 个模型。推理挡位、流式输出、`reasoning_content`、function calling 都保留。

## 安装

```bash
magpie plugin add BangShou1st/magpie-marvis-plus
```

这是 GitHub 安装方式，不依赖 npm。安装后在 magpie 设置里打开
**供应商 → 添加 → 腾讯 Marvis Plus**，选择登录方式。

仓库打了 `magpie-plugin` topic 后，会出现在 magpie
**插件 → 发现 → 非官方插件 · GitHub**。GitHub 会排除 fork，所以本仓库是独立仓库，不是 fork。

## 反馈与支持

Plus 的问题追踪和反馈统一走
[GitHub Issues](https://github.com/BangShou1st/magpie-marvis-plus/issues)。协议变化、登录失败、
403 内容过滤或模型异常都可以附上脱敏后的请求时间和错误码；不要在 Issue 里粘贴 token、
Cookie、openid 或完整登录回调。

安全问题或凭据泄露请按 [SECURITY.md](./SECURITY.md) 私密报告，不要先开公开 Issue。
维护由个人在空闲时间处理，不承诺实时响应；通常优先处理登录中断、请求全量和协议回归。

## 登录

- **QQ 登录 / 微信登录**：自动打开隔离浏览器窗口，授权完成后窗口自动关闭
- **从本机 Marvis 导入**：本机装了 Marvis 客户端并登录过时，一条命令读取登录态（仅 Windows）
- **粘贴回调地址**：magpie 跑在 NAS、容器或远程服务器时用；在自己的浏览器登录后，把
  `…marvis_oauth?login_type=…&code=…&state=…` 整条地址粘贴回来

## 额度

Marvis 免费账号每天 **1000 万计费 token**：

```text
计费 token = 缓存读取 × 0 + (输入 + 输出) × 0.5
```

缓存命中免费，输入输出五折。实际可用量通常是计费额度的 2～5 倍。额度耗尽后上游回 403，
magpie 会按路由策略切换账号，不会封号。

## 与上游的关系

- 上游：`MYCF711/magpie-marvis`
- 本仓库：`BangShou1st/magpie-marvis-plus`
- provider id：仍为 `marvis`，因此登录态、`marvis/...` 模型名和现有路由可以直接复用
- 与上游插件**互斥**：两个插件注册同一个 provider，安装其中一个即可
- npm：不使用；版本通过 GitHub tag / Release 分发
- 完整归属与分叉说明：[UPSTREAM.md](./UPSTREAM.md)

## 已知边界

- 非官方插件，Marvis 协议可能随时变化
- 登录态通常 30 天；`refresh` 会成对轮换 token，插件已串行化刷新
- 从本机 Marvis 导入仅在 Windows 可用
- 兼容前言兜底只处理 system 首行的产品身份过滤；上游如果改变过滤位置，仍需再适配

## 开发

```bash
node scripts/check.mjs   # 合规检查
node --test              # 语义测试
```

开发与提交流程见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 许可

MIT。详见 [LICENSE](./LICENSE)，归属说明见 [NOTICE.md](./NOTICE.md)。
