# Claude Science Local for Magpie — Windows 移植版

**无需登录 Claude 账号，直接在原版 Claude Science 中使用 Magpie 配置的模型。**

沿用你在 Magpie 中已有的模型账号和额度，支持在 Science 内自由切换模型。

非官方插件；本仓库增加 Windows 支持，保留 macOS 用法。Windows 移植版本为 `0.3.2-windows.4`。不提供模型账号或额外额度。

## Windows：任选一种来源，只保留一个插件

准备好 **Claude Science 0.1.70**、正在运行且已配置模型的 Magpie，以及 Node.js 22/24。首次使用仍需初始化一次本机后台；Magpie 的 Agent 插件在沙箱中运行，不能代替用户安装系统依赖或启动后台程序。

### 方式一：本地下载，在 Magpie 手动添加

把项目放在固定位置，例如 D 盘：

```powershell
cd D:\Project
git clone https://github.com/Jhonny1024/claude-science-local-for-magpie-windows.git
cd claude-science-local-for-magpie-windows
npm ci --ignore-scripts
```

在 **Magpie → 插件 → 添加插件** 中选择这个项目目录，然后在项目目录执行：

```powershell
.\science-local.cmd install
```

安装器复用你手动添加的插件。若尚未添加，也只会注册这个项目目录一次，不会把后台副本注册成插件。

### 方式二：从 Magpie 收录或 GitHub 来源安装

在 Magpie 中安装本插件；也可在添加插件中输入：

```text
Jhonny1024/claude-science-local-for-magpie-windows
```

完成下载后，从该包初始化本机后台，不必再次添加本地插件。默认安装目录下可执行：

```powershell
$plugin = Join-Path $HOME '.config\magpie\plugins\node_modules\claude-science-local-for-magpie'
& "$plugin\science-local.cmd" install
```

若包目录不同，请从实际下载目录运行同一个安装命令。也可下载本项目到固定目录后执行 `install`：安装器会复用已注册的收录来源，不会另外注册下载的副本。

收录安装的后台数据默认在 `~/.config/magpie/science-local-runtime/`，不放在会被更新替换的插件包内。希望首次安装就放到 D 盘，可先设置：

```powershell
$env:SCIENCE_LOCAL_HOME = 'D:\Project\ScienceLocalData'
& "$plugin\science-local.cmd" install
```

安装器会记住后台位置；之后从另一下载目录执行维护命令也会找到同一份服务。

### 安装之后，直接点击 Science

按提示选默认模型。安装完成后点击桌面或开始菜单的 **Claude Science**，在模型菜单的 **More models** 中切换 Magpie 模型和路由组。保持 Magpie 运行。

