# magpie-claude-launcher

Claude Code 快捷启动：Magpie 纯页面插件（`magpie.page`）。纯 HTML / CSS / JavaScript，无依赖、无构建、无服务端入口，插件代码无需 Bun。

## 安装

在运行 Magpie 的 VPS 或电脑上执行：

```sh
git clone https://github.com/wujiegdft/magpie-claude-launcher.git
magpie plugin add ./magpie-claude-launcher
```

已下载源码时，在插件目录的上一级执行第二行即可；`package.json` 就在仓库根目录，无需构建或安装依赖。

在 Magpie 的「插件」中确认插件已启用，打开侧栏「Claude Code 快捷启动」。本地目录原地加载，安装后不要删除或移动目录。修改页面后关闭再开启插件。

## 使用

在 VPS 启动 Magpie Web（网关模式），在运行终端命令的电脑安装 Claude Code。页面同时预览 POSIX Shell 和 Windows PowerShell 两种单行启动命令：「复制」保留原有 POSIX 命令，「复制 PowerShell」复制 PowerShell 命令。首次打开须在「连接配置」填写网关密钥并保存，配置完整前两个复制按钮均禁用，避免复制不可用的命令。

网关地址默认从插件自己的 `location.href` 解析：必须是 HTTP(S)，且路径包含 `/_magpie/plugin/`，随后取 `new URL(location.href).origin`（协议、主机及端口）。不使用沙盒的 `window.origin`，不读取父窗口，也不发起网络请求。

- `https://magpie.example.com/_magpie/plugin/<token>/index.html` → `https://magpie.example.com`
- `https://magpie.example.com:8443/_magpie/plugin/<token>/index.html` → `https://magpie.example.com:8443`
- `http://localhost:3430/_magpie/plugin/<token>/index.html` → `http://localhost:3430`；`127.0.0.1` 同样原样保留，不改写成端口 3425。
- 无法读取 URL、非 HTTP(S)、或没有插件路径：地址留空，展开配置并提示手动填写；绝不回退到 `127.0.0.1`。

例如访问 `https://magpie.example.com`，填入该网关颁发的密钥后生成以下命令（示例中的密钥只是说明，不是默认值；每条均为单行，无末尾换行）：

**POSIX Shell（Bash / Zsh 等）**，点击「复制」：

```sh
ANTHROPIC_BASE_URL=https://magpie.example.com ANTHROPIC_API_KEY='<你的网关密钥>' claude
```

采用前缀环境变量写法，不使用 `export`，只对本次 `claude` 进程及其子进程生效，不改变当前终端环境或后续命令。

**Windows PowerShell**，点击「复制 PowerShell」：

```powershell
$env:ANTHROPIC_BASE_URL='https://magpie.example.com'; $env:ANTHROPIC_API_KEY='<你的网关密钥>'; claude
```

PowerShell 命令会修改当前会话环境变量，后续命令也会继承，不会自动恢复原值；不会永久修改用户或系统环境变量。

按终端类型选择对应命令，粘贴后按终端提示确认执行。两种命令均不适用于 CMD，均不修改 Claude Code 配置文件。页面不会安装或执行 `claude`，也不会探测网关是否可用。

## 配置

展开「连接配置」，修改网关地址及 API 密钥，点击「保存配置」。通过 `magpie.options.get()` / `.set()` 读取和持久化到此插件的选项：

```json
{
  "baseUrl": "https://magpie.example.com",
  "apiKey": "<你的网关密钥>"
}
```

缺省 `baseUrl` 使用当前网页 origin，缺省 `apiKey` 为空。保留自动识别出的地址保存时，不写死 `baseUrl`，以后换访问域名或端口仍自动跟随；改成其他地址才持久化手动覆盖。将覆盖值改回当前网页 origin 后保存，即恢复自动模式。

可手动覆盖成反向代理域名、其他端口或所需基路径；自动推导只保留 origin，不保留反向代理的子路径。已有手动配置优先，保存保留其他选项字段。旧版已保存的 `127.0.0.1:3425` / `magpie` 不会被静默覆盖，升级后请手动改为 VPS 地址和网关密钥。

POSIX 值不含特殊字符时原样输出；含 Shell 特殊字符时用单引号包裹，其中的单引号转义为 `'"'"'`。PowerShell 值始终用单引号包裹，内部单引号 `'` 写成 `''`，不复用 POSIX 转义。两种命令均将值作为字面量，不作为命令执行；共用现有配置校验，拒绝空密钥、换行、NUL 和非 HTTP(S) 地址。

密钥会明文保存在 Magpie 的 `plugins.json`，并出现在页面命令、剪贴板及 Shell 历史中。仅使用 Magpie 网关密钥，不要填写上游服务密钥。

## VPS 的网关密钥与网络条件

- **默认密钥留空**，不再预填 `magpie`。在 VPS 的 **Gateway → Gateway keys** 创建已启用、可调用所需模型的网关密钥，或在 VPS 运行 `magpie gateway-key add "Claude Code"`，再填入插件。CLI 只在创建时打印凭据，不要提交到仓库。
- **网页登录密钥 `MAGPIE_WEB_KEY`、浏览器登录 Cookie、上游厂商 API Key 都不是 Gateway Key**，不能拿来代替。页面不会自动读取任何真实密钥。
- 开启 **Settings → Network and sharing → Share on local network**，或令 `MAGPIE_ADDR` 监听网络地址，例如 `0.0.0.0:3425`。`magpie web --addr 0.0.0.0:3430 --gateway` 只开放网页，不等于开启网关共享；只开网页时 API 会返回 403。
- Magpie Web 的端口同时提供 `/v1/…` 及无 `/v1` 前缀的网关路由，反向代理只转发 Web 端口即可；因此默认使用浏览器访问的地址，不猜测另外的网关端口。
- **Web 端口上的 API 一律按远程请求鉴权，即使 URL 是 localhost / 127.0.0.1**。需要启用的网关密钥，空值、占位值 `magpie` 或网页登录密钥不适用。仅直接访问本机网关自身端口时，Magpie 才可能允许任意 token；此例外不适用于默认推导出的 Web 地址。
- 跨公网使用 HTTPS / VPN；不要将未保护的 HTTP 管理页面和密钥直接暴露公网。

