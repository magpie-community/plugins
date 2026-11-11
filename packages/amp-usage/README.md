# Amp 用量采集

在 Magpie 中增加「Amp usage」页面，并在插件宿主内运行后台采集服务。采集结果通过 `POST /v1/magpie/usage/requests` 写入现有用量账本，来源为 `reported`，Agent 为 `amp`。请求统计与 Day card 可直接使用这些记录，无需替换内置页面。

需要 Magpie **0.1.3681 或更新版本**。云端模式需要支持 `threads list --json` 和 `threads export` 的 Amp CLI，且已登录。已检查的 CLI 为 `0.0.1794052841-g6d76b7`。本地模式不需要 Amp CLI；Node.js 20+ 用于开发测试，安装后的后台由 Magpie 的 Bun 宿主运行。

## 安装与使用

从仓库安装本地包：

```sh
magpie plugin add /absolute/path/to/plugins/packages/amp-usage
```

1. 打开插件页面，选择云端 CLI 导出或旧版本地文件。
2. 点击 **Preview usage**。预览会读取来源、保存最少用量缓存和稳定性检查点，但不向 Magpie 上报。
3. 检查缺失时间、重复记录和读取错误。用量需要在至少两次扫描之间保持不变，默认间隔至少 120 秒。
4. 点击 **Enable collection** 启用采集。后台默认每 5 分钟同步；页面关闭后仍继续，插件关闭或 Magpie 退出时停止。
5. 在「观测 → 用量 → 请求」按 Agent `amp` 或上报来源筛选，选择记录实际发生的日期；Day card 使用相同账本。

首次云端同步每轮最多导出 20 个变化线程；页面显示剩余数量，继续扫描或等待定时同步即可。未变化线程复用缓存，失败线程不会推进导出检查点。修改采集源会自动暂停，避免切换后立即写入。

**Pause collection** 只停止未来导入，不删除已写入的历史。已接受的记录不能通过同 ID 上报覆盖；若 Amp 后续修改已导入记录，插件会提示，保持原记录而不重复增加。

## 采集与统计口径

