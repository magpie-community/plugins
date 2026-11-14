[简体中文](README.md) | [English](README.en.md)

# Enjoy · Magpie Agent

让 Enjoy 出现在 Magpie 的 Agent 页面，并把 Magpie 里的模型导入 Enjoy，
在 Enjoy 自己的模型下拉框里选 Magpie 的模型作为底层模型。

支持 **Windows / macOS / Linux**，目标版本 **Enjoy ≥ 0.7.0**。

---

## 特性

- **Enjoy 出现在 Magpie 的 Agent 页**：装上之后，Magpie 的 Agents 列表里
  就有一行 Enjoy，开关拨过去即接管。
- **全部模型一次接入**：Magpie 中配置的模型与路由组会一次性写入 Enjoy，
  之后在 Enjoy 自己的模型下拉框里直接切换，不必回到 Magpie 重新配置。
- **不动其它配置**：只改 Enjoy 数据库 `user_settings` 表里的 `openai` 和
  `gpt_engine` 两行。语音识别、语音合成、已有的聊天成员和对话都不碰。
- **断开即还原**：连接时逐键备份原值，断开、卸载插件后恢复为写入前的配置，
  不影响你原有的 EnjoyAI 设置。还原只动仍是插件写入的那一行：连接期间你在
  Enjoy 里自己改过的配置视为你的，保持不动。
- **跨平台**：Windows、macOS、Linux 使用同一套路径与命令。

---

## 安装方式

在 Magpie → **Plugins** 中添加仓库地址：

```text
github:Emilia06120878/magpie-agent-enjoy
```

或用 Magpie CLI：

```bash
magpie plugin add github:Emilia06120878/magpie-agent-enjoy
```

---

## 安装与快速上手

### 前置条件

- 本机已安装 **Magpie**，网关在 `127.0.0.1:3425` 正常响应。
- 本机已安装 **Enjoy 0.7.0 或以上**，并且登录过（Enjoy 的登录信息决定
  用哪一个数据库）。
- Magpie 中至少已添加一个可用模型或路由组。

### 步骤

1. **运行体检**：`node tools/doctor.mjs`。它会找到本机的 Enjoy、指出它的
   数据库在哪、打印当前的模型配置，并检查网关是否通。
2. **安装插件**：运行上面的安装脚本，或 `magpie plugin add github:Emilia06120878/magpie-agent-enjoy`。
3. **在 Magpie 中接管**：Agents 页面 → **Enjoy** → 把 provider 拨到 `magpie`。
4. **重启 Enjoy**（重要）：Enjoy 在启动时读自己的设置，已经打开的 Enjoy
   需要重启一次才能看到新模型。
5. **在 Enjoy 中选择模型**：设置 → **默认 AI 引擎** → 引擎选 **OpenAI**，
   模型下拉框里就是 Magpie 的模型；聊天里每个智能体也能单独选模型。

> Enjoy 在设置页提示「需要先填写 OpenAI 的 API Key」时不用管——
> 插件已经填好了，点保存即可。

---

## 常用管理命令

| 操作 | 命令 |
| :--- | :--- |
| **安装前体检** | `node tools/doctor.mjs` |
| **体检（机器可读）** | `node tools/doctor.mjs --json` |
| **把配置还原** | `node tools/doctor.mjs --restore` |
| **安装插件** | `magpie plugin add github:Emilia06120878/magpie-agent-enjoy` |
| **查看已检测到的 agent** | `magpie ls` |
| **查看 Enjoy 接管状态** | `magpie enjoy` |
| **断开并还原配置** | `magpie enjoy provider default` |
| **删除插件** | `magpie plugin rm magpie-agent-enjoy` |
| **运行单元测试** | `npm test` |

---

## 架构与工作流程

```text
Magpie Agent 页
    │  把 provider 拨到 magpie
    ▼
Magpie Agent 插件 enjoy.agent.mjs
    │  在 moejs 沙箱里算出该写哪些键
    ▼
Magpie 写桥接文件
  ~/.config/magpie/enjoy-magpie.json
    │  网关地址、网关密钥、Magpie 的模型列表
    ▼
index.mjs（Bun 插件宿主）
    │  监听桥接文件 → 翻译 → 写 Enjoy 的数据库
    ▼
Enjoy 的 user_settings 表
  openai      = {key, baseUrl, models: "group/gp-glm5.3,group/gp-kimi-k3.1-pro,…"}
  gpt_engine  = {name: "openai", models: {default, lookup, translate, analyze, extractStory}}
    │
    ▼
Enjoy 设置页 / 聊天 → 自己的模型下拉框里选 Magpie 的模型
```

### 为什么要有桥接文件

