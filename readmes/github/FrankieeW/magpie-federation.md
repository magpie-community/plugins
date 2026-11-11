# magpie-federation

在 Magpie 左侧提供「远端看板」，使用已保存的远端网关凭据自动连接。看板显示远端用量、额度、余额、供应商图标和模型价格，供应商下的模型可以按需展开。

看板右上角提供启用开关和模式选择。

| 状态 | 行为 |
| --- | --- |
| Lite | 只启用远端看板，暂停本插件管理的供应商和 MCP 接入 |
| 完整 | 启用看板，将远端各家供应商分别接入原生列表，并按配置连接 MCP |
| 关闭 | 停止看板读取，暂停本插件管理的所有接入 |

新配置默认使用 Lite。已有 0.3 配置在显式选择模式前按完整模式解析。切换模式时记录接入状态，切回完整模式时按原来的启用状态和 Agent 选择恢复。

## 安装与连接

需要 Bun 和 Magpie。当前开发验证使用 Magpie 0.1.3302。

```sh
bun install
export NETCUP_MAGPIE_KEY='远端 Magpie 的网关密钥'
bun run connect netcup url=https://magpie.example.com keyEnv=NETCUP_MAGPIE_KEY name=netcup
```

安装包提供 `magpie-federation` 命令。

```sh
magpie-federation connect netcup url=https://magpie.example.com keyEnv=NETCUP_MAGPIE_KEY
magpie-federation mode lite
magpie-federation mode full
magpie-federation off
magpie-federation on
magpie-federation sync
```

`connect` 保存服务器并应用当前模式。`sync` 重新应用配置。操作失败后可再次执行 `sync`，继续完成已记录的操作。

打开 Magpie 侧栏的「远端看板」即可自动读取数据。启用开关与模式选择也可以直接在看板中操作。

## 完整模式

远端 `netcup` 的供应商分别显示为 `DeepSeek · netcup`、`OpenAI · netcup` 等独立入口。路由组有自己的入口，路由和回退由远端执行。

每家供应商使用独立的本机转发地址，通过 Magpie 原生远端读取保留远端公开的信息。

- 供应商图标、套餐、账户、余额、额度窗口、重置时间和套餐到期时间。
- 模型上下文、输入输出能力、推理档位、服务档位、决策模型及其他模型类型。
- 输入输出价格、缓存读写价格、一小时缓存写入价格、阶梯价格和价格条件。
- 完整额度卡片中的每日用量、余额分项和其他远端公开字段。

图标优先采用远端额度卡片或统计中报告的图标。内置图标使用同名资源，自定义文件使用可读取的远端图片或本机相同缓存。无法取得自定义文件时使用对应供应商的内置图标，并在同步时提示。

模型目录与额度卡片按供应商筛选后转发。未公开的价格或额度保留为未知。远端的网关权限限制也会继续作用于这些读取。

MCP 可以整台服务器接入，也可以按远端工具命名空间分别接入。

| 连接参数 | 行为 |
| --- | --- |
| `name=netcup` | 服务器显示名称，默认使用 id |
| `providers=codex,deepseek,group` | 完整模式只导入这些来源 |
| `mcp=hub` | 默认值，完整模式将远端 MCP hub 接入一个资源库条目 |
| `mcp=servers` | 按远端 hub 的工具命名空间分别接入资源库 |
| `mcp=off` | 完整模式只接入供应商 |

MCP 初次接入时在资源库选择使用它的 Agent。`mcp=servers` 按工具名 `<namespace>__<tool>` 中第一个 `__` 分组。

## 配置

配置文件默认位于 `~/.config/magpie-federation/config.json`，遵循 `XDG_CONFIG_HOME`。`MAGPIE_FEDERATION_CONFIG` 可以指定其他文件。

```json
{
  "enabled": true,
  "mode": "lite",
  "port": 3487,
  "servers": [
    {
      "id": "netcup",
      "name": "netcup",
      "url": "https://magpie.example.com",
      "keyEnv": "NETCUP_MAGPIE_KEY",
      "mcp": "hub"
    }
  ]
}
```

`keyEnv` 从插件宿主的环境读取。图形界面启动的 Magpie 需要继承该环境变量。也可以在权限为 `600` 的配置文件中使用 `key` 字段。

公网连接使用 HTTPS。HTTP 接受回环、内网和 Tailscale 地址。远端请求拒绝重定向，网关密钥由本机服务使用。浏览器只获得单独的看板会话令牌。

本机服务只监听回环地址，并检查连接的系统用户。看板的模式切换请求需要会话令牌。Lite 和关闭状态会拒绝供应商转发与 MCP 调用。

## 升级

0.3 的供应商钩子会在切入完整模式时迁移为独立的原生连接，沿用原有的供应商 id 和模型 id。Lite 会停用旧钩子。

旧版配置的 `remotes` 数组可以复制到新配置路径后使用。生成的运行时引用当前安装目录，安装路径变化后执行 `sync` 更新引用。

## 验证

```sh
bun run typecheck
bun test
bun run e2e
```

端到端检查使用两套隔离的 `HOME` 和 `XDG_*` 目录及两台真实 Magpie，验证供应商归属、完整图标和价格继承、额度读取、流式转发、回退、MCP、旧版本迁移，以及 Lite、完整和关闭之间的切换。
