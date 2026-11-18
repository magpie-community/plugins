# Tianshu for Magpie

将 [天枢](https://github.com/huiliyi37/Tianshu-harness)（Tianshu / rivet harness）接入 Magpie 的 **Agent 页**。Magpie 本身没有为天枢准备的接线，装上这个插件后，它出现在 Agent 页，和 Magpie 自带的 Agent 一样：在天枢这一行选一个 Magpie 模型，Magpie 把模型写进天枢的配置；关掉即恢复原值。

## 安装

在 Magpie 搜索 **Tianshu**（插件 → 发现 → 非官方插件 · GitHub），或直接添加：

```text
github:MathDD/magpie-agent-tianshu
```

也可以从本地源码安装：

```sh
magpie plugin add /绝对路径/magpie-agent-tianshu
```

安装后点 Magpie 顶栏的「重新检测本机的 Agent」，展开「显示其余」即可在「未设置」里找到它。也可以走命令行（把 `provider/model` 换成已配置的模型）：

```sh
magpie tianshu magpie/provider/model
```

保持 Magpie 网关运行。断开：`magpie tianshu default`。

## 天枢怎么命名模型

天枢用**两个键共同**决定模型，所以插件两个都写：

| 键 | 值 |
| --- | --- |
| `provider.default` | 供应商 key，`magpie` |
| `agent.defaultModel` | `magpie:<模型 id>`，其中 id 必须是该供应商 `models` 里的一个 |

冒号是天枢自己的分隔符，冒号后的 id 必须出现在该供应商的模型列表里。所以插件给 Magpie 建一个**自己的**供应商 `magpie`，而不是往你已配置的供应商里写；同时把 Magpie 提供的全部模型写进该供应商的列表——这样你在天枢里后来选的模型，仍然是 Magpie 的。

容量按**天枢的字段名**写（`contextWindow`、`maxTokens`、`supportsVision`），不是 Magpie 递过来的那套（`context`、`output`、`images`）。Magpie 对它不认识的模型递的是 `0`，而天枢把 `0` 读成没有预算，所以未知容量不写，绝不编一个数出来。

写入 `~/.rivet/config.json` 的形状（`keyRef` 由 Magpie 自己分配，实际接入时写入）：

```json
{
  "provider": {
    "default": "magpie",
    "providers": {
      "magpie": {
        "name": "magpie",
        "baseUrl": "http://127.0.0.1:3425/v1",
        "protocol": "openai",
        "apiKey": "magpie-tianshu",
        "models": [{ "id": "rylive/deepseek-flash", "contextWindow": 1000000, "maxTokens": 393216, "supportsVision": true }]
      }
    }
  },
  "agent": { "defaultModel": "magpie:rylive/deepseek-flash" }
}
```

你其他的供应商、MCP 服务器、技能和其余设置都原样保留。选回天枢自己的模型，或关掉连接，这两个键都恢复成接入前的样子；原来没有的键会被删掉。天枢在新的会话读取配置：改完请重启天枢或新开会话。

## 检测

Magpie 靠天枢自己的命令 `tianshu` 判断它装没装（`tianshu-harness` 的安装器把它放到 `PATH` 上）。插件**不**把 `~/.rivet` 写成 Agent 的目录：那个目录是天枢放设置的地方，一个文件夹的存在不证明程序装了。接入之后，`~/.rivet/config.json` 里有网关 key，就足以让它继续保持被检测到。

## 插件不声明的东西

- **`library`** —— 天枢的全局技能是 `~/.agents/skills` 和 `~/.rivet/skills`，而 `~/.agents/skills` 本身就是 Magpie 资源库的源目录，两边本来就共享。再声明 `~/.rivet/skills` 会让同一个技能被注册两次。
- **`mcp`** —— `tianshu` 不是 Magpie 能写的那些 MCP 格式之一，而且天枢的服务器在同一个文件的 `mcp.servers` 下，结构不一样。

## 验证

```sh
npm test
```

覆盖 `connect` 返回什么、包声明了什么。此外在沙箱 `HOME` 里对真实 Magpie 跑过：天枢出现在 Agent 页、设模型后两个键都写入且你自己的供应商与 MCP 服务器保留、`magpie tianshu default` 把文件**逐字节**还原。

真实的付费模型写作需要在你自己的环境里验收。

## 开发

`tianshu.agent.js` 运行在 Magpie 的 moejs 沙盒里，无 Node、无文件系统访问，所以它是一个文件、不 import 任何东西。

MIT License
