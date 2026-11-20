# magpie-agent-dela

把 [Dela](https://github.com/Chang-Yo/Dela) 接入 [magpie](https://github.com/yetone/magpie) 的 Agent 插件：magpie 的模型网关、MCP 服务器和 Skills 可以直接给 Dela 使用。

**English.** A magpie agent plugin for Dela. It registers magpie's local gateway as a model provider in `~/.dela/config.json`, and lets magpie manage the MCP servers (`~/.dela/mcp.json`) and skills (`~/.dela/skills`) Dela reads. Requires Dela 3.1 or later (the plain-JSON config).

## 安装

```sh
magpie plugin add magpie-agent-dela
```

之后在 magpie 的 Agents 页面里打开 Dela 即可；关闭（Disconnect）后 magpie 写入的内容会按原样撤回。需要 Dela 3.1 及以上版本（配置为 `~/.dela` 下的 JSON 文件的版本）。

## 写入的内容

| 位置                    | 内容                                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------- |
| `~/.dela/config.json`   | 只写 `providers.magpie` 一项（网关地址、网关密钥、模型列表），其余内容与其他服务原样保留      |
| `~/.dela/mcp.json`      | magpie 资源库里勾选给 Dela 的 MCP 服务器，写在 `mcpServers` 下，格式同 Claude Code            |
| `~/.dela/skills/<name>` | magpie 资源库里勾选给 Dela 的 Skills，以链接（Windows 无权限时为带标记的副本）放入            |

模型的上下文窗口、最大输出、图片输入和推理档位会映射到 Dela 的模型设置；Dela 不认识的推理档位和未知的数值不会写入。magpie 的模型变化时会重写 `providers.magpie`，Dela 里对这一项模型设置的手动修改会被覆盖。

## 注意

- **网关密钥以明文保存在 `~/.dela/config.json` 中**（Dela 的其他服务密钥也是如此）。这是 magpie 为该 Dela 生成的专用密钥，只对本机网关有效。
- Dela 只支持 stdio 和 Streamable HTTP 的 MCP 服务器；magpie 写入的 SSE 服务器会被 Dela 跳过。Dela 也不展开 `${VAR}` 形式的环境变量引用。
- Dela 自带的内置 Skills 也在 `~/.dela/skills` 里；请不要在 magpie 里“导入”它们。

## 许可

GPL-3.0-or-later，与 Dela 相同。
