# Claude Science Local for Magpie

**无需登录 Claude 账号，直接在原版 Claude Science 中使用 Magpie 配置的模型。**

沿用你在 Magpie 中已有的模型账号和额度，支持在 Science 内自由切换模型。

非官方插件，目前支持 macOS。不提供模型账号或额外额度。

## 安装

准备好 Claude Science、正在运行的 Magpie，以及官方 [Node.js 22/24](https://nodejs.org/zh-cn/download)。Magpie 中至少有一个可用模型。

**① 在 Magpie → 插件 → 添加插件中填入：**

```text
nickzhangcomes/claude-science-local-for-magpie
```

**② 在终端运行，初始化本地服务：**

```sh
git clone https://github.com/nickzhangcomes/claude-science-local-for-magpie.git
cd claude-science-local-for-magpie
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

任务结束后，在 Magpie 更新插件，再到本仓库目录运行：

```sh
git pull --ff-only
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
- 保留原有沙箱和权限确认。运行数据在 `~/.config/magpie/science-local-runtime/`，不要将其中的密钥、备份或日志公开上传。

[兼容与测试记录](COMPATIBILITY.md) · [更新记录](CHANGELOG.md)

基于 [shiyang1026/magpie-claude-science](https://github.com/shiyang1026/magpie-claude-science) 改造，保留 MIT 许可与原作者归属。与 Anthropic、Magpie 无隶属关系。
