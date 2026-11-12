# Magpie Search Center · Windows Preview

在 Magpie 内按需选择搜索渠道，管理多 Key、Grok 模型、真实测试和调用记录。独立社区插件，MIT；上游贡献见 THIRD_PARTY_NOTICES.md。

## 功能

- 14渠道适配：Grok、Tavily、Exa、Firecrawl、You.com、Brave、Parallel、Perplexity Search、博查、Serper、SearXNG、GitHub仓库、arXiv、Crossref。
- Agent按任务选择一个或多个渠道，以及Grok模型和搜索档位；返回来源和调用状态。
- 同一页面管理多Key、首选顺序、轮流调用和限流冷却。
- Grok默认启用网页和X搜索，可按次选择仅网页或仅X；记录展示接口报告的工具调用。
- 真实搜索测试、历史详情和链路回放；回放不发起新搜索。
- Tavily、Firecrawl额度查询，显示返回范围、更新时间和过期状态。

## 与现有搜索插件的区别

与 magpie-websearch、magpie-search-mix 的部分搜索来源重叠。Search Center 侧重 Agent 按次选择渠道、Grok 模型及网页/X搜索范围，并在 Magpie 内统一管理多 Key、搜索测试和来源记录。各渠道由搜索中心执行，其他搜索工具不会交给 Grok 再决定是否调用。已有渠道账号的额度仍由对应服务计算，不会因为安装本插件增加额度。

## 运行要求

- Windows 10/11，Python 3.12+。
- Magpie；本地安装流程已在v0.1.3351验证。
- 运行下方诊断命令需要Node 20+，插件本身由Magpie提供的Bun运行。
- 首次安装Python依赖需要网络。各搜索服务的账号和额度由使用者自行提供，You.com、GitHub公开仓库、arXiv和Crossref支持免Key入口。

## 从社区分发安装

本包名为 `@magpie-community/tools-search-center`。社区合并并生成 `dist` 分发包后，Magpie 可直接安装，不要求使用者注册 npm 账号：

```powershell
magpie plugin add @magpie-community/tools-search-center
```

本插件需要 Windows 和 Python 3.12+。安装后仍需在插件目录运行 `scripts/setup.ps1` 安装 Python 依赖；打开 Magpie 插件目录后按下节命令操作。不会在安装时自动运行脚本。

## 安装（源码或本地测试包）

1. 解压发布包到长期保留的目录，不放在下载临时缓存中。将解压出的 `package` 文件夹改名为 `magpie-search-center`，Magpie本地安装使用文件夹名作为插件标识。
2. 安装Python 3.12或更新版本，确认 `py -3 --version` 可用。
3. 在改名后的 `magpie-search-center` 目录运行：

```powershell
powershell -NoProfile -File .\scripts\setup.ps1
node .\scripts\doctor.mjs
magpie plugin add .
```

安装脚本在当前用户 `.magpie-search-center/venv` 创建独立Python环境并安装依赖。插件包含所需后端，不依赖旧grok-search MCP；直接在页面填写Key即可。

在 Magpie 插件页打开“搜索中心”，填入接口地址与Key，保存。Grok先获取模型列表，再填三档模型ID。在资源库将此插件的MCP分配给所需Agent；服务器名称可在资源库改为 `search`。对外工具为 `search`、`capabilities`。

如果 `magpie` 不在PATH，使用其完整程序路径；页面内分发按钮同样需要PATH或 `MAGPIE_BIN` 环境变量。也可直接在Magpie资源库中分发。

卸载本地插件后同步客户端入口：

```powershell
magpie plugin rm magpie-search-center
magpie library sync
```

若安装时用了其它文件夹名，以 `magpie plugin` 显示的标识为准。CLI移除插件后，资源库与Agent入口可能要到sync才清理；用户查询记录和凭据数据保留在独立数据目录。

## 凭据与数据

Key使用当前Windows用户DPAPI加密，已保存值不返回页面。数据保存在 `%USERPROFILE%/.magpie-search-center`，不是安装目录。更换Windows用户/机器后，密文不能直接解密，需要重新配置Key。
历史保留查询和来源URL。卸载插件后数据保留，便于重新安装后继续使用。

可选环境变量：

| 变量 | 用途 |
| --- | --- |
| SEARCH_CENTER_DATA_DIR | 独立数据目录，setup和插件必须使用同一值 |
| SEARCH_CENTER_PYTHON | 已装依赖的Python可执行文件路径 |
| MAGPIE_HOME | Magpie配置目录，默认用户目录下.config/magpie |
| MAGPIE_BIN | Magpie CLI路径；默认magpie |
| SEARCH_CENTER_PORT | 手动测试时改变本地服务端口；正式page.service端口也需一致 |

默认页面服务端口3479；同时运行多个实例时需使用不同端口和数据目录。

Firecrawl反代若有路径前缀，填写完整基础地址（例如 `https://your-host.example/firecrawl`）。Tavily号池余额要求服务实现兼容的 `/usage` 响应。

## Claude Desktop等stdio客户端

Magpie运行时，可让客户端使用上述venv中的 `Scripts/python.exe`，参数 `-B -u <安装目录>/stdio.py`。它通过FastMCP代理连接同一插件HTTP接口，不另存配置或账号。
默认目标 `http://127.0.0.1:3425/mcp/magpie/tools/magpie-search-center`；如资源库显示地址不同，以该地址设置 `SEARCH_CENTER_MCP_URL`。只向信任的本机Magpie端点连接。

## 使用说明

- `capabilities` 查看已配置渠道和Grok模型候选，`search` 执行查询。
- 显式指定渠道时只调用所选渠道；多渠道并行，结果去重。未指定时按档位选择来源。
- Grok需要支持Responses及搜索工具的服务和模型；默认允许网页与X搜索，实际调用由Grok决定。
- GitHub渠道检索公开仓库。当前不提供代码、Issue和私有仓库搜索。
- 同账户的多条Key额度不能重复相加；号池余额以服务端同步时间为准。

## 定位与来源

Search Center侧重Agent按次选择渠道、档位和模型，以及统一的多Key管理与调用记录。与magpie-websearch、magpie-search-mix有搜索源重叠；按需选择和可视管理是本插件的主要区别。

基于GrokSearch搜索后端和dsh-grok-search界面资源开发，账号列表参考Magpie原生交互。采用MIT许可证，原作者版权与许可声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