实现参考 [Tokscale 的 Amp 解析器](https://github.com/junhoyeo/tokscale/blob/b0991187b0af99614b48230f17d13a1fe06f28fa/crates/tokscale-core/src/sessions/amp.rs) 与 [CLI 同步器](https://github.com/junhoyeo/tokscale/blob/b0991187b0af99614b48230f17d13a1fe06f28fa/crates/tokscale-cli/src/amp.rs)，采用 MIT 许可，见 `NOTICE` 和 `LICENSE`。

- 云端使用当前已登录 Amp CLI 的 `threads list --json --include-archived` 分页列举及 `threads export`，不直接读取 Amp 密钥。
- 本地默认读取 `$XDG_DATA_HOME/amp/threads`，未设置时为 `~/.local/share/amp/threads`。这些文件可能仅包含旧历史；当前云端线程应使用云端模式。配置多个目录时，同线程内容冲突会被排除。
- 账本与消息优先按 `toMessageId` / `messageId` 对齐；没有 ID 匹配时按模型、token 和兼容时间一对一匹配。保留账本独有事件与消息独有用量，避免只选一个来源造成漏计。
- 稳定上报 ID 以线程 ID 和消息 ID 为基础；搜索、子代理等辅助调用即使共享消息边界，也使用独立事件身份；匿名账本事件使用时间、模型、操作和出现次序。消息 ID 冲突、身份变化或导入后变化会提示，不能保证无稳定标识的历史在任意重写后仍能自动修正。
- **不使用线程创建时间、文件修改时间或消息序号推算请求日期**。缺少可靠时间的记录显示为缺口，不计入每日历史。
- 正在生成、取消、刚更新的记录不导入。两次扫描间用量变化会重置稳定等待时间。
- 输入、输出、缓存读取、缓存创建分别上报；不使用 `totalInputTokens` 再叠加缓存。Amp credits 不作为美元费用，上报省略 `cost`，由 Magpie 估算 API 等价费用，未知模型可能没有价格。
- `provider` 使用宿主的 `session-unknown`，避免把模型厂商冒充实际付款渠道；`model` 保留 Amp 原始值。

### 去重的范围

已接受记录按稳定 `rid` 去重，Magpie 重启后也不会重复接受。传输中断或应答丢失可安全重试。插件另保存已确认记录的指纹，检测后续修订。

读取同一 Magpie 配置目录的 `usage.jsonl` 检查网关已有请求：模型和四类 token 相同，且会话 ID 相同或时间相距不超过 5 秒时，保守排除重复候选。标记为 Magpie 路由的模型也会排除。这个匹配不是完整的跨系统请求身份协议：不识别线程的代理、时间或模型改写、已归档不在该日志中的网关记录，仍可能无法关联。使用自定义网关时，应通过 `excludedThreadIds` 或 `excludedModels` 排除相关来源；分支复制历史若没有可验证的父子标识，也不能保证跨线程自动去重。

插件只扫描当前机器或当前 Amp CLI 账号；不会补齐未导出账号的数据。新增云端格式需要真实脱敏样本验证。

## 插件选项

在 Magpie 插件选项中配置。服务只允许上报到本机 HTTP 网关；不自动寻找凭据或向远端上报。

```json
{
  "port": 3497,
  "gatewayURL": "http://127.0.0.1:3425",
  "intervalSeconds": 300,
  "settleSeconds": 120,
  "ampPath": "",
  "threadDirs": [],
  "excludedThreadIds": [],
  "excludedModels": []
}
```

- `port`：页面服务端口，仅监听 `127.0.0.1`，被占用时明确报错。
- `gatewayURL`：Magpie 网关地址，仅支持 `127.0.0.1` 或 `::1`，可带 `/v1`；自定义端口需同步修改。需要额外鉴权的网关目前会报 HTTP 错误，不自动读取其他插件或账号的密钥。
- `intervalSeconds`：60–3600 秒，默认 300。
- `settleSeconds`：30–3600 秒，默认 120。
- `ampPath`：Amp 可执行文件路径，留空时查找 PATH 和 Amp 的常见安装位置；不经过 shell 执行。Windows 需要可执行的 `amp.exe`。
- `threadDirs`：本地模式的绝对路径数组；空数组使用默认目录，不递归扫描、不跟随目录项符号链接。
- `excludedThreadIds` / `excludedModels`：精确排除的线程 ID 或模型名。

Magpie 的远程网页通过声明的页面服务代理访问；不要求向网络开放采集服务端口。页面 API 使用每次启动生成的随机令牌，校验 Host 和 Origin，并限制请求大小。

## 本地状态与隐私

状态位于插件宿主提供的 Magpie 配置目录下的 `amp-usage/`，并以私有文件权限写入：

- `settings.json`：采集开关和来源。
- `state.json`：已确认记录指纹、待稳定记录。
- `cloud-index.json`：线程导出检查点。
- `cloud/`：只包含用量、消息标识、完成状态和时间的精简导出。
- `collector.lock`：防止多个服务同时维护同一检查点；进程退出后的陈旧 PID 锁可在下次启动恢复。

Amp 导出命令的完整结果会短暂经过内存，但不保存提示词、回复、工具内容、项目路径或账号密钥。页面不会展示线程原文。日志解析失败时保留原状态，不静默清空去重数据。页面中的确认记录数量属于插件检查点，不是重新计算的 Magpie 全库请求数。

## 验证

```sh
node --test packages/amp-usage/test/*.test.mjs
bun scripts/check.mjs amp-usage
MAGPIE_BINARY="$(command -v magpie)" node --test packages/amp-usage/test/host.integration.mjs
```

覆盖解析对账、真实脱敏字段样本、时间缺失、流式状态、重复 ID、稳定等待、重启、失败重试、网关重复候选、云端检查点、分页进度及页面服务鉴权。

`test/fixtures/amp-local.json` 来自真实旧版 Amp 本地记录，只保留一条已完成消息的计量字段，线程与消息标识已替换，未包含对话内容。其他测试构造专门的异常边界，不冒充真实客户端样本。修改 Tokscale 本地仓库不是本插件安装或运行的必要步骤。
