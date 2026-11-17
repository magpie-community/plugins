# Pi Desktop For Magpie

把 [PI-Desktop](https://github.com/vastsa/PI-Desktop)（一个开源的桌面 AI 助手）接进 [Magpie](https://usemagpie.ai)（装在本机的 AI 网关，统一给各个 AI 工具选模型）。装好后，PI-Desktop 会像 Claude Code、Codex 一样出现在 Magpie 的 Agent 页里。

A [Magpie](https://usemagpie.ai) plugin that puts [PI-Desktop](https://github.com/vastsa/PI-Desktop) on the Agents page.

![Magpie 的 Agent 页里的 Pi Desktop For Magpie](docs/agents-page.png)

## 功能

- **在 Magpie 里选模型**：换模型后 PI-Desktop 里几秒内生效，不用重启。
- **思考强度**：在这一行设 Effort（思考强度，模型回答前想多久），PI-Desktop 的请求都按它来。
- **资源库**：Magpie 资源库里的指令、技能、MCP 服务（Model Context Protocol，模型上下文协议，让 AI 调用外部工具的标准）可以勾选给它。
- **用量单独统计**：PI-Desktop 花了多少，在 Magpie 的用量页单独一行。
- **不用填密钥**：PI-Desktop 里不需要配置任何密钥，请求都经过 Magpie，路由和脱敏照常生效。
- **不碰 PI-Desktop 的数据库**：只写它本来就会读的插件清单和登记表。

## 安装

在 Magpie 里打开 **插件 → 发现**，搜索 `Pi-Desktop-For-Magpie`，点 **安装**。它来自 GitHub，所以带「未审核」标记。

搜不到时，把下面这行粘到插件页的安装输入框里：

```
github:codecodegogogo/Pi-Desktop-For-Magpie
```

也可以用命令行（`plugin add` 就是“添加插件”）：

```sh
magpie plugin add github:codecodegogogo/Pi-Desktop-For-Magpie
```

## 第一次使用

1. 在 Magpie 的 **Agent** 页找到 **Pi Desktop For Magpie**，打开开关，选一个模型。
2. 完全退出 PI-Desktop（托盘图标也要退出），等几秒再打开。
3. 在 PI-Desktop 里新建对话，模型选 **Magpie**。

第 2 步只有第一次需要。之后在 Magpie 换模型，PI-Desktop 里的「Magpie」跟着换。

「Magpie」后面还列着 Magpie 的各个模型。在某个对话里直接选其中一个，这个对话就固定用它，同样经过 Magpie；这不会改变 Magpie 那一行选的模型。

## 更新和卸载

| 要做的事 | 在 Magpie 里 | 命令行 |
|---|---|---|
| 更新 | 插件 → 已安装，点更新 | `magpie plugin update` |
| 暂时不用 | Agent 页关掉这一行的开关 | `magpie pidesktopformagpie default` |
| 卸载 | 插件 → 已安装，移除它 | `magpie plugin rm pi-desktop-for-magpie` |

关掉开关或卸载后，PI-Desktop 下次启动时不再有 Magpie 的模型。

卸载后会留下两样东西，都不影响使用：

- PI-Desktop 的插件列表里可能还有一条叫「Magpie」的空插件，它不提供任何模型，可以在 PI-Desktop 里直接卸载。
- 如果在资源库里给它勾过 MCP 服务，卸载前先取消勾选，否则 `~/.agents/servers/` 下的 `magpie-*.json` 会留着。

## 说明

- **思考强度**：这一行的 Effort 设了值，就按它来，PI-Desktop 对话里选的思考等级不起作用；留空则按对话里选的。
- **资源库写到哪里**：指令写到 `~/.pi/agent/APPEND_SYSTEM.md`，技能写到 `~/.agents/skills`，MCP 服务写到 `~/.agents/servers/magpie-<名字>.json`，都在新对话生效。SSE 类型的 MCP 服务 PI-Desktop 不支持，会跳过。
- **数据搬过家也能用**：在 PI-Desktop 的「设置 → 系统 → 存储」里把数据挪到别的盘，插件会跟着找到新位置。
- **测试环境**：Windows 11、Magpie 0.1.4173、PI-Desktop 0.22.0。macOS 和 Linux 没有实测。

<details>
<summary>不生效时怎么查</summary>

看插件自己记的状态：

```sh
cat ~/.config/magpie-piapp/status.json
```

| 字段 | 含义 |
|---|---|
| `connected` | Magpie 里这一行是否已接入 |
| `model` | 当前所选模型 |
| `registry` | `ok` 已登记；`pending-quit` 要等 PI-Desktop 退出后才能登记；`no-pi-desktop` 没找到 PI-Desktop 的数据文件夹（还没装，或没启动过）；`unreadable` 登记表读不了，没有改动 |
| `mcp.count` | 已写给 PI-Desktop 的 MCP 服务数 |

下面的请求不花钱，Magpie 会直接拒绝，并回报它看到的所选模型和来源（应为 `agent=pidesktopformagpie`）：

```sh
curl -s -X POST http://127.0.0.1:3425/agent/pidesktopformagpie/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"piapp-probe","messages":[{"role":"user","content":"hi"}]}'
```

</details>

## 致谢

- [PI-Desktop](https://github.com/vastsa/PI-Desktop)：本插件适配的应用，图标也来自它。
- [unisong/magpie-pi-desktop](https://github.com/unisong/magpie-pi-desktop)、[blackzhuge/magpie-agent-pi-desktop](https://github.com/blackzhuge/magpie-agent-pi-desktop)：做法上参考过的两个同类插件。

本项目不是 PI-Desktop 或 Magpie 的官方插件。许可：[MIT](LICENSE)。
