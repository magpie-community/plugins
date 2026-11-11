# magpie-digital-pet-portal

> **非官方项目**：本仓库为个人独立维护的第三方展示门面，与任何官方社区组织及其维护者无隶属、合作或背书关系，也未使用其 npm scope。

**烧 token，养电子宠物** —— 这是 [Digital Pet (`magpie-digital-pet`)](https://github.com/manjughosa/magpie-digital-pet) 在 magpie 插件市场「页面（Page）」分类下的互动展示门面。

> **立即安装完整版 Digital Pet 本体：**
> 前往 **[https://github.com/manjughosa/magpie-digital-pet](https://github.com/manjughosa/magpie-digital-pet)**
> 或在终端执行：
> ```sh
> magpie plugin add github:manjughosa/magpie-digital-pet
> ```

## 为什么会有这个门面？

`Digital Pet` 本体需要启动本地 watcher 与页面服务（`main` 入口），在 magpie 的标签规则下会触发「供应商」兜底标签，容易混在近 200 个供应商插件中被埋没。

本仓库（`magpie-digital-pet-portal`）是一个**纯静态页面门面（只含 `magpie.page`，无 `main`）**，专门用于在「页面」分类下直观展示 Digital Pet 的实机界面、像素栖息地与核心玩法，并将所有获取入口直接指向 **[manjughosa/magpie-digital-pet](https://github.com/manjughosa/magpie-digital-pet)**。

## Digital Pet 核心亮点

- **真实 token 驱动成长**：汇总 magpie 记账的所有成功请求（Claude Code、Codex、Pi、OpenCode、Gemini CLI 等），把 token 转化为出战搭档的经验。
- **600+ 宠物**：从未知的数码蛋开始孵化，经历疫苗 / 数据 / 病毒属性相克试炼，收集并随时切换历代搭档。
- **超过 14 套像素场景**：门面先公开预览「阳光村落、月见之丘、樱之神社、丑皇暗堡」4 处栖息地；日常照顾与三档远征产出数据碎片，其余十余处场景留待在主插件中探索解锁。
- **6 档养成难度**：支持极速、简单、正常、普通、困难、漫长等档位调节经验槽填充速度，统计账本始终保持真实 token 用量。
- **零上下文侵入**：不挂载网关中间件，不读取对话内容，不消耗额外 token，个人存档独立保存在本地 SQLite。

## 获取完整版

- 主仓库：<https://github.com/manjughosa/magpie-digital-pet>
- 问题反馈：<https://github.com/manjughosa/magpie-digital-pet/issues>
