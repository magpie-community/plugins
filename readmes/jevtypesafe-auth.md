# Magpie 的 JEV 托管决策插件

<img src="icon.svg" width="72" height="72" alt="JEV 托管决策">

[English](README.en.md)

把 [jevtypesafe.org](https://jevtypesafe.org/zh/docs/api/#decide) 的 **JEV decide 接口**接成 [Magpie](https://usemagpie.ai) / [OpenCode](https://opencode.ai) 的**原生决策分类器**。无需修改 Magpie、无需运行代理、无需安装 npm 依赖。

**JEV 是决策模型，不是聊天或代码生成模型。** 它用于路由组的意图分类，以及 Magpie 原生的自动推理等级；组内仍需配置真正负责回答的聊天模型。

## 功能

| 项目 | 值 |
|---|---|
| 供应商 ID | `jevtypesafe` |
| 模型 | `jevtypesafe/jev` |
| 支持问题类型 | `choice`、`score`、`noul` |
| 上游地址 | `POST https://jevtypesafe.org/api/v1/decide` |
| 登录方式 | 你的 `jv_live_…` API 密钥，由 Magpie 保存 |

Magpie 会把每个问题发到 `POST {baseURL}/systemone`，经插件的 loader `fetch` 转换为 JEV 的 `decide` 请求，加上 Bearer 密钥，并把上游 `Response` 原样返回——状态码、响应体和重试头都保持不变。

首版不包含：图片 assets、`box` 问题、批量决定、confidence `gate`、余额查询，也不模拟聊天协议。没有编造的价格、免费标记或实时余额。

## 安装

**一键安装：** [在 Magpie 中安装](magpie://plugin?name=jevtypesafe-auth) 会打开 Magpie 的插件详情页，看过内容后按「安装」。

### 从 npm 安装（推荐）

```powershell
magpie plugin add jevtypesafe-auth
magpie plugin login jevtypesafe
```

### 从本地目录安装

1. 克隆本仓库后**保留整个目录原地不动**——文件夹插件是就地加载的，不会复制；之后不要删除、改名或移动它。
2. 在 Magpie 打开 **插件 → 添加插件**，选择这个目录（不要选 ZIP、测试脚本）。
3. 找到供应商 **JEV 托管决策**，用你在 jevtypesafe.org 账户页创建的 `jv_live_…` 密钥登录。
4. 编辑路由组：意图分类器选 `jevtypesafe/jev`，保留组内原有的回答模型，再设置意图规则。
5. 需要自动推理等级时，使用路由组内的相应设置；回答仍由组内聊天模型产生。

> **在 Magpie 里搜不到是正常的。** Magpie 的搜索会向 npm 发 `<关键词> opencode`，只读 30 条结果，按周下载量排序，新包排不进这个范围。在它有下载量、或被收进 [magpie-community 的列表](https://github.com/magpie-community/plugins) 之前，请用上面的一键链接、npm 包名或本地目录安装。
>
> **搜索结果里的卡片没有图标，这是 Magpie 的行为，不是本插件的问题。** Magpie 用 npm 搜索接口的返回构造这些卡片，而那个接口不携带 `magpie.icon`；只有插件被列表收录或已经安装时，Magpie 才会去读包自己的 `magpie.icon`。装上之后图标就会显示；等列表收录后，**发现**页的卡片上也会显示。

```powershell
magpie plugin add .\magpie-jevtypesafe     # 你克隆下来的那个目录
magpie plugin login jevtypesafe
magpie plugin                       # jevtypesafe（JEV 托管决策，1 个模型）已登录
magpie provider test jevtypesafe    # 发一次真实决策请求，会计费
```

`provider test` 会真实调用上游并消耗额度。密钥在登录提示里输入，不要放进命令参数、源码或版本管理。

修改本地目录插件的源码后，在插件页把它关闭再开启即可让宿主重新加载。

## 行为说明

- 只接受本供应商的 `POST /systemone`。其他主机、带查询串的地址、其他路径、`GET` 一律在本地拒绝（`400`/`404`/`405`），不会发出网络请求。
- 上游模型固定为 `jev`（1× 扣费），不会静默切换到扣费倍率不同的模型。
- `state` 可为字符串、对象或数组。按紧凑 `JSON.stringify(state)` 的 JavaScript 字符串长度检查 8,000 字符上限；超限返回明确错误，**不会**截断你的上下文。包含补充平面字符时，这个计数比按 Unicode 码点更严格。
- 只向上游发送 `model`、`state`、`questions`。问题内部的 instructions 与 criteria 原样透传，更细的校验由服务端完成。
- 上游的 `401`、`402`、`429`、`5xx`，连同响应体和重试头，都原样交回 Magpie。插件自身不重试，所以一次失败不会悄悄扣两次额度；宿主的故障转移仍按你的设置运行。
- 取消请求会传递到上游。不转发 Cookie、其他供应商的密钥或 Magpie 内部请求头；禁止跟随重定向，避免密钥被带到别处。
- 没有定时器和余额轮询：刷新插件卡片不会消耗 JEV 额度。
- 不声明 `auth.usage`，因为接口没有提供余额端点。插件宁可不显示额度，也不编造一个。

## 开发

测试脚本需要 Node.js 22 或更高版本；插件本身由 Magpie 自带的 Bun 运行。零依赖，无需 `npm install`。

```powershell
npm run check
npm test
npm run test:coverage
```

### 隔离 Magpie 验证

`npm run verify:magpie` 会用独立的 `HOME`、配置、缓存、数据目录和随机本地端口启动一个真实的 Magpie，注册插件、拉起网关，提交一次三问题决策请求，并断言决策模型不出现在聊天目录中、向它发聊天请求会被拒绝。结束后删除沙箱；你的真实配置文件只做前后哈希比较，不会读取或输出凭据内容。

```powershell
$env:MAGPIE_BIN = 'path\to\magpie-windows-amd64.exe'
$env:MAGPIE_BUN = Join-Path $env:USERPROFILE '.cache\magpie\bun\<版本>\magpie-bun.exe'
npm run verify:magpie
```

默认指向本地模拟上游并使用假密钥，不产生费用。

需要重跑真实链路时，用临时环境变量传入密钥——它只会写入沙箱的鉴权文件，并在报告里脱敏：

```powershell
$secret = Read-Host 'JEV API 密钥' -AsSecureString
$env:JEV_API_KEY = [System.Net.NetworkCredential]::new('', $secret).Password
try { npm run verify:magpie -- --live } finally { Remove-Item Env:JEV_API_KEY -ErrorAction SilentlyContinue }
```

`--live` 会计费一次三问题决策。

## 已验证

- 42 项离线测试全部通过；生产入口的行、分支、函数覆盖率均为 100%。
- 隔离的 Magpie 成功加载插件，三问题决策返回 HTTP 200，向同一模型发聊天请求被拒绝。
- 一次针对 jevtypesafe.org 的真实隔离运行返回 `jev-1.14.0`，`choice`、`score`、`noul` 三类问题均有结果。
- 隔离运行前后，宿主的真实 `plugins.json`、`plugin-auth.json`、`providers.json`、`settings.json` 字节一致。

接口依据：[JEV API 文档](https://jevtypesafe.org/zh/docs/api/#decide)、[Magpie 插件文档](https://usemagpie.ai/docs/plugins#decide)，以及 Magpie 源码中的 `internal/gateway/plugin_decide_test.go`。

## 卸载

1. 先把使用该分类器的路由组切回其他可用分类器。
2. 在插件页移除插件，或执行 `magpie plugin rm <spec>`。
3. 确认移除后，才能删除插件目录。

不需要清空 `providers.json`，也不会影响你的其他供应商配置。

## 许可证

MIT
