# Magpie ARTEX 插件

**在官方 Magpie 安装一个插件，让 ARTEX 使用 Magpie 的模型。无需修改或重新编译 Magpie。**

插件通过官方 `magpie.agent` 接口添加原生 **ARTEX** 行：接入、选择默认模型和勾选可见模型使用 Magpie 自己的控件。后台通过 ARTEX 管理 API 自动同步，无需修改 ARTEX 源码或直接操作数据库，也不需要另开终端运行同步命令。

## 安装和使用

1. 在官方 [Magpie](https://github.com/yetone/magpie) 的 **插件 → 添加插件** 中添加 `github:IGNiT3-R/magpie-artex`，或下载本仓库后添加固定目录路径。无需 `npm install`。本项目尚未发布到 npm。
2. 打开 **设置 → 插件** 中的 **ARTEX 连接设置**，点击「添加连接」，填写 ARTEX 地址和管理员授权。WSL 请选择正在运行的发行版；默认地址为 **http://localhost:8787**。
3. 回到 **Agent → ARTEX** 接入或选择默认模型，并按需开启「仅勾选模型可见」。所有启用的 ARTEX 连接会自动收到模型目录和默认模型变更。
4. 回到 ARTEX，在其任务、会话、Agent 或 **系统 → LLM 配置** 中选择 Magpie 模型。已打开的列表可能需要刷新。

ARTEX 用户名默认为大写 `ARTEX`。保存密码后可以自动续期 JWT；也可只保存 JWT。编辑时密码或 JWT 留空沿用已有授权，页面不会回显凭据。

已在未经修改的官方 **v0.1.3697** Windows 程序中验证。Magpie 自带 Bun，普通界面使用无需另装 Node.js；ARTEX 需要预先启动并完成管理员初始化。

## 一个 Agent，多条连接

官方插件接口目前按每个插件包注册一个 Agent。本插件因此显示一条原生 **ARTEX** 行；本机、各个 WSL 连接在官方插件设置中分别显示，保留独立地址、授权、同步状态和恢复记录。

**这些连接共用 ARTEX 原生行的默认模型与可见模型列表。** 它们不是类似内置 Codex 那样分别出现的原生环境行，也没有独立的 Magpie 模型筛选。设置位于官方支持的插件设置区域；不增加侧栏管理页或 Agents 页底面板。

可以在连接列表中「暂停同步」：只暂停这一条连接并恢复其原默认配置，其他连接继续工作。「恢复同步」会重新跟随原生 ARTEX 行。在原生 ARTEX 行断开则影响全部启用的连接。卸载插件前，建议先在原生行断开，等待各连接恢复完成。

## 模型同步

- Magpie 的模型与路由组适配为 ARTEX 自身选择器中的 LLM 配置，支持 OpenAI Chat Completions、Responses 和 Anthropic Messages。
- 在 Magpie 显式切换模型会更新并启用插件管理的默认配置。ARTEX 中单独绑定固定配置的任务、会话或 Agent 继续使用自己的配置。
- 在 ARTEX 手动切换其他默认配置时，后台会保留选择，直到下一次在 Magpie 切换模型。
- 用户在 ARTEX 调整的思考、重试、流式和速率限制保留。ARTEX 自己创建的配置不由本插件管理。
- 调整可见性后，自动清理插件创建且没有引用的旧目录条目，重新勾选可恢复保留的参数。仍为默认、被任务/会话/Agent 引用或被手动改名、改模型的条目会保留，详情状态说明原因。引用检查失败时暂停清理。

ARTEX 当前没有独立的隐藏配置 API，因此受保护的旧条目仍可能出现在其选择器中。同步通过文件监控触发，并以轮询兜底，通常几秒内生效。

## WSL 和 localhost

Windows 访问 ARTEX 时保留用户填写的 **localhost**，不会改写成 `127.0.0.1`；显式 IPv4、IPv6、端口和路径也保留。

WSL 中的 ARTEX 访问 Windows Magpie 是另一个方向：NAT 模式自动读取 Windows 主机地址，使用 Magpie 的 WSL 网关密钥；mirrored 等支持回环的模式保留可用回环地址。只探测运行中的发行版，不启动停止的发行版。

无法自动识别时，在高级设置指定「从 ARTEX 访问 Magpie 的网关地址」和「自定义网关密钥文件」。Docker/远程部署也可显式指定，容器网络不能当作 WSL 网络处理。

插件设置服务仅监听本机 `127.0.0.1:3479`，这是插件自己的服务，与 ARTEX 的 `localhost:8787` 地址不同。端口冲突可在主插件选项指定 `{"port":3480}`。首次授权需在运行 Magpie 的电脑上的桌面窗口或本机浏览器完成；当前官方设置面板不提供远程服务代理。

## 从旧版升级

**0.9 起不再依赖 Magpie 兼容补丁。** 0.8 的详情插槽和多 Agent 清单属于旧方案，不是当前安装要求；它们的源码补丁只作为历史材料留在仓库 `compat/`，不进入 0.9 插件包。

已有连接的地址、密码/JWT 和 ARTEX 恢复记录保留。升级会把已有原生桥接和可见性迁移到官方 ARTEX 行；多条旧连接选择不同模型时，采用已有主行，或按稳定顺序采用第一条有效连接。迁移不会立即强行替换旧客户端的当前默认模型，下一次在 Magpie 切换模型后统一跟随。

0.5 及更早版本的附加插件记录通过 Magpie 官方命令清理，新安装和新增连接不会注册额外插件。新版本不自动替换 Magpie 程序。之前使用自定义 Magpie 构建的用户可以使用官方发布版；该主程序的升级与插件安装是两件独立操作。

## 数据和隐私

数据保存在用户目录 `~/.config/magpie-artex`。根目录 `agent.json` 是官方 ARTEX 行提供的模型与网关桥接；本机及 `instances/` 下的 WSL 连接分别保存 `config.json`、`state.json` 和 `status.json`。`official-agent.json` 是一次性升级记录。

登录凭据在本地以明文保存，POSIX 文件权限为 `0600`，Windows 继承用户目录权限。请勿公开这些文件。状态、错误及设置 API 不回显密码、JWT 或网关密钥，但诊断信息可能包含地址、本机路径和模型名称。详见 [SECURITY.md](SECURITY.md)。

## 开发与验证

开发和可选 CLI 需要 Node.js 22+，没有第三方 npm 依赖。

```sh
npm test
npm run check:public
npm run check:package
npm run test:magpie -- --host /path/to/magpie/internal/plugin/host.js --bun /path/to/bun
npm run test:agent -- --magpie /path/to/official-magpie --bun /path/to/bun
```

`check:public` 检查 Git 暂存内容，需先暂存公开文件；`check:package` 检查实际打包、解压后的文件。可通过 `npm run hooks:install` 启用本仓库的提交检查。

原版程序集成覆盖：一项安装记录、原生 Agent、默认模型切换、可见目录差异、本机/WSL 同步、单独暂停/恢复、统一断开和旧记录清理。测试使用临时 HOME 和模拟 ARTEX，不访问真实订阅、不发送付费推理。浏览器验证可用 `test:agent` 的 `--preview` 选项启动隔离官方界面。

正常界面使用无需 CLI。可选命令包括 setup、status、sync、watch、doctor、instances 和 disconnect；使用 `--wsl <发行版>` 操作对应连接。`disconnect` 暂停该连接，不影响其他连接。

MIT License。贡献说明见 [CONTRIBUTING.md](CONTRIBUTING.md)，版本记录见 [CHANGELOG.md](CHANGELOG.md)。
