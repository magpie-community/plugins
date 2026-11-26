# magpie-agent-uebox

把 [UEBox（虚幻盒子）](https://github.com/ueboxai/uebox) 作为 Agent 接入 [magpie](https://github.com/yetone/magpie)：在 magpie 的 Agents 页打开开关，UEBox 就用上 magpie 的全部模型、多账号、故障切换和用量统计。

Put [UEBox](https://github.com/ueboxai/uebox) on [magpie](https://github.com/yetone/magpie)'s gateway: UEBox appears as an agent on magpie's Agents page, and its models come from magpie.

> 一个 magpie 的 **Agent 插件**（`magpie.agent`）。UEBox 与 magpie 均非本仓库出品，这里只是两者之间的接线。

## 它怎么工作 / How it works

UEBox 的服务商配置在 `%APPDATA%\unreal-box\models.json`（macOS / Linux 见下），其中 `providers` 是**数组**。magpie 的 Agent 插件只能按对象键路径写配置，写数组会把整段替换掉，所以这个插件分两部分：

| 部分 | 跑在哪 | 干什么 |
| --- | --- | --- |
| `uebox.agent.js` | magpie 进程内（moejs，无 Node） | 声明 Agent 那一行；开关打开时把网关地址、为此 Agent 生成的网关 key、magpie 当前模型列表写进 `~/.config/magpie/uebox-link.json` |
| `index.mjs` + `lib/sync.mjs` | magpie 的插件宿主（Bun，有 fs） | 监听上面那个文件和 UEBox 目录，把一条 id 为 `magpie` 的服务商合并进 `models.json`；关掉开关时只删掉这一条 |

`providers` 里你自己的服务商、`roles` 里的默认模型绑定都不会被改动。首次改动前把原文件备份成 `models.json.magpie-backup`（只备份一次），写入用临时文件 + rename，避免半截文件。

服务商协议用 **`openai-responses`**，`baseUrl` 是 `<网关>/v1`。这不是随便选的：UEBox 底层的 pi-ai 只在 Responses 这条路上发会话标识（`session-id` 头），走 `openai-completions` 时 magpie 的路由页会把每条请求归到「未提供会话标识」，一段对话的多轮就散成单轮。

## 关于密钥 / About the key

UEBox 会把直接填写的密钥加密存进系统凭据里，外部没法代写，所以这里用 UEBox 支持的 `shell` 引用：存进 `models.json` 的是一条 `echo echo magpie-uebox` 这样的命令，UEBox 执行它拿到 key。

**这条 key 会以明文出现在 `models.json` 的那条命令里。** 它是 magpie 为本机 Agent 生成的网关 key（形如 `magpie-uebox`），不是任何厂商的密钥；丢掉也只是让这条接线失效，重新连接会生成新的。magpie 用它把用量记在 `uebox` 名下。

## 安装 / Install

```sh
magpie plugin add github:wjf990711/magpie-agent-uebox
```

目录方式也可以（改完不用重装，magpie 每秒检查一次文件变化）：

```sh
git clone https://github.com/wjf990711/magpie-agent-uebox
magpie plugin add ./magpie-agent-uebox
```

装好后到 magpie 的 **Agents** 页，在 UEBox 那一行选一个 magpie 模型，打开开关。

**然后重启 UEBox**（或打开一次「设置 → 模型」）。UEBox 在启动和打开该页时读 `models.json`，不监听文件变化，连接后不重启看不到新的服务商。

## 选模型 / Picking models

插件只加服务商，不改 UEBox 的角色绑定。到 UEBox 的「设置 → 模型」里，给对话、Agent、视觉、摘要这些角色各选 magpie 下的模型。

留在别家上的角色不经过 magpie，也就不会出现在 magpie 的用量里。

## 数据目录 / Where UEBox keeps things

| 系统 | 目录 |
| --- | --- |
| Windows | `%APPDATA%\unreal-box\` |
| macOS | `~/Library/Application Support/unreal-box/` |
| Linux | `~/.config/unreal-box/` |

其它位置设 `UEBOX_USER_DATA` 指向它。

## 测试 / Tests

```sh
node --test test/sync.test.mjs   # 7 个用例，全部通过
```

只在自己建的临时目录里读写，不碰真实的 `models.json`。

## 限制 / Limits

- 只在 Windows 上验证过。路径逻辑包含 macOS / Linux，但没有实机跑过。
- 只加一条服务商；UEBox 的其它服务商与角色绑定保持原样。
- UEBox 未来若改变 `models.json` 的结构，这个插件需要跟着改。写入的是一条 id 为 `magpie` 的条目；UEBox 自己保存设置时如果把它覆盖掉，插件会重新写回。
- 版本线的限制：`openai-responses` 是 pi-ai 1.5.2 的行为，UEBox 升级 pi-ai 后需要复核会话标识是否仍然只走 Responses。

## 许可 / License

MIT。UEBox 本体是 Apache-2.0，图标取自它的 `build/icon.svg`。
