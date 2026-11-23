# 湛卢 · Magpie（magpie-agent-zhanlu）

让 [Magpie](https://usemagpie.ai) 识别并管理本机的 [湛卢（Zhanlu Code）](https://ecloud.10086.cn/op-help-center/doc/article/78884) agent：

- **模型切换**：在 Magpie 的 Agents 页湛卢一行中挑选任意模型或路由组，Magpie 写入 `~/.config/zhanlu/zhanlu.json`（网关地址 + 专属 key + 模型表）；断开连接或切回湛卢自己的模型时，配置原样还原。
- **技能共享**：Magpie Library 中的技能安装到 `~/.agents/skills`（湛卢读取的通用技能目录）。
- **用量统计**：请求经 Magpie 专属 agent key 计入 Usage/Routing 视图。

## 安装

适用环境：安装了湛卢桌面版（Zhanlu Code）的机器（Windows 上已实测）。

**方式一：从 GitHub 安装（推荐）**

```
magpie plugin add github:1261823/magpie-agent-zhanlu
```

带 `magpie-plugin` topic 的仓库还会出现在 Magpie 的 Plugins → Discover → Unofficial 列表中。

**方式二：从本地文件夹安装**

拿到 zip 时先解压到任意目录（例如 `C:\Tools\magpie-agent-zhanlu`），然后：

- 图形界面：Magpie → Plugins → Add a plugin，填入该文件夹路径；
- 命令行：

```
magpie plugin add <文件夹路径>
```

**方式三：内网 git**

```
magpie plugin add git+https://<内网git地址>/magpie-agent-zhanlu.git
```

## 使用

1. 打开 Magpie → **Agents**，找到 **湛卢**。
2. 打开开关并从下拉列表挑选模型（例如 `ecloud-inner/moma/glm-5.3` 或某个 `group/…`）。
3. 湛卢的**下一个新会话**即使用新模型；进行中的会话不受影响。

切回湛卢自己的模型：在行的选择器里选湛卢登录自带的模型（`zhanlu/…`、`openai/…`），或在 Magpie 中断开连接，`zhanlu.json` 会恢复原状。

## 工作原理

湛卢的 agent 引擎读取 OpenCode 形状的配置 `~/.config/zhanlu/zhanlu.json`。本插件让 Magpie：

- 写入顶层 `model` 键：`magpie/<网关模型 id>`；
- 写入 `provider.magpie` 块：`@ai-sdk/openai-compatible`，`options.baseURL` 指向本地网关 `http://127.0.0.1:3425/v1`，`options.apiKey` 为 Magpie 给湛卢生成的专属 key，`models` 随 Magpie 模型列表自动热更新。

Magpie 只改写这些键，文件中其余内容（注释、顺序、其它 provider）保持不变；写入前的原值由 Magpie 备份，断开时完整还原。

## 边界与说明

- **接入/切换模型时请先退出湛卢**：湛卢的 agent 引擎常驻运行并持有 `zhanlu.json` 的文件句柄，而 Magpie 的写入方式是「写临时文件后改名覆盖」，Windows 在目标文件被占用时会拒绝改名（`Access is denied`）。因此接入、切换模型、断开连接前，请先完全退出湛卢（关闭所有湛卢窗口，必要时在任务管理器结束 `Zhanlu.exe` 及其 agent 进程），操作完成后再启动湛卢。Claude Code / OpenCode 等 CLI 型 agent 无此限制。
- **登录态不受影响**：湛卢的灵畿平台登录（`auth_zhanlu.json`）原样保留；接通 Magpie 时模型请求走 Magpie 网关，断开后回到灵畿直连。
- **Library 的 instructions / MCP**：暂未声明。湛卢的项目级 `AGENTS.md` 与 `zhanlu.json` 内 `mcp` 键的格式与 Library 写入方式尚需适配，后续版本补充。
- **多配置文件**：若你使用 `zhanlu.jsonc` 而非 `zhanlu.json`，请自行确认二者的加载优先级，必要时把 `agent.js` 中的 `config` 路径改为实际使用的文件。
- **检测**：Magpie 通过 `zhanlu` 命令（PATH）或 `~/.config/zhanlu` 目录判断湛卢是否安装。
- **WSL 里的湛卢**：Magpie 的内置 agent 白名单不含湛卢，插件方式的 agent 只在本机生效，因此 WSL 发行版里不会出现「湛卢」行。要让 WSL 里的湛卢也用 Magpie，需手动编辑该发行版内的 `~/.config/zhanlu/zhanlu.json`（把 `provider.magpie` 的 `baseURL` 指向 WSL 能访问到 Windows 的地址）。

## 已验证

- `zhanlu.json` 写入 `provider.magpie` + `model` 后，`zhanlu cli models magpie` 能列出模型；
- `zhanlu cli run` 经 Magpie 网关端到端请求成功；
- 移除写入的键后配置恢复原状。

## 许可

MIT
