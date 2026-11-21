# magpie 的天枢接入插件

在 [magpie](https://usemagpie.ai) 的 **Agents** 页给 [天枢](https://github.com/huiliyi37/Tianshu-harness) 选一个模型，天枢就能用上 magpie 里的全部供应商和路由组。

天枢（Tianshu / rivet）是一个编程 agent 运行时，终端、桌面端和 VS Code 插件共用同一个内核。它自己支持很多模型供应商，但配置起来要手写 JSON。装了这个插件之后，你在 magpie 里点一下，天枢就连上了 magpie 的网关，magpie 里有什么模型，天枢就能用什么模型。

## 安装

先确认天枢已经装好：

```bash
tianshu --version
```

没装的话先装天枢：`npm install -g tianshu-harness`。

然后安装本插件：

```bash
magpie plugin add magpie-agent-tianshu-harness
```

打开 magpie，左侧进 **Agents**，会看到一行 **天枢 Tianshu**。

## 使用

在天枢那一行点模型下拉框，选一个 magpie 的模型。选完就接通了。

也可以走命令行：

```bash
magpie models tianshu                      # 看看有哪些模型可选
magpie tianshu group/gemini                # 选这个
magpie tianshu default                     # 取消接入，天枢恢复原样
```

**选完模型后要重开天枢。** 天枢只在会话开始时读配置，已经开着的会话还在用旧模型。

## 它做了什么

在 `~/.rivet/config.json` 里写入一个 magpie 供应商，并把天枢的起始模型指向它：

```json
{
  "provider": {
    "default": "magpie",
    "providers": {
      "magpie": {
        "name": "magpie",
        "baseUrl": "http://127.0.0.1:3425/v1",
        "protocol": "openai",
        "apiKey": "<magpie 的网关密钥>",
        "models": [
          {
            "id": "group/gemini",
            "contextWindow": 1048576,
            "maxTokens": 65536,
            "supportsVision": true,
            "capabilities": {
              "effortFormat": "reasoning_effort",
              "effortLevels": ["low", "medium", "high", "xhigh"],
              "reasoningSplit": true,
              "effortCap": { "max": "xhigh" }
            },
            "pricing": { "input": 3, "output": 15, "cacheRead": 0.15 }
          }
        ]
      }
    }
  },
  "agent": { "defaultModel": "magpie:group/gemini" }
}
```

这份文件里的其他内容——你原来的供应商、MCP 服务器、主题设置——都不会被动。magpie 在第一次写入前会记下这些键原来的值，你取消接入时它会还原。

模型清单会跟着 magpie 更新：magpie 那边加了模型、改了价格或推理档位，重开天枢就能看到。

价格已经换算过：magpie 按每个 token 报价，天枢按每百万 token 记账。

## 会用到的命令

| 命令 | 作用 |
|---|---|
| `magpie models tianshu` | 列出天枢可选的模型 |
| `magpie tianshu <model>` | 给天枢选模型 |
| `magpie tianshu` | 看天枢当前用哪个模型 |
| `magpie tianshu default` | 取消接入，恢复天枢原来的配置 |

## 注意事项

**同一台机器上只装一个天枢插件。** 所有 magpie 的天枢插件都使用同一个 agent id `tianshu`，装了两个也只有其中一个生效，另一个会一直挂着但不起作用。

**天枢的设置文件在** `~/.rivet/config.json`。这条路径取决于天枢怎么装的，想确认就直接问 magpie：

```bash
magpie tianshu          # 第一行末尾就是天枢的配置文件路径
```

**不支持自动写入 MCP 和技能。** magpie 的资源库能把 MCP 服务器和技能派发到 Agent，但天枢的 MCP 配置形状和技能加载路径都不在 magpie 支持的白名单里。硬写进去只会得到一个看起来接上、实际不生效的配置，所以这里没做。天枢的 MCP 服务器仍然在它自己的 `~/.rivet/config.json` 的 `mcp.servers` 里配置。

**天枢的供应商里可能有大语言模型不支持图片。** magpie 报的模型能力和实际不完全一致，个别标了视觉的模型可能拒绝图片输入。

## 许可

MIT。图标是 Tianshu-harness 项目的应用图标（`docs/brand/assets/app-icon.svg`），逐字节内联，出处见 NOTICE。
