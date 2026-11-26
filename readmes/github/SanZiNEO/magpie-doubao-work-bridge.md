# magpie-doubao-work-bridge

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)](#兼容性与限制)

把豆包工作（Doubao Work）接进 Magpie，让 Claude Code、Codex、OpenCode 这类 Agent 直接把任务外包给本机的豆包或者豆包工作的 app：按工作区建项目、开会话、发任务、读回复，用量卡上还能看到这个账号的额度。

走反向代理去仿豆包工作自己的接口，要复刻的设备标识、风控和模型菜单太多，既麻烦又总有缺口，所以这里换了个方向：不代理模型请求，而是用账号自己的工具接口驱动真实会话。Magpie 侧只注册一个空模型目录，用哪个模型、哪个推理强度，由工具参数决定。

需要提前说明一点：普通账号的任务会排队。想要稳定的响应速度，通常需要开通豆包会员。

## 近期更新

> 完整记录见 [CHANGELOG.md](./CHANGELOG.md)，最新的在最上面。

- **首个版本**（`0.1.0`）。六个工具、按工作区建项目、按轮读消息、三种登录方式，以及带签到状态的用量卡。

## 目录

- [近期更新](#近期更新)
- [特性](#特性)
- [环境要求](#环境要求)
- [安装](#安装)
- [快速开始](#快速开始)
- [登录](#登录)
- [用量与签到](#用量与签到)
- [工具](#工具)
- [默认模型](#默认模型)
- [工作区与轮次](#工作区与轮次)
- [Magpie Library 指令](#magpie-library-指令)
- [配置](#配置)
- [项目结构](#项目结构)
- [开发与测试](#开发与测试)
- [兼容性与限制](#兼容性与限制)
- [常见问题](#常见问题)
- [参与贡献](#参与贡献)
- [许可证](#许可证)
- [相关项目](#相关项目)

## 特性

- **不代理模型请求。** Magpie 里的模型目录是空的，请求不会经过本插件转发到豆包；插件只做「派发任务 + 读回复」。
- **按工作区组织。** 一个工作区对应一个豆包项目，同一工作区下的多条任务各自成会话，可续聊也可新建。
- **按轮读取。** 每条发出的消息算一轮，概览只给双方预览，指定轮号才取完整原文，长会话可向前翻页。
- **原生用量卡。** 订阅额度、活动赠送额度、活动额度卡，以及每日签到状态，都显示在 Magpie 的 **用量 → 概览**。
- **三种登录方式。** 粘贴 Cookie、开临时浏览器窗口登录、直接读本机已登录的豆包工作客户端；凭据存进插件自己的保管库，之后与客户端解耦。
- **默认模型有兜底。** 未指定模型时用 `deepseek-v4.1-flash`，目录支持 `max` 时自动带上 `effort: "max"`。

## 环境要求

| 项 | 要求 |
| --- | --- |
| Magpie | 支持插件与 provider auth 的版本 |
| Node.js | `>= 20`（见 `package.json` 的 `engines`） |
| 豆包工作账号 | 已登录，且账号有可用额度 |
| 平台 | Windows / macOS 完整支持；Linux 仅支持粘贴 Cookie |

插件不依赖第三方运行时库，不需要构建，也不需要安装原生模块。

## 安装

从 GitHub 安装：

```sh
magpie plugin add github:SanZiNEO/magpie-doubao-work-bridge
```

在本地开发目录安装：

```sh
magpie plugin add ./magpie-doubao-work-bridge
```

装好后在 Magpie 的 Providers 列表里找到「豆包工作外包」这一行，点登录。

## 快速开始

```sh
# 1. 安装插件（二选一，见上一节）
magpie plugin add github:SanZiNEO/magpie-doubao-work-bridge

# 2. 登录豆包工作账号
magpie plugin login doubao-work-bridge

# 3. 确认额度能读到
magpie quota
```

`magpie quota` 能列出该账号的额度窗口，就说明登录和额度链路都通了。之后在 Magpie 的 **用量 → 概览** 里能看到同一张卡。

## 登录

支持三种方式：

| 方式 | 需要装客户端 | 说明 |
| --- | --- | --- |
| 粘贴豆包 Cookie | 不需要 | 在浏览器登录 `doubao.com`，从开发者工具复制完整 Cookie，最省事 |
| 用浏览器登录豆包（自动抓取） | 不需要 | 插件开一个带调试端口的临时窗口，你在里面登录后自动读走 Cookie，窗口随后关闭 |
| 从豆包工作客户端读取 | 需要 | 读本机已登录客户端的本地配置，数据目录留空会自动查找 |

Linux 上只显示「粘贴豆包 Cookie」：另外两项依赖 Windows / macOS 的浏览器和客户端安装路径，硬做只会点进去才失败。

登录成功后，凭据写入插件自己的保管库（Windows 用 DPAPI，其他平台用本地 key + AES-256-GCM），之后客户端退出登录、切号甚至卸载都不影响已经导入的账号。只有 Cookie 在服务端过期才需要重新登录。

插件按单账号设计。如果保管库里已有多个账号，需要重新登录要用的那个，或用 `DOUBAO_WORK_VAULT_UID` 指定 uid。

## 用量与签到

Magpie 的 **用量 → 概览** 会显示该账号的原生额度卡，包括：

- 订阅额度
- 活动赠送额度
- 活动额度卡（剩余次数、有效天数、是否当前设备可用）
- 每日签到状态（今天签没签、连续几天、能领多少）

额度数字来自豆包服务端返回的真实计数，不是按百分比估算的。

签到只能在豆包电脑版完成，Web 侧会被服务端拒绝，失败写入还会吃掉当天额度。所以插件**只读状态，不代签**，卡片上只提示「需去豆包电脑版领」。

## 工具

插件向 Agent 暴露 6 个工具：

| 工具 | 用途 |
| --- | --- |
| `project_ensure` | 根据工作区确认或创建豆包项目 |
| `conversation_list` | 按项目或工作区列出候选会话 |
| `conversation_messages` | 按轮概览双方预览，或读取指定轮的完整消息和回复 |
| `message_send` | 新建或续聊，按选定模型和强度发送，收到回执即返回 |
| `message_status` | 按需查询会话最新回复的状态和内容 |
| `model_list` | 列出当前账号可用的模型、推理强度和默认强度 |

`message_send` 只确认送达就返回，不等回复；之后用 `message_status` 或 `conversation_messages` 取结果。完整的输入输出契约见 [`src/MINIMAL.md`](./src/MINIMAL.md)。

## 默认模型

用户未指定模型时使用 `deepseek-v4.1-flash`。该模型支持 `max` 时，未指定推理强度会自动使用 `effort: "max"`；用户指定的可用模型和强度优先。

模型列表来自账号自己的模型菜单，不是写死的。实际可选范围取决于账号订阅，可用 `model_list` 查看。

## 工作区与轮次

- 新建任务必须传本次任务的**已存在工作区绝对路径**。没有可用工作区时，`message_send` 返回 `workspace_required`，提示先创建目录。
- 使用独立 Git worktree 时，填该 worktree 的实际路径。
- `conversation_messages` 把每条发出的消息算作一轮，轮号从 1 开始。概览默认返回最近 20 轮，可用 `from_turn` / `to_turn` 分批；指定 `turn` 返回该轮完整原文和全部回复。
- 概览的预览各取前 200 个字符，超出加省略号；详情不裁剪正文。
- 长会话会通过豆包历史接口向前翻页，追加消息后旧轮号不变。

## Magpie Library 指令

把下面这段放进 Magpie Library，Agent 会按约定的顺序选模型、填工作区：

> 外包给豆包工作前，先查看可用模型及其推理强度。用户未指定模型时，优先选可用的 DeepSeek V4.1 Flash。选用该模型且用户未指定强度时，目录支持 `max` 就显式传入 `effort: "max"`。新建任务时，把本次任务工作区的绝对路径填入 `message_send.workspace`。如果没有可用工作区，先创建。使用独立 Git worktree 时填该 worktree 的路径。需要查找已有会话时，按工作区查询并确认接续对象，再传入选中的会话 ID。

## 配置

插件默认无需配置。需要改行为时用环境变量：

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `DOUBAO_WORK_VAULT` | Windows：`%LOCALAPPDATA%\magpie-doubao-work-auth\vault`<br>其他：`~/.config/magpie-doubao-work-auth/vault` | 保管库根目录，存放加密后的账号凭据 |
| `DOUBAO_WORK_VAULT_UID` | 无 | 保管库里有多账号时，指定当前使用的 uid |
| `DOUBAO_WORK_USER_DATA` | 自动查找 | 指定豆包工作客户端的 `User Data` 目录，跳过自动探测 |

## 项目结构

```text
magpie-doubao-work-bridge/
├── index.mjs                  插件入口
├── package.json               包信息与 magpie 元数据（名称、图标、摘要）
├── src/
│   ├── plugin.mjs             组装 config / auth / tool
│   ├── auth.mjs               登录方式、额度读取、签到钩子
│   ├── quota.mjs              额度接口 → Magpie 用量窗口
│   ├── session.mjs            账号 → 会话缓存、保管库与客户端导入
│   ├── min-tools.mjs          6 个工具的实现与参数校验
│   ├── conversations.mjs      会话、按轮消息、派发与回执
│   ├── projects.mjs           工作区 → 豆包项目
│   ├── body.mjs               请求体组装与模型解析
│   ├── MINIMAL.md             最小工具契约
│   └── vendor/auth/lib/       登录底座：会话、Cookie、SQLite、DPAPI、保管库
├── test/min/                  单元测试
├── example/                   参考项目副本，用于对照
├── LICENSE
└── README.md
```

## 开发与测试

```sh
npm test
```

当前 6 个测试文件、57 个用例，覆盖工具契约、会话与轮次、额度换算、登录与保管库、项目匹配。测试不访问网络，也不会启动浏览器。

改完代码后，在插件页关掉再打开即可生效；宿主常驻，只改文件不会自动重载。

## 兼容性与限制

- **不代理模型请求。** 插件在 Magpie 里注册的是空模型目录，Agent 不能把本插件当成 OpenAI 兼容的模型端点调用；任务一律走工具派发。
- **单账号设计。** `auth.single` 为 `true`，一个插件实例对应一个豆包工作账号。
- **平台差异。** Linux 只有「粘贴豆包 Cookie」；「用浏览器登录」和「从客户端读取」依赖 Windows / macOS 的安装路径。
- **签到只读。** 插件不代替用户签到，只在用量卡上展示状态。
- **速度取决于账号。** 普通账号会排队；需要稳定速度请开通豆包会员。

## 常见问题

| 问题 | 原因 | 解决 |
| --- | --- | --- |
| 从客户端读取报「该配置没有豆包登录会话」 | 客户端没登录过，或 Cookie 库正被客户端占用 | 先在客户端登录一次；客户端开着时先关掉再试 |
| 用量卡不显示 | 账号未登录，或凭据已在服务端过期 | 重新登录，用 `magpie quota` 确认能读到额度 |
| 派发返回 `workspace_required` | 新建会话时没传工作区 | 传本次任务的已存在绝对路径 |
| 返回 `send_uncertain` | 已发出但没等到服务端回执 | 用 `message_status` 查该会话最新回复，不要重复发送 |
| Linux 上找不到「浏览器登录」 | 该方式只覆盖 Windows / macOS | 改用「粘贴豆包 Cookie」 |
| 任务迟迟没有回复 | 普通账号在排队 | 换空闲时段，或开通豆包会员 |

## 参与贡献

1. Fork 仓库，从 `main` 建分支。
2. 改完先跑 `npm test`，确保 57 个用例全绿。
3. 保持改动聚焦；不要顺手重排无关代码，也不要改 `example/` 里的参考副本。
4. 提 PR 时说明改了什么、为什么改，以及怎么验证。

较大的改动（新增工具、改工具契约、改登录链路）建议先开 Issue 讨论。

## 许可证

[MIT](./LICENSE)

`src/vendor/auth/` 下的登录底座沿用其原项目的 MIT 许可证，见 [`src/vendor/auth/LICENSE`](./src/vendor/auth/LICENSE)。

## 相关项目

- 参考实现：[miaocell/magpie-doubao-work-auth](https://github.com/miaocell/magpie-doubao-work-auth)
