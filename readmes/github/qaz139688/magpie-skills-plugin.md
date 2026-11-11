# Skills Management

Magpie 的独立 Skills 管理插件，面向 Windows 上的个人技能库。

它提供技能标签、搜索、已安装 Agent 控制、来源和目录快捷操作，以及项目级技能
管理；不替换 Magpie Library，也不修改 Magpie 原生页面源码。

- 当前版本：`0.1.0`
- 平台：Windows
- 默认端口：`127.0.0.1:3487`
- 已验证的 Magpie CLI：`0.1.2405`（2026-11-01；低于此版本未验证）
- 文档入口：[docs/README.md](docs/README.md)

## 安装

### 从 GitHub 安装

在 Magpie 的 Plugins 页面打开“发现”，把下面的地址粘贴到安装输入框：

```text
github:qaz139688/magpie-skills-plugin
```

也可以在终端执行：

```powershell
magpie plugin add github:qaz139688/magpie-skills-plugin
```

安装后重新打开 Magpie，在 **Plugins → Skills Management** 打开页面。首次打开
页面时，Magpie 会启动插件自带的本地服务；不需要另外安装 Bun。

### 从本机文件夹安装

仅用于开发或调试。不要把包含 `.service-capability-*.js` 的本机目录直接发给
别人；请通过 GitHub 或 npm 分发。

```powershell
magpie plugin add 'E:\path\to\magpie-skills-plugin'
```

### 环境要求

- Windows
- Magpie；插件页面由 Magpie 内置运行时启动
- 需要手动运行 CLI 时使用 PowerShell 7

## 功能概览

- 按全部、未分类或标签浏览技能，支持多标签。
- 只显示当前 Windows 已安装且支持 Skills 的 Agent。
- 单 Agent 开关，以及当前可用 Agent 的全开/全关。
- 技能名称复制、Library 目录打开和来源网页打开。
- 展示 Magpie 原生项目，并通过技能菜单做窄范围成员变更。
- 注册插件自有项目，用 Windows Junction 增加项目级技能。

详细状态和验证记录见 [03 - 状态与迭代计划](docs/03-状态与迭代计划.md)。

## 项目定位

目标用户是同时使用多个 AI Agent、并通过 Magpie 管理技能的个人 Windows 用户。
主要解决四类问题：

- 技能多、来源多，查找和分类成本高。
- 不同 Agent 的全局归属需要快速查看和批量操作。
- 来源、技能目录和技能名需要一键操作。
- 某些本地项目需要额外启用技能，但不应修改全局归属。

完整范围见 [01 - 项目定位与范围](docs/01-项目定位与范围.md)。

## 主要功能

- 按全部、未分类或标签浏览技能。
- 一个技能支持多个标签。
- 仅显示当前 Windows 已安装且支持 Skills 的 Agent。
- 单 Agent 开关，以及当前可用 Agent 的全开/全关。
- 保留未安装 Agent 的历史关联，不因普通切换自动清空。
- 来源行、GitHub 所有者头像和自定义网页来源。
- 精确复制技能名、打开 Library 技能目录、在默认浏览器打开来源。
- 展示 Magpie 原生项目；原生项目编辑保持在 Magpie 中。
- 通过技能菜单对原生项目做窄范围成员变更。
- 注册插件自有项目，并用 Junction 增加项目级技能。

## 架构

```text
Magpie boot 页面
      |
      | 主题、语言、端口、能力脚本
      v
本地管理页面
      |
      | capability + 短期写会话
      v
Bun 服务 127.0.0.1:3487
      |
      +-- library.json / SKILL.md 窄投影
      +-- magpie ls Agent 发现
      +-- 标签和来源元数据
      +-- Magpie CLI 全局归属
      +-- 原生项目成员受控写入
      +-- 插件项目 Junction
      +-- 固定 Windows 桌面动作
```

详细数据边界、API 和写入流程见
[02 - 架构与执行说明](docs/02-架构与执行说明.md)。

## 目录结构

```text
index.mjs              Magpie 插件入口
lib/                   服务、CLI、发现、元数据、项目和桌面动作
page/                  启动页、管理页、样式和 Agent 图标
test/                  单元、HTTP、启动和隔离视觉测试
docs/                  主文档、详细设计、ADR 和实施记录
GLOSSARY.md            统一术语
```

