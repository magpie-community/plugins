# Kimi Code CLI 登录 · Magpie 插件

非官方、仅限 Windows 的 Magpie/OpenCode 供应商插件。它复用本机 Kimi Code CLI 的登录，将可用模型放在 `kimi-cli` 供应商下，无需复制访问令牌到 Magpie。

## 功能

- 从 Kimi Code API 获取账号可用模型，包括 `kimi-for-coding`、`k3` 和账号有权限使用的新模型。
- 在 Magpie 用量页分别显示每个账号的套餐、5 小时和 7 天用量及重置时间。接口未返回的窗口不会显示为零用量。
- 支持同一供应商下的两个本机登录：默认账号和 Kimi CLI 的环境账号。两者的额度独立，Magpie 可按账号路由和切换。
- 令牌临近过期时，通过对应区域的 Kimi OAuth 服务刷新，并写回原来的 CLI 凭据文件。

## 环境要求

- Windows 与系统自带的 Windows PowerShell。
- 已安装并登录 Kimi Code CLI；先在 CLI 中运行 `kimi login`。
- 第二个账号可选：Kimi CLI 的 `config.toml` 中须有 `[providers."managed:kimi-code".oauth]` 的环境凭据引用。插件从该配置读取凭据文件名、API 地址和 OAuth 地址。

凭据目录为 `%USERPROFILE%\.kimi-code\credentials`，也可通过 `KIMI_CODE_HOME` 指定另一目录。默认账号使用 `kimi-code.json`；环境账号使用 Kimi CLI 配置中引用的 `kimi-code-env-*.json`。

## 安装

```powershell
magpie plugin add github:huige233/magpie-kimi-cli-login
magpie plugin login kimi-cli 1  # 默认账号
magpie plugin login kimi-cli 2  # 可选：环境账号
```

也可以在 Magpie 的「插件」页面安装，再到「供应商 → Kimi CLI 登录」添加账号。连接后在模型列表选择 `kimi-cli/<model>`；即使连接两个账号，模型列表仍只有一组。`magpie accounts` 可查看和切换账号，`magpie quota kimi-cli --json` 可查看各账号额度。

## 凭据处理

Magpie 只保存区分本机账号的连接标记，不保存 Kimi 访问令牌。插件直接读取 Kimi CLI 的凭据文件，并仅把令牌发送到该账号配置的 Kimi Code API 域名。默认账号使用 `api.kimi.com` / `auth.kimi.com`；环境账号只接受 `kimi.com` 或 `kimi.ai` 的官方 API 与 OAuth 域名。请勿将 `.kimi-code/credentials` 或真实令牌加入仓库。

## 卸载

```powershell
magpie plugin rm github:huige233/magpie-kimi-cli-login
```

卸载插件不会注销 Kimi CLI。此项目与 Moonshot AI、Kimi 或 Magpie 官方没有关联。

## License

MIT