文档：[Remote magpie](https://usemagpie.ai/docs/remote)、[Docker 的端口与网关密钥](https://usemagpie.ai/docs/docker)、[Reference: Connecting anything else](https://github.com/yetone/magpie/blob/main/docs/reference.md#connecting-anything-else)。

## 沙盒与剪贴板

- 由 Magpie 提供 `_magpie/bridge.js`；其余资源都在 `page/` 内。
- 没有内联脚本、外部依赖或网络请求；不申请读取权限，兼容 `sandbox="allow-scripts"`、`connect-src 'none'`。
- 点击复制时先调用 `navigator.clipboard.writeText`；不可用或拒绝时回退到临时 `textarea` + `document.execCommand("copy")`，最后移除临时元素。
- 只有 API 完成或 `execCommand` 返回 `true` 才显示成功。两者都失败时明确提示失败，并显示已选中的文本供手动复制。
- 这是浏览器允许范围内的尽力复制；无法保证所有 WebView / 浏览器都允许剪贴板访问。

契约参考：[Pages in the window](https://usemagpie.ai/docs/plugins#pages-in-the-window)。

## 验证记录

PowerShell 支持本地检查：

- JavaScript 语法与 Git 空白检查通过；46 项命令、配置、剪贴板及真实 Bash / sh / PowerShell 执行检查通过，POSIX 输出与修改前逐字一致。
- PowerShell 7.6.9（Linux）执行生成命令：单引号、空格、美元符号、反引号、分号及中文原样传入，无测试注入执行，当前会话环境变量按预期保留；Bash / sh 前缀不改变后续命令环境。
- Chromium 实际复制粘贴核对两种命令，PowerShell 的原生 `execCommand` 回退成功；模拟自动复制失败时，手动文本与对应预览一致并完整全选，临时元素清理。
- 已查看桌面、390px 窄屏、空密钥及 PowerShell 手动复制状态，双按钮与双预览无横向溢出。使用模拟 Magpie 选项桥接，未修改真实桥接；未验证原生 Windows PowerShell 或真实 Claude Code 模型请求。

此前 `0.1.1` 本地检查（新增 PowerShell 支持前）：

- JavaScript 语法与 Git 空白检查通过；33 项命令、配置、剪贴板及 Shell 检查通过。
- 在 Bash / sh 中用临时 `claude` 可执行文件接收环境变量，核对特殊字符原样传入、无注入执行，且当前终端原有变量不变。
- Chromium 实际复制并粘贴逐字匹配；本地 `sandbox="allow-scripts"` iframe 复制成功。模拟两种复制 API 均失败时，手动文本完整全选、临时元素清理。
- 检查桌面、390px 窄屏、空密钥、配置展开及复制失败状态：一个命令块、一个复制按钮，无页面横向溢出。

该版本浏览器验证使用模拟 Magpie 选项桥接，未重新安装或运行真实 Magpie；默认值与配置持久化调用逻辑保持不变。

此前版本已用官方 Magpie `0.1.2895` Linux CLI，在独立 `HOME` / `XDG_CONFIG_HOME` 中安装并通过真实 Magpie Web 的沙盒 iframe 验证（Chromium）。VPS 场景以 `0.0.0.0:3430` 监听，并通过非回环 IP 访问：

- 实测沙盒 `window.origin === "null"`，但 `location.href` 仍是带真实主机、端口及插件路径的完整 URL，能够据此推导网页 origin。
- 网络监听模式下通过 Web 端口请求 `/v1/models`：无密钥、`magpie`、网页登录密钥均为 401；有效网关密钥（`x-api-key` / Bearer）为 200。Web 回环地址加 `magpie` 仍为 401；直接访问本机网关端口加 `magpie` 为 200。仅开放 Web、未开启共享且网关只监听回环时，Web API 为 403。
- 旧版四个按钮均实际复制并粘贴核对，内容逐字匹配；真实 `navigator.clipboard` 不可用时，`execCommand` 回退成功。
- 注入 API 缺失、现代 API 成功、回退返回 `false` / 抛异常，核对成功／失败提示、手动文本全选及临时元素清理。
- 真实桥接保存配置，重新打开后持久化；保留其他已有选项字段，拒绝非法 URL。
- 带引号、空格、命令替换及其他 Shell 特殊字符的测试值，执行生成命令后得到原始值，未执行注入内容；测试中用本地函数替代 `claude`。
- 检查浅色、深色、窄屏及配置展开／复制失败界面，无页面横向溢出。

限制：未验证原生 WebKit 窗口，也未通过真实 Claude Code 发起模型请求。本插件仅负责生成、保存及复制启动命令。

版本差异：上述 Magpie 版本在全新 HOME 添加这个纯页面插件时仍自动下载了 Bun，与文档的无需 Bun 描述不一致；插件没有服务端入口或 Bun 依赖，但不能保证该版本的 Magpie 安装流程完全不下载 Bun。

## 许可

[MIT](LICENSE)
