# magpie-agent-deva

<a href="https://linux.do"><img src="https://img.shields.io/badge/LINUX%20DO-%E7%A4%BE%E5%8C%BA-FFB003?style=flat-square" alt="LINUX DO 社区" /></a>

把 **Deva 桌面版**接进 [magpie](https://usemagpie.ai) 的 Agent 列表：在 magpie 的 Agent 页勾选 Deva 能用哪些路由组/模型，插件把它们写进 Deva；之后在 Deva 自己的模型列表里选一个用。断开时恢复原样。

Deva 本身是开源的桌面 agent harness：[sqfcyily/deva](https://github.com/sqfcyily/deva)。

## 安装

```sh
magpie plugin add ./magpie-agent-deva
```

或者在 magpie 的 **插件 → 添加插件** 里填这个文件夹的路径（文件夹插件就地加载，改完在插件页关掉再打开即可生效）。

装好后打开 **Agent** 页，会多出一行 **Deva**。

## 使用

1. 在 Deva 那一行打开模型列表，**勾选**它允许使用的路由组和模型。
2. 关掉 Deva 再打开 —— Deva 只在启动时读配置，所以插件会等它退出后才写。
3. 重开后 Deva 的模型列表里就是勾选的那些，挑一个用。
4. 想换回原来的：在 magpie 里断开（`magpie deva default`，或把 provider 关掉），下次启动 Deva 就是原来的设置。

第一次连接时，如果 Deva 的供应商列表里已经有指向 magpie 网关的（比如你手动加的 `127.0.0.1:3425`），插件直接用它，不会再加一个；没有才新建一个 id 为 `magpie` 的供应商。

之后在 magpie 里取消勾选的模型会被移出列表；你自己在 Deva 里加的模型不受影响。

## 它改了 Deva 的什么

只改 `~/.deva/config.json` 里的这几处：

| 位置 | 改动 |
|---|---|
| `models.providers[]` | 找到 / 新建指向网关的那个供应商 |
| 该供应商的 `models[]` | 加入勾选的模型；上次加过、这次取消勾选的移出 |
| 该供应商的 `enabled` | 置为 `true`（否则 Deva 不会用它）；断开时还原 |
| `models.activeModelId` | 只在它指向的模型被移出时，改指列表里第一个；断开时还原 |

其它供应商、其它设置（头像、布局、推理档位……）原样不动。

`activeModelId` 断开时只在它仍指向这个供应商的情况下才还原 —— 如果你在 Deva 里改成别的供应商的模型了，那个选择是你的，插件不覆盖。同理，插件新建的那个供应商被移除时，你后来自己往里加的模型会留下，只删掉插件加的那些。

## 路径

| 文件 | 位置 |
|---|---|
| magpie 的记录（插件只读） | `~/.deva/.magpie-agent.json` |
| Deva 的 `config.json`、还原用的 state、备份 | `$DEVA_HOME`，未设置时 `~/.deva` |

`DEVA_HOME` 是 Deva 自己的环境变量（便携安装会把整个数据目录挪走），插件跟随它找 `config.json`；magpie 的记录文件仍按 `~/.deva` 写。

还原用的原始值记在 `~/.deva/.magpie-agent.state.json`，第一次写入前还会把整个配置备份到 `~/.deva/.magpie-agent.config-backup.json`。

## Deva 只在启动时读配置

插件会直接改 `config.json`，**Deva 开着的时候也改**。但 Deva 启动时把配置读进内存就再也不读盘了（`services/config.ts` 里 `loaded = true` 之后没有重载入口，也没有文件监听），所以：

- 改动立刻落到文件，**Deva 界面要重启才看得到**
- Deva 运行中只要你在它里面动了任何设置，它会拿内存里那份覆盖 `config.json`，把插件的改动盖掉

第二条靠插件的轮询兜着：每 2 秒比对一次文件，发现被覆盖就再写回去。所以两边不会长期分叉，但界面上看到的仍可能是旧的，直到重启 Deva。
- **不碰别的密钥。** magpie 网关在本机不校验密钥本身，Deva 里那一栏留空也能聊，所以插件只为它维护的那一个供应商写密钥（见下节），其它供应商的密钥一律不动。

## 为什么「添加模型」会把整个网关的模型都列出来

Deva 的「添加模型」会向网关请求 `/models`，而网关**按密钥过滤**：带上 magpie 发给这个插件的密钥，只返回你在 magpie 里勾选的那些；密钥不对或者没带，就把全部模型倒出来。

所以插件要把 magpie 给的密钥写进 Deva 的密钥存储。存储方式与 Deva 自己一致：Electron `safeStorage`，`v10` + 12 字节 nonce + AES-256-GCM 密文 + 16 字节 tag，主密钥由系统凭据（Windows 上是 DPAPI）加密。断开时只删这个供应商的密钥。

**密钥只在 Deva 没在运行时写。** Deva 对 `secrets.json` 是启动后读一次、之后整份从内存保存，运行中写进去它既看不到、又会被它下一次保存盖掉；`config.json` 没这个问题（插件每 2 秒比对一次，被盖了再写回去），密钥没有这个兜底，所以等退出。

读不到主密钥时（目前只实现了 Windows 的 DPAPI），插件不写密钥也不报错：Deva 照旧能聊天，只是「添加模型」会列出全部模型。

**这个下拉列表不读配置文件。** 每次点「添加模型」，Deva 是现向网关请求 `/models`，拿回来什么就列什么。所以它和「Deva 里已有哪些模型」是两回事：在 magpie 里取消勾选后，`config.json` 里那条已经没了（插件 2 秒内写完），但下拉列表要**再点一次「添加模型」重新拉一遍**才会更新。看到「关掉了还列着」，先关掉重开一次这个面板。

## 为什么没有模型选择器

这个插件的 `agent` 里**不写 `model`**（connect-only）。magpie 的规则是：写了 `model` 的 Agent 只有一个单选下拉；不写的，Agents 页会变成整个模型列表 + 勾选框，勾中的全部写进 Agent，模型由 Agent 自己选。社区里的 `agent-pig` 也是这样。

所以 Deva 在 magpie 那一行只有一个 `provider` 开关，模型在 Deva 里挑。

## 为什么市场上它显示成「供应商」

magpie 的插件市场会把没有 `main` 字段、只有 `magpie.agent` 的插件认作 Agent——社区里 `agent-pig`、`agent-aider`、`agent-delta` 都是这样，它们的描述文件里只有 `agent` 声明和 `connect()`，配置写入由 magpie 自己完成。

Deva 做不到这一点。它的 `config.json` 里 provider 是一整个数组，插件要按勾选增删模型、记住哪些是自己加的、断开时还原，还要把网关密钥加密写进 `secrets.json`、写之前确认 Deva 没在运行。这些 magpie 的通用机制处理不了，只能有真正的运行时。

而这个运行时就是 `package.json` 里的 `main`——它同时也是市场把插件判成「供应商」的原因。去掉它，描述文件里的代码跑不起来：magpie 的 moejs 沙箱没有 `setTimeout`，也没有 import hook，连 `node:fs` 都加载不了，只能求值 `agent` 声明和 `connect()`。

两者不可兼得，插件选择了功能：**市场上它出现在「供应商」下面，实际仍是 Agent 插件**，装好后照常在 Agents 页出现、照常勾选模型。想看它是不是 Agent，`magpie ls` 里那一行就是（`Deva provider magpie ~\.deva\.magpie-agent.json`）。

## 文件

| 文件 | 作用 |
|---|---|
| `deva.agent.js` | Agent 声明（跑在 magpie 的 moejs 里，只声明 `agent` 和 `connect()`） |
| `index.mjs` | Bun 入口：轮询记录文件、检测 Deva 进程、合并写入 Deva 的 `config.json`，由 `package.json` 的 `main` 启动 |
| `lib/deva-config.mjs` | 纯函数：复用/新建供应商、同步模型列表、还原（有测试） |
| `lib/deva-secrets.mjs` | 纯函数：按 Electron `safeStorage` 的方式加解密密钥（有测试） |
| `lib/deva-files.mjs` | 路径解析、读写 JSON、检测 Deva 进程、取 `safeStorage` 主密钥 |

## 图标

Agents 页 Deva 那一行的图标取自 `agent` 导出里的 `icon`，是 Deva 自己的应用图标（从 `Deva.exe` 的 RT_ICON 资源里取出的 256×256 PNG，转成 data URI）。`package.json` 里的 `magpie.icon` 也指向同一张，那是插件卡片的图标，两者不通用。图标的使用经 Deva 作者同意。

## 卸载

先在 magpie 里把 Deva 断开，再从插件页移除（或 `magpie plugin rm <插件目录>`）。不先断开的话，Deva 的配置会停在 magpie 的模型上。

## 测试

```sh
npm test
```

测试用一份脱敏的配置样例跑，不碰 `~/.deva`。

## 与 Deva 的关系

非官方插件，与 Deva 开发方无关。按 Deva 源码里 `Provider` / `ModelDef` 的定义写（`apps/desktop/src/renderer/src/mock/models.ts`），验证于 Deva 0.1.13。
