# AGY 令牌管理 · Magpie 页面插件

单页双栏工作台：在同一页面内完成 AGY-CLI 导入 JSON 转换，并直接浏览、搜索和导出本机已保存 Magpie 账号的 Refresh Token（RT）。支持 Windows、macOS 与 Linux。

## 安装

```sh
magpie plugin add github:Purfeather/magpie-agy-rt-import
```

已安装旧版时，可在 **插件 → 已安装** 检查更新，或运行 `magpie plugin update`。也可以先克隆仓库，再从仓库目录运行 `magpie plugin add .`。

## 导入 RT

1. 在 Magpie 侧栏的插件分组打开 **AGY 令牌管理**。
2. 在左侧 **导入 Refresh Token** 粘贴裸 RT（或直接粘贴含 `refresh_token` / `token.refresh_token` 的 JSON，页面会自动提取并展示脱敏结构预览）。
3. 点击 **复制导入 JSON**（或 **下载 JSON** 保存 `agy-account.json`）。如窗口限制自动复制，页面会自动选中文本供手动复制。
4. 打开 **供应商 → Antigravity（本地 agy CLI）→ 从文件导入账号**，粘贴 JSON 或选择文件导入。

账号验证和续期由已安装的 `agy-cli` 插件和本机 `agy` 完成。RT 须来自可被 Antigravity OAuth 客户端续期的有效授权。

## 导出 Magpie 账号的 RT

打开插件后自动识别本机保存的 AGY 账号。在账号行点击 **复制 RT** 或 **复制 JSON** 导出该账号。扫描成功但没有账号时显示空列表；读取失败时展开 **手动选择账号目录**，可选择整个 `accounts` 目录或单个账号目录。

右上角 **刷新** 会重新打开整个插件页，清空当前 RT 输入、目录选择、筛选条件和导出结果，再重新识别账号。刷新不修改已保存的账号或系统剪贴板。独立文件工作台刷新后需要重新输入会话码。

默认目录是 Windows 的 `%USERPROFILE%\.local\state\magpie-agy-bridge\accounts` 或 macOS / Linux 的 `~/.local/state/magpie-agy-bridge/accounts`。设置了 `XDG_STATE_HOME` 时使用 `$XDG_STATE_HOME/magpie-agy-bridge/accounts`。

### 独立浏览器中扫描本机账号

在插件目录的个人交互式终端运行以下命令（Node.js 22+ 或 Bun）。可选参数为含 `plugin-auth.json` 的 Magpie 配置目录；省略时扫描默认状态目录，按 Profile ID 展示账号。

```sh
node index.mjs --workbench
# 同时读取账号登记信息和邮箱
node index.mjs --workbench "/path/to/magpie/config"
```

用浏览器直接打开终端显示的本地 `page/index.html` 文件。在 **连接终端启动的本机扫描会话** 输入终端显示的会话码。连接成功后支持搜索、刷新、复制 RT 或 AGY-CLI JSON。不要共享会话码；持有码的进程或人员在服务运行期间可读取账号。按 Ctrl+C 即可撤销该会话，重新启动会生成新码。

## 安全与兼容性

- Magpie 加载插件时启动本机服务，默认监听 `127.0.0.1:34973`，可通过插件选项 `port` 调整。入口在原有页面框架中自动进入服务提供的完整工作台。Magpie Web 使用 `magpie.service` 转发地址；桌面窗口使用本机地址。端口被占用时需要释放端口或修改选项，再重新启用插件。
- 内置工作台使用每次服务启动随机生成的会话凭据，随 HTML 交给页面，请求时验证。HTML 不允许跨源读取，服务校验 Host、Origin 和会话凭据，限制嵌入来源。此模式信任当前操作系统账户及本机进程；同账户的程序通常也能读取原有账号文件。页面退出或刷新会清除临时输入，RT 按点击的账号返回。服务页面重新打开会取得当前会话凭据。
- 独立扫描会话只监听 `127.0.0.1` 的临时端口。只有交互式启动者的终端显示随机 256 位密钥。服务公开的页面与脚本均不包含密钥。文件页面通过 AES-GCM 验证服务响应，请求与响应绑定到操作路径，响应还绑定到请求的随机 IV。输入的 RT 和导入 JSON 始终只在受信任的本地页面处理。
- 账号扫描检查从所选信任根开始的每段路径，核对打开句柄与路径的文件身份，按上限读取凭据（64 KiB）和索引（4 MiB）。索引和凭据均支持 UTF-8 BOM。上级目录与操作系统账户权限属于信任边界。
- 已知 `@magpie-community/opencode-agy-cli-auth` 从 `0.1.68` 起支持此导入格式。详见 [AGY-CLI 导入支持](https://github.com/magpie-community/plugins/commit/9907c187b212c55680acae4d46f5d2c868cda5f2)。
