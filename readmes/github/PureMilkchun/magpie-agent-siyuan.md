# 思源笔记 Magpie Agent 插件

在 Magpie 的 **Agents → 思源笔记 · SiYuan** 选择模型或路由组。思源的内置智能体随后通过 Magpie 网关调用该模型。会话、笔记工具和工具审批仍由思源管理。

Magpie 的 **插件 → 已安装** 和 **Agent** 都显示思源标志。连接后，思源的 **设置 → 人工智能 → API 提供商** 中，Magpie 卡片显示 Magpie 标志。插件用思源的 CSS 片段为这张卡片添加图标，沿用思源的全局 CSS 片段开关。

## 安装和连接

已在 macOS 上验证 **思源笔记 3.8.11** 与 **Magpie 0.1.4274**。两者需要在同一台电脑运行，Magpie 网关需要已启动并配置至少一个可用模型。

在 Magpie 的 **插件 → 发现 → 非官方 → GitHub** 中找到 **思源笔记 · SiYuan** 并点击安装。也可以从终端直接安装：

```sh
magpie plugin add github:PureMilkchun/magpie-agent-siyuan
```

如果 macOS 上的 `magpie` 没有加入 PATH，可用 `/Applications/magpie.app/Contents/MacOS/magpie` 执行同一命令。

插件使用 Magpie 自带的 Bun，无需构建或安装 npm 依赖。从检出的源码安装时，在仓库目录运行 `magpie plugin add "$PWD"`。已有连接会在原工作区打开时自动补上图标。

1. 打开思源桌面版和要接入的工作区。
2. 在 Magpie 的 **Agents → 思源笔记 · SiYuan** 选择支持工具调用的模型或路由组。
3. 等待同步，在思源 **设置 → 人工智能** 确认智能体选中了 **Magpie** 下的模型，然后新建智能体会话。可以先发送「只回复连接成功」，再到 Magpie 的 **Usage** 页面查看归属于 `siyuan` 的请求。

已有会话可能保存了各自的模型选择。思源送给模型的消息、引用和工具结果会按所选模型或路由组经过 Magpie 发给上游。

## 断开和恢复

保持目标思源工作区运行，在 Magpie 的 Agents 页面关闭思源连接，或执行 `magpie siyuan default`。插件移除自己添加的提供商和图标片段。当智能体仍选着该提供商的模型时，恢复接入前的模型选择。思源会在原模型已删除或停用时按自身规则选择可用模型。

如果断开时思源已经关闭，下次打开原工作区后，运行中的插件会重试恢复。停用或卸载插件后仍有残留时，打开原工作区，并在项目目录使用 Node.js 22 或更新版本手动恢复。

```sh
node bridge.mjs restore
```

首次连接使用思源最近打开的本机工作区，并在本次连接期间绑定到该工作区。要切换工作区，请先在原工作区完成断开，再打开新的工作区并重新连接。

## 接入实现

- [siyuan.agent.js](./siyuan.agent.js) 用 Magpie 的 `magpie.agent` 接口注册模型选择器，把网关的 `/v1` 地址、思源专用凭据和模型 ID 写入连接文件。路由组沿用 Magpie 的 `group/<id>`。
- [index.mjs](./index.mjs) 和 [bridge.mjs](./bridge.mjs) 在 Magpie 的插件宿主中运行。桥接器核对本机内核的工作区身份后，用思源设置接口读取 AI 设置，再通过 `/api/setting/patch` 添加 OpenAI Chat Completions 提供商，并更新 `ai.agent.modelId`。思源工作区配置由内核负责保存和通知界面。
- 连接文件与恢复记录位于 `~/.config/siyuan/magpie/`。连接文件含网关凭据。恢复记录只保存工作区路径、模型和提供商的本地 ID，以及用于判断重复同步的摘要。

上游参考 [Magpie Agent 插件文档](https://usemagpie.ai/docs/plugins#agent-plugins)、[思源设置读取源码](https://github.com/siyuan-note/siyuan/blob/v3.8.11/kernel/api/setting_read.go)、[设置补丁源码](https://github.com/siyuan-note/siyuan/blob/v3.8.11/kernel/api/setting_patch.go)、[CSS 片段接口](https://github.com/siyuan-note/siyuan/blob/v3.8.11/kernel/api/snippet.go)和[智能体模型选择及流式调用源码](https://github.com/siyuan-note/siyuan/blob/v3.8.11/kernel/api/agent.go)。

运行 `npm test` 验证连接字段、图标打包、旧连接升级和断开恢复。

思源笔记与 Magpie 标志分别归各自项目所有，在此用于标识所集成的应用。 [思源笔记](https://b3log.org/siyuan) · [Magpie](https://usemagpie.ai)
