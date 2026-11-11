# Oh My AIHub

Magpie 的纯后端插件：把自己的 Magpie 模型共享给同一个 EasyTier 私有网里的伙伴，或使用伙伴共享的模型。没有界面、没有本机控制台、不开第二个 AI 网关——所有操作由 agent 通过 MCP 工具完成。

节点身份是一个内置的 EVM 钱包地址。共享的模型和价格由这把私钥签名发布；别人向你地址转入的 USDC 就是可用额度（`cap = 已确认入账总额 D − 已被旧 Key 花掉的 used-base`）；谁批准谁发 Gateway Key。AI 请求始终走「你的应用 → 你的 Magpie → EasyTier → 伙伴的 Magpie」，插件只负责组网、签名目录、申请/审批和记账。

## 安装

1. 打开 Magpie 的 **Plugins → Discover**。
2. 如果搜不到，在列表底部用手动添加入口填：`github:faithleysath/magpie-oh-my-aihub`
3. 打开 **Oh My AIHub** 插件页——那一页就是用户手册（快速开始、常用说法）。
4. 让 agent 用 `join_network` 加入网络，其余按插件页走。网络方说这个网开了 secure mode，就一起给 agent：它会传 `secureMode:true`。

插件装好后会自动生成节点钱包，私钥在插件数据目录的 `wallet/key.hex`（`0600`）。插件不写 Magpie 选项，也不读它的管理接口。

## 把工具接给 agent

| 用途 | MCP 地址 |
| --- | --- |
| 全部插件 | `http://127.0.0.1:3425/mcp/magpie/tools` |
| 只本插件 | `http://127.0.0.1:3425/mcp/magpie/tools/magpie-plugin` |

Magpie 0.1.2516 起插件自动成为 Library 里的一个 MCP server，按 agent 打开即可；更早的版本手工填上面的 URL。开了 MCP 路由时，agent 拿到的是 `magpie` 一个服务器（`/mcp/magpie/hub/<agent>`），工具名是 `magpie-plugin__<tool>`；关掉路由时，每个服务器单独一条，本插件是 `/mcp/magpie/tools/magpie-plugin`，工具名不带前缀。本机 agent 免 Gateway Key；别的机器上的 agent 需要 Magpie 打开 **Share on local network** 并拿到 Gateway Key。

21 个工具。只本插件的地址没有前缀；全部插件地址是 `magpie-plugin_<tool>`；走 MCP 路由时是 `magpie-plugin__<tool>`：

| 分类 | 工具 |
| --- | --- |
| 节点 | `status`、`wallet`、`wallet_import`、`wallet_export`、`join_network`、`network_daemon` |
| 地址簿 | `contacts` |
| 提供方 | `native_models`、`share_models`、`consumers`、`approve_request`、`reject_request`、`revoke_consumer` |
| 消费方 | `discover`、`request_access`、`connect_provider`、`disconnect_provider`、`connections` |
| 钱 | `send_payment`、`history`、`claim_deposit` |

## 安全边界

