<h1 align="center">天枢 Tianshu · Magpie 插件</h1>

<p align="center">
  <b>把天枢接进 Magpie 的 Agent 页 —— 每个订阅软件各占一个渠道</b><br>
  <sub>装上一次，订阅的模型各归各的渠道 · 关掉即恢复原值</sub>
</p>

<p align="center">
  <a href="https://github.com/BeyondTokensGGG/magpie-agent-TianshuHarness"><img src="https://img.shields.io/badge/Magpie-agent-4285F4" alt="Magpie agent"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-34A853" alt="License: MIT"></a>
  <a href="https://github.com/BeyondTokensGGG/magpie-agent-TianshuHarness"><img src="https://img.shields.io/github/stars/BeyondTokensGGG/magpie-agent-TianshuHarness?color=181717&label=Stars&logo=github" alt="Stars"></a>
  <a href="https://github.com/huiliyi37/Tianshu-harness"><img src="https://img.shields.io/badge/Tianshu-rivet%20harness-8B5CF6" alt="Tianshu"></a>
</p>

<p align="center">
  <a href="#安装"><b>安装</b></a> ·
  <a href="#订阅软件各占一个渠道"><b>渠道拆分</b></a> ·
  <a href="#天枢怎么命名模型"><b>模型命名</b></a> ·
  <a href="#插件不声明的东西"><b>不声明的东西</b></a> ·
  <a href="#验证"><b>验证</b></a>
</p>

