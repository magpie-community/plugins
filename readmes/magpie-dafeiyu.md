<div align="center">

# 🐋 magpie-DaFeiYu

### 让 AI 的忙碌，变成桌边的一条鱼。

**Windows · macOS · 接入 Magpie · 看请求、看额度、会放烟花**

![Windows 10+ x64](https://img.shields.io/badge/Windows-10%2B%20x64-426B9A)
![macOS Apple Silicon](https://img.shields.io/badge/macOS-Apple%20Silicon-4C78A8)
![Magpie](https://img.shields.io/badge/Magpie-local%20integration-C7475C)
![Version](https://img.shields.io/badge/version-0.1.5-4C78A8)
![Code MIT](https://img.shields.io/badge/code-MIT-538476)
![Artwork noncommercial](https://img.shields.io/badge/artwork-noncommercial-D19A35)

<img src="docs/images/desktop.png" alt="magpie-DaFeiYu：蓝色大肥鱼、请求灯泡与多账号额度" width="520">

*演示图为合成账号与额度。角色动画来自 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)。*

[下载 App](https://github.com/wolfvoid/magpie-DaFeiYu/releases/latest) · [功能](#为什么是它) · [安装](#安装) · [致谢](#致谢与许可)

</div>

一只住在桌边的蓝色大肥鱼——Windows 和 Mac 都住得下。请求进来时亮起小灯泡，额度快用完时直接摆在眼前，空闲时吃饭、施法、放烟花——**让 Magpie 的状态不用再开面板确认。**

不需要 DSH，也不绑定 Codex。只要请求经过本机 Magpie，桌宠就能跟着忙起来。

> **Magpie 插件说明 · About the Magpie plugin**
>
> - Magpie 里的插件页（npm 包 `magpie-dafeiyu`）只是使用指南入口。桌宠是需要另外下载的独立 App，安装插件不会安装、下载或启动它。
> - 角色与动画素材来自 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)，遵循其非商用要求。
> - The page in Magpie (npm package `magpie-dafeiyu`) is only a guide. The pet is a separate app you download yourself; installing the plugin does not install, download or start it.
> - The character and animations come from [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet) and are for non-commercial use only.

## 为什么是它

| 抓点 | 实际体验 |
| --- | --- |
| 💡 **几个请求，就亮几盏** | 进行中和排队的请求各有灯泡；没有请求时自动熄灭，断连变淡，不冒充“任务完成”。 |
| 💰 **两种额度，两套读法** | 订阅账号显示剩余百分比；DeepSeek 等 API 钱包直接显示剩余金额，不再假装有百分比。 |
| 👥 **额度逐条可控** | 每个额度窗口可单独决定是否显示在桌宠上；徽章带供应商 logo，并在数量较多时自动换行。 |
| 🎬 **106 段动作，不只会待机** | 吃饭、玩耍、魔术、施法、烟花都有；避开最近 15 个动作，降低重复感。 |
| 🖐 **真的能放在桌边** | 可拖动、甩动弹跳、贴边摆放；允许动作越出屏幕，不再被透明窗口卡在中间。 |
| 🔒 **只看本机，不碰聊天** | 只读 Magpie 的本地状态；不调用模型、不读 Codex 数据库、不保存账号邮箱或提示词。 |

底栏只有三件事：**换动作、暂停/继续、更多**。两个平台都默认不开机启动，也不需要登录任何第三方账号。Windows 安装只写入当前用户目录，无需管理员权限。

## 安装

### 直接用 App（推荐）

先选与系统匹配的压缩包：Windows 10+ x64 下载 `magpie-DaFeiYu-v0.1.5-Windows-x64.zip`；Apple Silicon Mac（M 系列，macOS 12+）下载 `magpie-DaFeiYu-v0.1.5-macOS-arm64.zip`。压缩包名称里的系统后缀就是目标平台，请勿混用。

**Windows 10+ x64**

1. 打开 [Releases](https://github.com/wolfvoid/magpie-DaFeiYu/releases/latest)，下载 `magpie-DaFeiYu-v0.1.5-Windows-x64.zip` 并解压。
2. 想免安装使用，进入解压后的 `蓝色大肥鱼-win32-x64` 文件夹，双击 `BlueDaFeiYu.exe`。
3. 想装进当前用户账户，就在解压目录里执行：

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
   ```

   安装到 `%LocalAppData%\Programs\magpie-DaFeiYu`，只创建「开始菜单」快捷方式：不需要管理员权限，也不会设置开机启动。`-ExecutionPolicy Bypass` 只作用于这一次进程，不会修改系统的执行策略。
4. 从「开始菜单」打开「蓝色大肥鱼」，并启动本机 [Magpie](https://github.com/yetone/magpie)。

Windows 版没有代码签名。若 SmartScreen 拦截，请先核对下载来源，再选择继续运行；不要关闭系统安全防护。

更新前先从托盘菜单退出桌宠，再运行新版本的 `install.ps1`。卸载时运行已安装目录中的 `install.ps1 -Uninstall`；用户设置会保留。

**macOS（Apple Silicon）**

1. 打开 [Releases](https://github.com/wolfvoid/magpie-DaFeiYu/releases/latest)，下载 `magpie-DaFeiYu-v0.1.5-macOS-arm64.zip`。
2. 解压后把「蓝色大肥鱼.app」拖进「应用程序」，再从菜单栏打开。
3. 启动本机 [Magpie](https://github.com/yetone/magpie)，请求灯泡和额度会自动接入。

App 使用本地 ad-hoc 签名，没有 Apple Developer ID 签名或公证。若 macOS 拦截，请先核对下载来源，再到「系统设置 → 隐私与安全性」选择「仍要打开」；不要关闭 Gatekeeper。

**要求：Windows 10+ x64，或 Apple Silicon Mac（M 系列），macOS 12+。** 不支持 Intel Mac 或 Linux 桌面；Linux 仅用于 CI 单元测试。

### Magpie 页面

仓库带有 `magpie-plugin` Topic，并提供 Magpie 可识别的页面插件：

```bash
magpie plugin add github:wolfvoid/magpie-DaFeiYu
```

安装后，Magpie 侧边栏会出现「蓝色大肥鱼」使用页。**页面不会自动安装或启动桌面 App**，桌面悬浮窗仍需按上面的说明下载对应系统的 ZIP。

### 从源码

需要 Node.js 24+、npm、Python 3 和 Git。npm 命令两个平台一致，只有 Python 命令不同：Windows 用 `python`，macOS/Linux 用 `python3`。

```bash
git clone https://github.com/wolfvoid/magpie-DaFeiYu.git
cd magpie-DaFeiYu
npm ci --ignore-scripts
node node_modules/electron/install.js
python3 scripts/download_assets.py   # Windows 把 python3 换成 python
node scripts/prepare.mjs
npm run build
npm test
npm start
```

动画从上游固定提交下载并逐文件校验，不重复塞进 Git 仓库。首次运行需要联网下载依赖和约 52 MB 素材。

## 一个仓库，两个平台

- 主界面、动画播放、请求灯泡、额度面板与本地 Magpie 读取共用同一份代码，Windows 与 macOS 行为一致。
- 平台差异被限制在很窄的范围：安装方式（`install.ps1` 或拖入「应用程序」）、应用自身数据目录、托盘图标（Windows 用 PNG、macOS 用 emoji）、打包与签名。
- Magpie 本地配置沿用官方同一路径 `~/.config/magpie/settings.json`（遵循 `XDG_CONFIG_HOME`），Windows 与 macOS 一致，本应用只读取、不修改。
- 不维护平台分支或分叉；改动先在共享代码里实现，确属平台差异的才单独处理。
- 单元测试由 CI 在 Windows、macOS、Linux 三个平台运行；发布产物在 macOS 打包 Apple Silicon，在 Windows 打包 x64。

## 它能知道什么

**它显示 Magpie 能看见的请求，不是完整任务追踪器。**

- 能看见：请求数、排队状态、当前实际使用的账号、Magpie 已缓存的额度。
- 看不见：改了哪个文件、执行了哪条命令、是否等你审批，以及整个任务何时完成。
- 不经过本机 Magpie 的请求不会出现；模型响应结束也不会被误判为任务完成。
- Magpie 暂时断开时保留最近一次有效显示；重置时间已过的旧额度仍会变为 `—%`，不会凭空推算。

本地接口只连接 `127.0.0.1:3425`（支持自定义端口）：并发状态每 2 秒读取，额度和今日统计每 30 秒刷新。Magpie 的配置按官方约定读取 `~/.config/magpie/settings.json`（遵循 `XDG_CONFIG_HOME`），Windows 与 macOS 路径一致。账号归属只在内存中换算为每次启动重新生成的代号。

每次请求都带 `Authorization: Bearer magpie-dafeiyu`，Magpie 的用量统计会把它记为本应用；如果你在 Magpie 里创建了网关 key，可以用环境变量 `MAGPIE_API_KEY` 让桌宠改用它。标出「正在使用」的账号依赖 Magpie 内部的 trace 接口，它以后可能变化；读不到时灯泡照常亮，只是不标红账号。

## 致谢与许可

| 来源 | 贡献 |
| --- | --- |
| [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet) | 大肥鱼形象、106 段动画、动作配置与初始选择器；本项目最重要的视觉来源。 |
| [yetone/magpie](https://github.com/yetone/magpie) | 本地模型网关，以及请求、额度、路由接口与集成文档。 |
| [yifanlu0227/DaFeiYu-codex-pet](https://github.com/yifanlu0227/DaFeiYu-codex-pet) | 大肥鱼桌宠与安装思路的最初参考；本项目没有使用其 spritesheet。 |
| [bianbian-666/Codex-dafeiyu](https://github.com/bianbian-666/Codex-dafeiyu) | 早期 Codex 状态联动方案参考；当前版本已改为 Magpie。 |

本仓库新增代码采用 [MIT](LICENSE)；上游选择器保留其 [MIT 许可](licenses/dsh-pet-MIT.txt)。

**角色动画、提示词、源视频等素材不属于 MIT，禁止商用。** 二创展示、介绍和分发必须保留 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet) 来源；完整说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

这是一个独立社区项目，与 DeepSeek、OpenAI、Magpie 无官方隶属关系。

---

**magpie-DaFeiYu** is a cross-platform desktop pet for Magpie: 106 animations, live request lights, subscription quotas, API wallet balances, and a local-only privacy model. Windows 10+ x64, Apple Silicon macOS 12+.