- **网络密码是入网门，secure mode 决定加密到哪一层**。网络开了 EasyTier secure mode 时要在 `join_network` 里传 `secureMode:true`：同网节点必须一致，不一致的节点会被对端反复踢掉（`peers` 永远为空）。本机的 X25519 密钥第一次用到时自动生成在 `easytier/secure-key.json`，**不需要和任何人交换密钥**。没开 secure mode 的网也加密（AES-GCM），但密钥来自同一个密码，中继节点能解开；开了之后每对节点各自协商，中继只能转发。两种情况覆盖网内的 HTTP 都是明文应用层：插件不做应用层加密、不做配对、不做节点信任列表。
- **私钥只在本机**。工具永远不返回私钥；`wallet_export` 只写到本机文件。导出之后能读到那个文件的人（包括 agent）就能拿走它，这是本机权限问题，插件挡不住。
- **地址簿只是省打字**。`contacts` 把名字映射到地址，存在本机 `ledger.sqlite`；它不进签名、不进目录、不参与授权，也不是转账白名单。所有收地址的工具都接受名字，但名字换成地址之后，行为和不写名字完全一样。
- **插件不转发 AI 请求**。它不代理、不计 token、不另写请求账单；用量和限额都在 Magpie 自己的 Gateway Key 上。
- **付款和通知解耦**。`send_payment` 先把交易发上链，再给已知提供者排队一条 `omai/deposit/1` claim；提供者离线时 claim 留在本地队列里重试，不会阻塞付款、不会重发交易。提供者恢复后只查这一笔 receipt。`connections` 会显示对方报告的余额、本地已发送、待投递 claim 和 `providerBehind`；对方可能滞后时用 `claim_deposit` 补发。交易所/外部钱包的转账没有本节点签名，不会自动入账；这是只靠 claim 的产品约束。`send_payment` 传 `claim:false` 可以只转账、不投递，当赠送；出金记录标为 `gift`，之后仍可用 `claim_deposit` 手动补。转原生币用 `asset:"native"`（BSC 的 BNB / Base 的 ETH），用于给朋友空投 gas；原生币不进 claim、不算提供方额度。
- 覆盖网地址不是身份，只是路由线索。目录和申请靠签名证明「这份模型和价格确实是这个地址公布的」，签名者必须等于文档里的 `address`。
- **节点名只是显示名**。在地址簿里给自己钱包地址起别名，就会签到目录里（`omai/catalog/3`）供别人 `discover` 看到；身份仍然是地址，改名不影响组网，也不影响别人对你的授权。
- **目录里的价格是签名承诺**。基线是四段价（输入/输出/缓存读/缓存写，USD / 1M tokens）；带阶梯价（超过某个 token 数整笔涨价）或高峰价（供应商高峰时段乘倍数）的模型会签 `omai/catalog/2`，把 `tiers` 和 `peak` 一起公布。全是四段价时仍签 `/1`，老客户端照旧能读。真实扣费由提供方的 Magpie 按它自己的价目表算，目录不参与计费。
- 对外只开两个端口：`3426` 目录/申请/轮询（绑覆盖网地址；no-TUN 时绑 `127.0.0.1`），`3425` Magpie 模型网关（**只有 TUN 模式下才开**）。macOS 上以普通用户运行 Magpie 时，`network_daemon install` 会装一个 root 守护进程来提供 TUN（弹一次系统管理员密码框；下载和密码框可能超过工具超时，返回 `state:"starting"` 后用 `status` 轮询）。no-TUN 会把对端重写成 `127.0.0.1`，Magpie 会当本机免 Key 调用，所以那时不公布 3425。Magpie 管理界面永远不映射到覆盖网。
- Gateway Key 只通过「提供方 → 消费方」的签名轮询交付给对应地址，不落日志、不进 `status`。插件自己创建的 key 通过 stdin 交给 Magpie CLI；Remote Magpie 的 key 仍受上游 `magpie provider add` 只收 argv 的限制，同机同用户的进程列表可能看到。
- 一个钱包就是一台节点的全部身份；两台机器用同一个私钥就是同一个账户，余额共享。

## 文档

| 文档 | 是什么 |
| --- | --- |
| [README.md](README.md) | 安装、MCP 接线、工具列表、安全边界。 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | **架构与维护者参考**。产品决策、协议、数据文件、Magpie 集成事实、已知限制、验证状态。 |

插件页 `plugin/page/doc.md` 是用户手册（构建产物 `plugin/page/index.html`，也就是 Magpie 里那一页）。

检查：`cd plugin && bun run typecheck && bun test`。文档页由 `cd plugin && bun run build:page` 从 `page/doc.md` 渲染。CI 在 `.github/workflows/ci.yml` 跑这些检查，并额外检查 daemon 脚本语法。
