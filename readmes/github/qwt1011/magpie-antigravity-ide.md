# Magpie · Antigravity IDE

[![Checks](https://github.com/qwt1011/magpie-antigravity-ide/actions/workflows/checks.yml/badge.svg)](https://github.com/qwt1011/magpie-antigravity-ide/actions/workflows/checks.yml)
[![License: GPL-3.0-or-later](https://img.shields.io/badge/License-GPL--3.0--or--later-blue)](LICENSE)
[![Magpie plugin](https://img.shields.io/badge/Magpie-agent_plugin-orange)](https://github.com/topics/magpie-plugin)

**在 Antigravity IDE 的原生聊天侧栏使用 Magpie 中配置的模型，并能切回 Google 账号模型。CLI 可以独立选择来源。**

这是一个非官方的 **Magpie Agent 插件 + Windows 本地适配器 + IDE 扩展**。连接器不要求为每个第三方模型重复填 API Key。Magpie 继续管理供应商、账号和模型；IDE 使用 Magpie 提供的本机网关。

> 当前版本 **0.4.0**，仅支持下面列出的 **Windows Antigravity IDE 2.7.0 精确构建**。本项目会修改两处 IDE 程序文件并保存回退基线。它不是仅在 Magpie 点击安装就自动完成的插件，必须执行一次本地安装。

**English:** Use the models you manage in Magpie inside Antigravity IDE's native chat sidebar, switch back to your Google account, and choose Google or Magpie independently for CLI sessions. This unofficial connector supports one exact Windows IDE build. Installing the Magpie Agent alone is insufficient: clone this repository and run the local setup below. Licensed under GPL-3.0-or-later.

## 能做什么

- 原生聊天下拉框列出 Magpie **Antigravity IDE** 条目允许显示的模型，包括可见路由组。
- 在下拉框切换模型后，下一条请求发送到所选模型。
- 在模型选择器旁调整当前模型的推理强度，只列出 Magpie 为该模型声明的档位。
- 临时 IDE 选择不改写 Magpie 默认；重开 IDE或重新加载窗口恢复 Magpie 的启动默认。
- Magpie 显示或隐藏模型、分组后，状态栏提示“待刷新”；刷新窗口或重开 IDE 后应用目录变化。
- 在 Magpie 断开 **Antigravity IDE**，刷新后恢复 Google 账号模式。
- 在集成终端分别打开 Google 账号 CLI 或 Magpie CLI，不要求与原生侧栏使用同一来源。

不提供 Google 账号、免费额度或模型授权。Google 模式使用你已有的登录和账号权限。第三方服务的实际模型、费用、工具调用和多模态能力由 Magpie 供应商及模型决定。

## 支持范围

| 项目 | 已验证范围 |
| --- | --- |
| 系统 | Windows，默认当前用户安装目录 |
| Antigravity IDE | **2.7.0**，commit `71bedb45923debaf49871bdcb7c7d3a47918e247` |
| IDE 目录 | `%LOCALAPPDATA%\Programs\Antigravity IDE` |
| 官方 `agy` | 1.5.16、1.5.17；CLI 独立来源验证使用 1.5.17 |
| Magpie | 0.1.4777、0.1.4781；需要支持 Agent 插件 |
| 安装工具 | Node.js 22+、Python 3 与 Windows `py` 启动器、PowerShell 5.1+ |

macOS、Linux、自定义 IDE 安装路径及其他 IDE 构建尚未适配。安装器会校验版本和内置扩展散列，不会把当前补丁强行写进未知构建。IDE 更新后可能覆盖适配，需重新评估；请勿用旧备份覆盖新版本。

## 安装

1. 安装并启动 [Magpie](https://github.com/yetone/magpie)，配置好供应商和模型。安装上述支持的 IDE，确认官方 `agy.exe` 存在于 `~/.gemini/bin/agy.exe`；需要 Google 模式时先完成原有 Google 登录。
2. 将仓库克隆到长期保留的位置。该目录还承担启动入口与回退基线的保存，不要装好后就删除。
3. 保存工作，完全退出 IDE，在 PowerShell 执行：

```powershell
git clone https://github.com/qwt1011/magpie-antigravity-ide.git
cd magpie-antigravity-ide
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

安装脚本会检查构建、生成并安装 VSIX、安装原生适配、注册 Magpie Agent，并创建桌面 **Antigravity IDE - Magpie** 快捷方式。可用 `-NoShortcut` 跳过快捷方式。此处执行策略参数仅用于本次进程，不修改全局策略。

如果已经通过 Magpie 的 Discover 安装了本仓库，克隆后执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -SkipMagpiePlugin
```

这样保留原有 Magpie 插件条目，只安装 IDE 本地适配。只安装 Magpie 端也可以用 `magpie plugin add github:qwt1011/magpie-antigravity-ide`，但仍需要以上本地步骤。

安装后在 **Magpie → Agents → Antigravity IDE** 连接模型，通过新快捷方式或本目录的 `start-native.cmd` 启动。**原版 IDE 快捷方式不进入本项目的配置隔离模式**，不保证与桌面 App 的共享网关隔离。

### 可选：仅让 IDE 使用本地代理

已有可直连环境时无需配置。如果需要本地代理，可在安装时指定实际监听端口，例如：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Proxy http://127.0.0.1:7890
```

地址仅保存在不提交的 `.local/launcher.json`。也可临时启动：

```powershell
.\start-native.ps1 -Proxy http://127.0.0.1:7890
```

或设置环境变量 `MAGPIE_IDE_PROXY`。显式参数优先，其次环境变量，最后本地文件。只支持本机 HTTP 代理，代理服务仍需运行；本项目不安装 VPN、TUN 或 DLL 透明代理。移除 `.local/launcher.json` 中的 `proxy` 并取消环境变量即可停止自动指定代理。

### 手动安装

需要检查每一步时，在仓库目录运行：

```powershell
magpie plugin add .
node manage-native.cjs install
$vsix = py -3 -X utf8 .\package-vsix.py
$ideCli = Join-Path $env:LOCALAPPDATA 'Programs\Antigravity IDE\bin\antigravity-ide.cmd'
& $ideCli --install-extension $vsix --force
.\start-native.ps1 -Check
```

本项目以 VSIX 旁加载方式安装，没有发布到 VS Code Marketplace；内部扩展 ID 为 `local-workspace.magpie-antigravity-ide-model-terminal`。

## 日常使用

| 想做什么 | 操作 |
| --- | --- |
| 侧栏使用 Magpie | 在 Magpie 连接 **Antigravity IDE**，刷新或重开 IDE |
| 侧栏使用 Google 账号 | 在 Magpie 断开 **Antigravity IDE**，刷新或重开 IDE |
| 临时使用另一个第三方模型 | 直接在原生聊天下拉框选择，下一条消息生效 |
| 调整当前模型推理强度 | 点击模型选择器旁的 **推理：默认**，选择可用档位，下一条请求生效 |
| 更新模型显隐或分组 | 修改 Magpie 后运行 **Magpie: 刷新原生模型列表（重新加载窗口）** |
| CLI 使用 Google 账号 | 命令面板运行 **Magpie: 打开 Antigravity CLI（Google 账号）** |
| CLI 使用 Magpie | 在 Magpie 连接 **Antigravity CLI**，运行 **Magpie: 打开 Antigravity CLI（Magpie）** |

命令面板快捷键为 `Ctrl+Shift+P`。刷新前等待回复完成；模型目录不会在正在生成的对话中强制刷新。切换模型后，现有上下文会随下一条消息交给所选服务，需要分开上下文时请新建对话。

启动默认只自动选择一次；若你已开始操作，自动选择会让出控制。CLI 会话维持启动时的来源，切换后请新开对应会话。普通终端直接输入 `agy` 仍由你已有的 shell/PATH/Magpie 包装控制，不等同于这两个明确选择来源的命令。

### 推理强度的默认与生效范围

**默认**表示连接器保留客户端请求中的原参数，不额外指定推理档位。客户端、Magpie 和供应商仍可能采用各自默认值；Magpie 显示“中”等级，不等于你曾手动选择“中”。例如 Gemini 自动思考预算 `-1` 在 Magpie 中会被归为 `medium`。

手动选择后，连接器在本 IDE 的下一条请求中设置 `reasoning_effort`。各模型分别记住本次后台会话中的选择，切换模型不会把 A 的强度套给 B；重开 IDE 或重新加载窗口后回到“默认”。正在生成的回复继续沿用发送时的参数。设置不改写 Magpie 启动默认，不影响独立 CLI 或 Google 账号模式。

选项来自 Magpie 的模型能力元数据，可能包括关闭、最低、低、中、高、很高、最高、极致中的一部分；没有声明档位时显示“推理：随模型”。供应商是否接受和实际执行这些参数，仍取决于该模型的接口。连接器暂不提供温度、输出长度或任意思考 Token 预算编辑。

### 为什么 Magpie 中还有另一个 Antigravity？

| 条目 | 来源 | 管什么 |
| --- | --- | --- |
| **Antigravity** | Magpie 内置 | 独立桌面 App 的共享网关和目录 |
| **Antigravity CLI** | Magpie 内置 | 终端官方 `agy` 的 Magpie 会话配置 |
| **Antigravity IDE** | 本项目新增 | IDE 原生聊天侧栏 |

三者可以分别连接。非官方 `agy` 供应商插件则是把 Google 账号模型提供给 Magpie 的另一项功能，本项目不修改它或 AI Studio 供应商。

## 配置与工作方式

- Magpie 仅写入 `~/.antigravity-ide/magpie-ide.json`。它包含这个 Agent 的本机网关密钥、启动默认和经过显隐过滤的目录。
- 原生适配只给聊天后台 `agy --hub` 使用 `%LOCALAPPDATA%/MagpieAntigravityIDE/hub-home`。编辑器和普通终端保留原 HOME；CLI 显式命令分别使用 `cli-google-home` 和 `cli-magpie-home`。
- 三个独立配置关闭或替换共享 App 路由，避免 `~/.gemini/config/config.json`、`~/.antigravity/settings.json` 中的 App 网关污染 IDE/CLI 来源。
- 已有 `~/.gemini/antigravity` 账号和会话目录通过目录 junction 共享；不复制账号令牌，不记录聊天正文。配置隔离不等于账号或会话隔离。
- 内置扩展有一处后台启动点适配，`out/main.js` 末尾增加一次启动默认选择钩子。安装时的程序文件备份保存在本仓库 `.local/checkpoints/`，原来已存在的汉化入口也会作为基线保留。
- 状态记录只含来源和模型 ID。模型显隐用于目录展示，不是网关访问控制。
- Magpie 模式下额外启动随机端口的本机推理设置网关，向固定的 Magpie 本机地址转发 OpenAI 请求。未手动指定强度时保留原始请求字节；指定后只覆盖所选模型的推理字段。流式响应和取消继续转发。
- 原生面板通过独立随机令牌及精确的后台页面 Origin 读写推理设置，不接收 Magpie 网关密钥。临时控制信息保存在 `%LOCALAPPDATA%/MagpieAntigravityIDE/effort-control.json`，也不要将此文件上传。

本机 Agent 配置、私有配置和环境变量可能含密钥；提交问题时请只附脱敏状态，不上传这些文件。仓库和发行包不包含 Google/Magpie 凭据、IDE/agy 二进制、用户对话或本机备份。独立汉化工具不包含在本仓库内。

## 更新与卸载

更新仓库前，先退出 IDE，**用当前版本**还原适配，再拉取并重新安装：

```powershell
node manage-native.cjs restore
git pull --ff-only
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -SkipMagpiePlugin
```

已通过 Magpie 的 GitHub 方式安装 Agent 时，Magpie 中更新该插件；本地克隆仍需要单独更新原生适配。

卸载时先退出 IDE，然后：

```powershell
node manage-native.cjs restore
$ideCli = Join-Path $env:LOCALAPPDATA 'Programs\Antigravity IDE\bin\antigravity-ide.cmd'
& $ideCli --uninstall-extension local-workspace.magpie-antigravity-ide-model-terminal
```

再在 Magpie 的 Plugins 中移除本项目，删除它创建的桌面快捷方式。账号和会话数据保留，安装器不会自动清理带 junction 的独立用户目录。若还需要卸载另行安装的汉化，应先还原本连接器，再还原汉化。IDE 文件已经被升级或人工修改时，还原会拒绝覆盖，请保留基线并检查差异。

## 验证与开发

无需运行 `npm install`；运行时代码和单元测试只使用 Node.js 内置模块，VSIX 使用 Python 标准库打包。

```powershell
npm test
py -3 -X utf8 .\package-vsix.py
node manage-native.cjs status
.\start-native.ps1 -Check
```

19 项单元检查覆盖 Agent 模型目录、推理档位元数据、按模型实时覆盖与默认原字节转发、控制鉴权、SSE 与取消、配置隔离、断开、路径/junction 校验、原子写入和 CLI 来源。GitHub Actions 在 Windows 上运行单元检查、打包和 PowerShell 语法检查。

可选集成测试 `node test/native-picker.cjs` 需要本机的受支持 IDE、已安装原生适配、官方 `agy` 和该 IDE 随附的 Playwright。它创建隔离 profile，以本地合成的 Alpha/Beta 服务验证目录、请求模型切换、低/高推理字段、模型间强度隔离、重开默认、隐藏模型和断开；不使用真实模型 Key。临时文件保存在 `.local/tmp/`，结果保存在 `.local/artifacts/`。

`test/run-host.ps1` 仅验证旧终端模式，需要实际已连接的本机 Agent 配置和至少两个模型，不是默认测试或 CI 检查。当前发布的主要入口是原生侧栏模式。

`.local/`、VSIX 和日志均被 Git 排除。`package.json` 的 `private: true` 只防止误发到 npm，不影响 GitHub 安装。

## 反馈、发现与许可

遇到问题请到 [议题](https://github.com/qwt1011/magpie-antigravity-ide/issues) 提供 IDE 版本/commit、agy 版本、连接状态、复现步骤及脱敏错误。请区分“模型列表不正确”“请求未切换”和“服务端拒绝请求”。

仓库 topic 使用 **`magpie-plugin`**。按 [Magpie 插件文档](https://usemagpie.ai/docs/plugins#publish)，它可被 **Plugins → Discover → Unofficial, on GitHub** 发现；该展示不代表 Magpie 官方审核。仓库提供 `magpie.agent`、显示名称和中英简介元数据，无需先发 npm。

Copyright (C) 2026 qwt1011 and contributors。本项目使用 **GPL-3.0-or-later** 许可，完整条款见 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。Magpie、Google、Antigravity 及其商标属于各自权利人，本仓库只分发连接器代码。

参考：[Magpie Agent 插件规范](https://usemagpie.ai/docs/plugins#agents)、[Magpie 的 Antigravity App 集成](https://usemagpie.ai/docs/antigravity)、[Google Enterprise Gateway](https://docs.cloud.google.com/gemini/enterprise/docs/ai-developer-tools/connect-enterprise-gateway)。Google 企业文档未把此独立 IDE 列入支持范围，本项目的兼容性以精确构建测试为准。