将 [天枢](https://github.com/huiliyi37/Tianshu-harness)（Tianshu / rivet harness）接入 Magpie 的 **Agent 页**。装上这个插件后，天枢出现在 Agent 页；Magpie 把网关和模型写进天枢的配置，关掉即恢复原值。

## 订阅软件各占一个渠道

Magpie 会把多个订阅软件的模型都递过来。这个插件**按软件拆开注册**：`workbuddy/…` 的模型进 `workbuddy-magpie`，`codex/…` 的进 `codex-magpie`，`doubao/…` 的进 `doubao-magpie`，以此类推。Magpie 自己的路由组 `auto/…` 不属于任何软件，也有自己的一行：`auto-magpie`。

这样在天枢的供应商列表里，每个订阅是一行，不混在一起。渠道的标识名（key）是小写的 `<软件>-magpie`——天枢要求供应商标识只含小写字母、数字和 `-`；显示名则是 `Workbuddy Magpie` 这样好读的形式。

分组看模型 id 里 `/` 之前那段，与 Magpie 的 `owned_by` 无关：Magpie 递进来的模型只有 id、容量和能力，不带归属软件，而 id 里的前缀正是它。没有 `/` 的模型不属于任何软件，跟路由组一起放在 `auto-magpie`。

### 为什么没有叫 `magpie` 的渠道

`magpie` 是这个插件拆分**之前**用的名字。天枢把供应商的模型列表另存在 `~/.rivet/provider-keys.json`，而那里的列表只增不减：旧版写进 `magpie` 名下的全部模型，会在插件升级后继续留在那份文件里。拆分后实测过一次，断开再重连都清不掉，池里仍挂着旧版留下的 45 条。

所以路由组的渠道叫 `auto-magpie`，不叫 `magpie`。新版插件不写 `magpie` 这个供应商，天枢就找不到它去对应池里的旧条目，**界面上不会再出现那个堆满模型的 `magpie` 渠道**。

这条不变量靠的是「不占用 `magpie` 这个键」，不是靠那条旧记录消失——它什么时候、因为什么消失没有稳定复现，断开和重连都不是原因。最后一次核对时，池文件里已经没有 `magpie` 键（12 个供应商全是现役）。所以有没有旧条目，插件的行为都一样。

## 安装

在 Magpie 搜索 **Tianshu**（插件 → 发现 → 非官方插件 · GitHub），或直接添加：

```text
github:BeyondTokensGGG/magpie-agent-TianshuHarness
```

也可以从本地源码安装：

```sh
magpie plugin add /绝对路径/magpie-agent-tianshu
```

安装后点 Magpie 顶栏的「重新检测本机的 Agent」。保持 Magpie 网关运行。

接线与断开都走 `provider` 这一个字段：

```sh
magpie tianshu provider magpie   # 接线
magpie tianshu provider default  # 断开，恢复成接入前的样子
```

> [!WARNING]
> **不要**用 `magpie tianshu <模型>`。这个插件不声明 `model` 字段（原因见下节），所以天枢那边没有「模型」这个字段可设，那条命令会报 `has no field "model"`。旧文档里写的 `magpie tianshu magpie/provider/model` 是错的。选具体模型请在天枢里选。

> [!NOTE]
> 天枢在新的会话读取配置：改完请重启天枢或新开会话。

## 天枢怎么命名模型

天枢用**两个键共同**决定模型：

| 键 | 值 |
| --- | --- |
| `provider.default` | 供应商 key，如 `workbuddy-magpie` |
| `agent.defaultModel` | `<供应商 key>:<模型 id>`，其中 id 必须是该供应商 `models` 里的一个 |

冒号是天枢自己的分隔符，冒号后的 id 必须出现在该供应商的模型列表里。插件把这些键**直接写进** `~/.rivet/config.json`，包括每一个 `<软件>-magpie` 供应商，而不是往你已配置的供应商里塞。

<details>
<summary><b>为什么插件不声明 <code>model</code> 和 <code>prefix</code></b></summary>

Magpie 的 `plugged.go` 里，描述符一旦声明了 `model`，Magpie 就用自己的静态 `prefix` 把 `agent.defaultModel` 写成 `prefix + id`，只可能指向一个供应商；两个都不声明，`connect` 返回的每一个键才被原样写入，多个供应商也才立得住。

代价是 Magpie 的 Agent 页上没有「选模型」那一步，改为供应商开关；选模型在天枢里做。

</details>

<details>
<summary><b>容量字段：为什么未知就不写</b></summary>

容量按**天枢的字段名**写（`contextWindow`、`maxTokens`、`supportsVision`），不是 Magpie 递过来的那套（`context`、`output`、`images`）。

Magpie 对它不认识的模型递的是 `0`，而天枢把 `0` 读成没有预算，所以未知容量不写，绝不编一个数出来。

</details>

写入 `~/.rivet/config.json` 的形状（`keyRef` 由 Magpie 自己分配，实际接入时写入；此处省略）：

```json
{
  "provider": {
    "default": "auto-magpie",
    "providers": {
      "auto-magpie": {
        "name": "Auto Magpie",
        "baseUrl": "http://127.0.0.1:3425/v1",
        "protocol": "openai",
        "apiKey": "magpie-tianshu",
        "models": [{ "id": "auto/minimax-m3.1-flash", "contextWindow": 1048576, "maxTokens": 524288, "supportsVision": true }]
      },
      "workbuddy-magpie": {
        "name": "Workbuddy Magpie",
        "baseUrl": "http://127.0.0.1:3425/v1",
        "protocol": "openai",
        "apiKey": "magpie-tianshu",
        "models": [{ "id": "workbuddy/deepseek-v4.1-flash", "contextWindow": 1000000, "maxTokens": 393216 }]
      }
    }
  },
  "agent": { "defaultModel": "auto-magpie:auto/minimax-m3.1-flash" }
}
```

`provider.default` 与 `agent.defaultModel` 指向 Magpie 递来的第一个模型所在的渠道，两者始终一致——天枢不接受指向不存在的供应商、或该供应商不提供的模型的 `defaultModel`。

你其他的供应商、MCP 服务器、技能和其余设置都原样保留。关掉连接时，这两个键恢复成接入前的样子；原来没有的键会被删掉。

## 检测

Magpie 靠天枢自己的命令 `tianshu` 判断它装没装（`tianshu-harness` 的安装器把它放到 `PATH` 上）。

插件**不**把 `~/.rivet` 写成 Agent 的目录：那个目录是天枢放设置的地方，一个文件夹的存在不证明程序装了。接入之后，`~/.rivet/config.json` 里有网关 key，就足以让它继续保持被检测到。

## 插件不声明的东西

| 字段 | 为什么不声明 |
| --- | --- |
| **`model` / `prefix`** | 见上：声明了，Magpie 就把 `agent.defaultModel` 钉死在自己那个静态前缀上，多供应商写不进去 |
| **`library`** | 天枢的全局技能是 `~/.agents/skills` 和 `~/.rivet/skills`，而 `~/.agents/skills` 本身就是 Magpie 资源库的源目录，两边本来就共享。再声明 `~/.rivet/skills` 会让同一个技能被注册两次 |
| **`mcp`** | `tianshu` 不是 Magpie 能写的那些 MCP 格式之一，而且天枢的服务器在同一个文件的 `mcp.servers` 下，结构不一样 |

## 验证

```sh
npm test
```

覆盖 `keyFor` 的分组、`connect` 返回的每一个键、以及「`provider.default` 与 `agent.defaultModel` 必须指向同一渠道且该渠道确实有这个模型」。

`tianshu.agent.js` 运行在 Magpie 的 moejs 沙盒里，无 Node、无文件系统访问，所以它是一个文件、不 import 任何东西。

MIT License