## 开发与验证

开发环境需要 Windows、PowerShell 7、Bun 和 Magpie CLI。安装插件本身不需要
单独安装 Bun。

```powershell
Set-Location 'E:\AI-Workspace\mycc\2-Projects\P21-magpie-skills-plugin'
& 'E:\magpie-windows-amd64.exe' --version
bun test
git diff --check
```

隔离视觉验证：

```powershell
bun test/visual-harness.mjs
```

该命令使用临时配置和临时项目，不会修改真实 Magpie 项目。

本机开发安装或重装：

```powershell
magpie plugin add 'E:\AI-Workspace\mycc\2-Projects\P21-magpie-skills-plugin'
```

安装命令本身不能证明页面已完成验收；仍需从 Magpie 的 Plugins 入口打开页面，
确认真实页面、主题和本地服务正常。

## 使用与卸载

- 默认本地地址是 `127.0.0.1:3487`；如果端口被占用，可在 Magpie 的插件选项中
  设置 `port`，或关闭占用该端口的旧 Magpie 实例。
- 标签、自定义来源和插件项目记录保存在 Magpie 配置目录下的
  `skills-manager/`。删除插件前建议先备份这个目录。
- 卸载时在 Magpie 的 Plugins 页面移除或关闭插件。卸载不会自动删除上述元数据；
  确认不再需要后，再由你手动清理。
- 页面只能通过本机回环地址访问；写操作需要页面 capability 和短期会话。

## 数据与安全边界

- Magpie 是技能内容、全局归属和原生项目的权威来源。
- 插件只保存标签、自定义来源和插件项目元数据。
- 全局归属通过 `magpie library skill agents` 修改并重新读取验证。
- 原生项目只允许“Add to project”菜单修改 `skills` 映射，写入前备份、原子替换、
  执行 `magpie library sync` 并验证；失败时回滚。
- 插件项目只创建并删除自己证明拥有的 Junction，不使用复制回退。
- 服务只监听回环地址，业务 API 需要 capability 和短期写会话；capability
  持久化文件在 Windows 上限制为当前用户访问。
- 不存在任意 Shell、任意文件写入或任意 URL 抓取入口。
- 真实项目写入和部署必须单独确认。

## 测试

当前测试覆盖：

- 标签元数据、技能库投影和来源投影。
- Agent 列表解析、图标映射和服务启动。
- capability、CORS、请求认证和写操作路由。
- 全局/单 Agent 归属、隐藏关联保留和写入验证。
- 原生项目成员写入、同步失败回滚和隐藏归属保留。
- 插件项目 Junction 生命周期、冲突保护和项目只读状态。

最近一次工作区验证：`bun test` 通过，32 个测试、9 个测试文件。

## 已知边界

- Agent 名称和项目目录映射是固定表，Magpie 升级后需要重新核对。
- WSL、远程 Agent 和非 Windows 环境不在当前范围。
- 共享技能目录可能让多个 Agent 同时读取同一个项目链接。
- 插件项目不会自动导入、同步或接管原生项目。
- GitHub 远端克隆和包结构已验证；尚未在隔离 Profile 执行真实安装复测。
- 页面升级和本地服务仍需在目标 Magpie 版本上重新打开页面确认。

## 发布说明

GitHub 仓库添加 `magpie-plugin` topic 后，会出现在 Magpie 的插件发现页
“非官方插件 · GitHub”区域。若要进入社区推荐列表，再向
`magpie-community/plugins` 的 `registry.json` 提交 PR，页面条目使用
`"kind": "page"`。

## 许可证

本项目使用 MIT License，详见 [LICENSE](LICENSE)。`page/icons/` 下的第三方
图标仍受各自的许可证和 `NOTICE.md` 约束。

## 文档

- [文档入口](docs/README.md)
- [01 - 项目定位与范围](docs/01-项目定位与范围.md)
- [02 - 架构与执行说明](docs/02-架构与执行说明.md)
- [03 - 状态与迭代计划](docs/03-状态与迭代计划.md)
- [详细设计](docs/design-spec.md)
- [术语表](GLOSSARY.md)
- [架构决策记录](docs/adr/)