- 两种来源都只有一个注册项。后台的版本化副本仅用于运行和回退，不出现在 Magpie 插件列表。
- 安装时复用已有插件的来源和选项。升级旧版会合并本插件的重复记录；失败时恢复原注册状态，不修改其他插件。
- 本地源码安装的数据、日志和 Science 临时文件默认在项目的 `.science-local-runtime\`；npm 缓存在 `work\npm-cache\`。本机初始化后不要直接移动数据目录。
- 用户配置目录中保留必要的 Magpie/Science 配置、服务位置记录和 Windows 登录自启动入口；不修改 Science 安装目录，不迁移它的窗口缓存或原有历史数据。
- Windows Script Host 用于自启动及标准桌面快捷方式；系统策略禁用它时，不要关闭系统安全策略。

无法找到应用时，给安装命令补上路径：

```powershell
.\science-local.cmd install --magpie "D:\Apps\magpie.exe" --science "D:\Apps\ClaudeScience\claude-science.exe"
```

维护命令：

```powershell
.\science-local.cmd open
.\science-local.cmd doctor
.\science-local.cmd upgrade
.\science-local.cmd restart
.\science-local.cmd rollback
.\science-local.cmd uninstall
```

`upgrade` 更新后台并清理旧版重复注册；`rollback` 只回退后台版本，不增加或切换插件来源。卸载保留独立会话和模型身份，恢复标准快捷方式和原 Science 配置，并移除所选插件注册。

## macOS 安装

准备好 Claude Science、正在运行的 Magpie，以及官方 [Node.js 22/24](https://nodejs.org/zh-cn/download)。Magpie 中至少有一个可用模型。

**① 在 Magpie → 插件 → 添加插件中填入：**

```text
Jhonny1024/claude-science-local-for-magpie-windows
```

**② 在终端运行，初始化本地服务：**

```sh
git clone https://github.com/Jhonny1024/claude-science-local-for-magpie-windows.git
cd claude-science-local-for-magpie-windows
npm ci --ignore-scripts
node src/cli.js install
```

已有本地旧版？最后一行改用 `node src/cli.js upgrade`，保留原有会话和配置。

按提示选一个默认模型，完成后重新打开 Science。**只在 Magpie 点击安装，还没有完成本地服务配置。**

## 使用

- **Magpie**：在本插件的 Agent 页面勾选允许使用的模型。
- **Science**：在模型菜单中选择本次对话使用哪个。
- 选中的模型失效时，自动切到默认模型；默认模型也不可用时，选列表中的第一个可用模型。已有的有效选择会保留（目前适配 Science 0.1.70）。
- 改过模型列表后，重新打开 Science 窗口。

## 更新与卸载

macOS 用户先在 Magpie 更新插件。Windows 用户在 Magpie 更新自己安装的来源，本地目录用户更新源码；后台仍需显式升级。结束任务并更新本移植项目的源码后，在项目目录运行：

```sh
npm ci --ignore-scripts
node src/cli.js upgrade
```

常用维护命令：

```sh
node src/cli.js doctor     # 查看状态
node src/cli.js rollback   # 回退上一版
node src/cli.js uninstall  # 停止后台服务，移除接入，恢复原配置
```

只在 Magpie 移除插件，不等于完整卸载后台服务。卸载不会删除本插件创建的会话。

## 需要知道

- 本地模型接入无需 Anthropic 登录，但不代表获得 Claude 订阅；云端账号功能不保证可用。
- 使用独立数据目录，不导入或删除原版 Science 的历史会话。模型费用由你选择的 Magpie 供应商计算。
- 保留原有沙箱和权限确认。macOS 运行数据在 `~/.config/magpie/science-local-runtime/`，Windows 默认在项目的 `.science-local-runtime/`，不要将其中的密钥、备份或日志公开上传。

[兼容与测试记录](COMPATIBILITY.md) · [更新记录](CHANGELOG.md)

Windows 移植基于 [nickzhangcomes/claude-science-local-for-magpie](https://github.com/nickzhangcomes/claude-science-local-for-magpie) 0.3.1；原项目基于 [shiyang1026/magpie-claude-science](https://github.com/shiyang1026/magpie-claude-science) 改造，保留 MIT 许可与原作者归属。与 Anthropic、Magpie 无隶属关系。

## 开发验证

Windows 上先让临时文件也留在项目所在盘：

```powershell
$env:TEMP = Join-Path $PWD 'work\tmp'
$env:TMP = $env:TEMP
New-Item -ItemType Directory -Force $env:TEMP | Out-Null
npm test
npm run check:package
```

`npm run test:integration` 使用独立 HOME 和本机模拟供应商测试真实 Magpie，需要设置 `MAGPIE_BIN` 和 `MAGPIE_BUN`。

`npm run test:windows:native` 使用独立目录启动真实 Windows Science，验证本地登录、模型目录和配置恢复；可设置 `SCIENCE_BIN`。它保留 Science 沙箱，不发送模型推理请求，诊断数据留在 `work/`。本机测试记录见 [兼容与测试记录](COMPATIBILITY.md)。