Magpie 的 agent 插件只能让 Magpie 写**一个文件**，而 Enjoy 的模型配置
在 SQLite 数据库里。桥接文件是唯一能把 Magpie 的模型目录交给有数据库
权限的一方、再由它写库的通道。这条路已经在同作者的
[`magpie-agent-deeptutor`](https://github.com/Emilia06120878/magpie-agent-deeptutor)
和 [`magpie-agent-toonflow`](https://github.com/Emilia06120878/magpie-agent-toonflow)
插件里验证过。

### 怎么找到本机的 Enjoy

按这个顺序找，第一个命中的即用：

1. `ENJOY_DATABASE` 环境变量（显式指定数据库文件）。
2. Enjoy 自己的设置文件 `%APPDATA%\Enjoy\settings.json` —— 里面写着资源库
   路径和登录用户的 id，数据库就在 `<资源库>\<用户id>\enjoy_database.sqlite`。
   **这一条最可靠。**
3. `LIBRARY_PATH` 环境变量，以及 `Documents\EnjoyLibrary` 等常见位置。

### 写入内容

只改 `user_settings` 表的**两行**：

| key | 内容 |
| :--- | :--- |
| `openai` | `{key: "magpie-enjoy", baseUrl: "http://127.0.0.1:3425/v1", models: "<逗号分隔的模型 id>"}` |
| `gpt_engine` | `{name: "openai", models: {default, lookup, translate, analyze, extractStory}}` |

`gpt_engine.models` 里每个键指向的模型都必须在 Magpie 的模型列表内：
原来填的是 EnjoyAI 的 `gpt-4o`（网关没有这个模型），所以会被换成 Magpie
列表里的第一个模型。

**不动的**：`stt_engine`（语音识别）、`tts_config`（语音合成）、
`chat_members` / `chat_agents` / `conversations` 里已有的配置。

---

## 注意事项

- **Enjoy 要重启一次**才能读到新的模型设置。Enjoy 在启动时读 `user_settings`。
- **已经存在的聊天成员和旧对话不会被改**。每个聊天成员把引擎和模型存在
  自己那一行，插件不碰它们。要换模型，在聊天设置里逐个改；**新建**的
  成员会自动用全局默认（也就是 Magpie 的模型）。
- **语音识别和语音合成保持原样**。如果你手动把语音识别切到 OpenAI，它会
  去请求 Magpie 网关的 `/v1/audio/transcriptions`，而网关没有 `whisper-1`。
- 插件只在 Enjoy 的 `user_settings` 表里写两行，不改 Enjoy 的程序文件，
  也不改它自己的安装方式。Enjoy 升级不受影响。
- 如果 Enjoy 正在运行，插件写库时会等一小会儿（最多 5 秒）而不是硬抢锁；
  极端情况下先退出 Enjoy 再接管更稳妥。

---

## 常见问题

### Magpie 的 Agent 页上看不到 Enjoy

插件没装上，或者 Magpie 还没重新加载插件。在 Magpie 里把插件关掉再打开
一次，然后 `magpie ls` 看有没有 Enjoy 这一行。

### 接管了，但 Enjoy 的模型下拉框里还是那些老的模型

Enjoy 需要重启。设置 → 默认 AI 引擎 里的模型列表是在启动时读的。

### Enjoy 说「需要先填写 OpenAI 的 API Key」

这是接管前的提示。插件写入的 `openai` 行里已经带了 key，重新打开设置页
就会看到；保存一次即可。

### 接管后聊天报错，提示模型不存在

你选的模型在 Magpie 网关上不可用（比如生图、生视频的模型）。在 Enjoy 的
模型下拉框里换一个纯文本模型。

### 想完全还原

```bash
magpie enjoy provider default
```

或者在插件被卸载时，Magpie 会自动断开并还原。也可以用
`node tools/doctor.mjs --restore` 手动还原。两种方式都只还原仍保持插件
写入值的行——你在 Enjoy 里自己改过的配置不会被覆盖。

### Enjoy 装在别的位置，插件找不到

设置环境变量 `ENJOY_DATABASE` 指向数据库文件：

```bash
ENJOY_DATABASE="D:\Apps\EnjoyLibrary\<你的用户id>\enjoy_database.sqlite" node tools/doctor.mjs
```

---

## 仓库结构

```text
enjoy.agent.mjs           moejs Agent 描述符与 connect()
index.mjs                 Bun 插件宿主：探测 Enjoy、监听桥接文件、写数据库
lib/constants.mjs         路径、环境变量展开与原子 JSON 写入
lib/discovery.mjs         探测本机的 Enjoy
lib/bridge.mjs            桥接文件 → Enjoy 配置的翻译
lib/settings.mjs          读/写 user_settings（node:sqlite，bun:sqlite 兜底）
package.json              包信息与 Magpie 插件声明
tools/doctor.mjs          安装前检查：Enjoy、数据库、当前配置、网关连通性
test/                     描述符、翻译、探测、数据库读写与端到端测试
docs/enjoy-config.md      Enjoy 的配置到底在哪（源码证据）
docs/agent-plugin-contract.md  Magpie agent 插件契约
```

---

## 开源协议

本项目遵循 [MIT License](LICENSE)。
