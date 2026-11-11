# Magpie 认证导出插件

纯插件，为 Magpie 增加侧栏下载图标和供应商右键菜单中的“↓ 导出认证文件”。无需修改或重新编译 Magpie。插件模式使用 Magpie 自带的 Bun，不需要另外安装 Node.js 或运行 npm install；独立命令行需要 Node.js 20+。

当前版本：0.1.7。Mac / Windows / Linux 共用一份代码，可直接从 GitHub 安装，无需发布到 npm。已用 macOS 上的 Magpie 0.1.2888 / Bun 1.4.4 验证插件宿主；Windows 和 Linux 尚未实机验证。

## 从 GitHub 安装

先安装 Magpie，再执行：

```sh
magpie plugin add "https://github.com/Zephyrlux/magpie-auth-export"
```

macOS 如果 magpie 没有加入 PATH，可用完整程序路径：

```sh
/Applications/magpie.app/Contents/MacOS/magpie plugin add "https://github.com/Zephyrlux/magpie-auth-export"
```

Magpie 会下载并管理插件。安装成功后重新打开 Magpie，左侧出现“导出认证”。

更新远程安装的插件：

```sh
magpie plugin update
```

此命令更新所有已安装的远程插件；本地文件夹安装的插件不会更新。[Magpie 的 GitHub 安装与更新实现](https://github.com/yetone/magpie/blob/main/internal/plugin/store.go)。

如果已经通过其他本地目录安装过旧版，先在 Magpie 的“插件 → 已安装”中移除旧条目，再从仓库地址安装，避免同时加载两份。移除插件不会退出 Magpie 自带的 Codex / Claude 账号。

也可以先 git clone，再添加本地文件夹（此方式后续自行 git pull）：

```sh
git clone https://github.com/Zephyrlux/magpie-auth-export.git
magpie plugin add ./magpie-auth-export
```

本地文件夹安装需要保留该文件夹。Magpie 官方支持从[GitHub 或本地文件夹安装插件](https://github.com/yetone/magpie/blob/main/docs/subsystems/plugin-runtime.md#p4-community-plugins-at-every-point)。

## 使用

- 供应商列表：右键 Codex 等供应商，点“↓ 导出认证文件”，打开该提供商的账号选择，勾选后下载。
- 侧栏“导出认证”：选择提供商、格式和要导出的账号，再点击“下载认证文件”。支持单选、多选和全选，多账号默认不勾选。默认 CLIProxyAPI JSON；另有 Codex auth.json 和原始 JSON。

恢复上次页面、刷新页面或使用右键入口都不会自动导出。只有勾选账号并点击“下载认证文件”才会保存，导出请求只包含所选账号的 ID；刷新账号会移除已经不存在的选择，不会自动全选。Magpie 的原 Codex 编辑弹窗目前没有可用插件插槽，因此入口使用官方开放的侧栏和供应商右键菜单。

插件模式默认读取当前 Magpie 宿主提供的配置目录，包括 portable 及 XDG 配置位置；`sourceDir` 选项可覆盖。独立命令行默认读取 `~/.config/magpie/logins.json` 和 `plugin-auth.json`，绝对路径 `XDG_CONFIG_HOME` 会生效。只读取 Magpie 已保存的账号，不扫描浏览器或系统钥匙串。仅由原客户端持有、尚未保存在这两个文件中的登录不会出现在列表中。

默认直接保存到 `~/Downloads/`，不创建额外目录。文件名使用账号邮箱，例如 `name@example.com.json`；重名时自动保存为 `name@example.com (2).json`，保留已有文件。JSON 文件权限为 `0600`（POSIX 系统），不改变“下载”目录原有权限。结果显示简短文件名，悬停可查看完整路径，不展示令牌。插件不向模型或其他电脑返回认证文件，也没有 MCP 工具或网关请求钩子。

## 格式

| 格式 | 支持账号 | 内容和使用方式 |
| --- | --- | --- |
| Codex auth.json | Magpie 保存的 Codex / ChatGPT OAuth 账号 | 完整保留原 `auth.json` 对象及未知字段；每个账号一个邮箱命名的 JSON 文件，给原生 Codex 使用时改名为 `auth.json`，按目标机器的凭据存储方式导入。 |
| CLIProxyAPI 认证 JSON | Codex / ChatGPT、Claude OAuth | 转为 CLIProxyAPI 的平铺字段，包括 access / refresh token、账号标识和可从现有令牌确定的过期时间；放入目标 CLIProxyAPI 配置的 `auth-dir` 或使用其导入入口。 |
| Magpie 原始凭据 JSON | 有认证数据的已保存账号及通用插件账号 | 保存原始对象；通用插件保留 `{ "provider#slot": { ... } }` 映射。此格式不是 Magpie 的 `.magpie-backup`，也不能保证任意提供商都支持从文件导入。 |

导出不会请求供应商、刷新令牌、切换登录或修改源文件。它是现有凭据的副本：已过期或已撤销的凭据仍需重新登录；轮换式 refresh token 在一个工具刷新后，另一个副本可能失效，不适合让多个工具长期同时刷新同一账号。CLIProxyAPI 的字段结构已经按官方源码核对，未对真实账号进行远程导入验收。

## 独立命令行

在插件目录执行：

```sh
node cli.js list
node cli.js export --format codex --all
node cli.js export --format cliproxyapi --all
node cli.js export --format raw --account 'login:账号ID'
node cli.js serve --port 34821
```

`list` 只输出账号元数据。所有命令支持 `--source-dir /完整/Magpie配置目录`，用于 portable 安装或其他配置位置；导出和服务支持 `--output-dir /完整/导出目录`。导出目录不得与源配置目录及其父子目录重叠。

插件选项可指定 `port`、`sourceDir`、`outputDir`：

```sh
/Applications/magpie.app/Contents/MacOS/magpie plugin options magpie-auth-export '{"port":34822,"sourceDir":"/完整/Magpie配置目录","outputDir":"/完整/导出目录"}'
```

服务只监听 `127.0.0.1`，默认端口 `34821`。API 使用每次启动生成的随机页面会话，拒绝其他网站的来源及 Host。用于本机桌面或本机浏览器；远程 `magpie web` 不作为本版的支持入口。

如果提示端口被占用，先停用再启用插件。若仍失败，在插件“选项”中把 `port` 改为其他空闲端口（例如 `34822`），再停用、启用。0.1.7 修复了同一宿主并发加载时重复启动服务的问题；不同 Magpie 实例仍需要各自使用不同端口。

默认导出目录是用户主目录下的 `Downloads`；系统重定向的下载目录或其他位置可通过 `outputDir` 指定。导出目录需要支持硬链接，通常使用本机磁盘目录即可。

卸载只需在 Magpie 插件页面移除；导出的文件仍由你保管。

## 验证与依据

```sh
npm test
node tests/host-smoke.mjs /路径/magpie-bun /路径/host.js
```

测试全部使用临时目录和虚构令牌，验证转换、文件权限、源文件不变、工作区身份、API 会话和跨来源拒绝。浏览器测试也使用虚构账号。

仓库及 npm TGZ 只包含插件代码、页面、说明及测试，不包含 Magpie 配置、账号、令牌或这台电脑的路径配置。其他用户安装后使用自己的本机账号。

- [Magpie 已保存登录结构](https://github.com/yetone/magpie/blob/8f0d21a009d0f0cb6d73e30898e0ed60453e1e4a/internal/provider/logins.go#L73-L124)
- [Magpie 插件页面及右键动作规范](https://github.com/yetone/magpie/blob/main/docs/subsystems/plugin-runtime.md#p4-community-plugins-at-every-point)
- [CLIProxyAPI Codex 文件结构](https://github.com/router-for-me/CLIProxyAPI/blob/90c447d3a8727d115aa7552ec93ce023736ed492/internal/auth/codex/token.go#L230-L248)
- [CLIProxyAPI Claude 文件结构](https://github.com/router-for-me/CLIProxyAPI/blob/90c447d3a8727d115aa7552ec93ce023736ed492/internal/auth/claude/token.go#L19-L51)
