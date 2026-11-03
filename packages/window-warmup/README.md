# 窗口预热（Window Warmup）

Window Warmup is a page plugin for [magpie](https://usemagpie.ai) that sends a short keep-alive message to a provider, account and model of your choice — right after a quota window resets, at a fixed time of day, or every few hours — so the next subscription usage window opens early. It runs inside the Magpie host process; a local page manages tasks and shows run history.

在 magpie 窗口里按计划给指定供应商、账号和模型发一条短消息，用来提前开启下一轮额度（订阅）窗口。消息内容固定为 `hi`、`max_tokens: 16`，只当探活用，不可自定义；**每条消息都会真实发给所选模型并计费**。

本插件是 magpie 社区插件，源码在 [magpie-community/plugins 的 packages/window-warmup](https://github.com/magpie-community/plugins/tree/main/packages/window-warmup)，作者 [YangHonghang](https://github.com/YangHonghang)。

## 安装

```sh
magpie plugin add @magpie-community/page-window-warmup
```

也可以在 magpie 插件页的搜索框里搜 `warmup` 或「窗口预热」找到它。装好后在侧边栏 Plugins 下出现 **Window Warmup**（窗口预热）标签页。页面界面的语言跟随 Magpie 本身（zh / zh-TW / en / ja），不单独设置。

新包在 npm 上还没有第一个版本时，magpie 从社区仓库的 `dist` 分支安装并在之后自动更新，功能不受影响；npm 上有版本之后按常规方式安装即可。

### 从旧版「定时消息」升级，或与其并存

本插件与旧包 `scheduled-messages`（定时消息）默认都占 `127.0.0.1:3492`，后启动的一方起不来；若旧包先占了端口，本插件的带路页会跳到 3492 加载到**旧插件的界面**（页面自身无法探测这种张冠李戴）。两者的数据目录与锁文件各自独立，不会互相污染，但端口冲突必须处理其一：

- **从旧版升级**：先 `magpie plugin rm scheduled-messages`，再安装本插件。首次启动会自动把旧任务数据迁移过来（见「数据在哪」）。从独立发布的 `magpie-window-warmup`（≤0.3.7）换过来时，先 `magpie plugin rm magpie-window-warmup` 再安装本插件；数据目录不变，任务与执行记录照常读取。
- **确实要并存**：把其中一个的端口改掉，例如 `magpie plugin options @magpie-community/page-window-warmup '{"port":3493}'`；带路页会跟随这个选项跳转，改完重新打开页面即可。

## 三种触发

| 触发 | 到期点 | 去重 |
|---|---|---|
| 窗口重置后 | 账号额度窗口的 `resetsAt` 加 30 秒宽限（确保 magpie 侧已完成重置）；窗口空闲（重置点已过或没有）则立即到期 | 同一 `resetKey` 最多尝试一次，成功、失败、未知都算；有重置点时 key 就是重置点本身，同一轮重置只发一次；没有重置点的空闲窗口按快照所在小时计 key |
| 每天定时 | 指定 IANA 时区的 `HH:MM`；夏令时跳过的时刻顺延到跳变后第一个有效时刻，重复时刻取较早一次 | 按到期点记 |
| 固定间隔 | 起点 anchor 之后每 1–168 小时一个点 | 按到期点记 |

所有任务都必须选定账号（预热发给具体账号或 key；交给网关自动选，就没有稳定的去重与窗口归属）。调度器只保留一个定时器，最长睡 10 分钟就醒来重算，系统睡眠、改系统时间都能自愈。额度快照约每 10 分钟及每次发送后刷新。magpie 的额度缓存只在它路由请求那一刻读卡（没有托盘的 `magpie web` 平时不读），所以窗口任务快到期要发送时，以及发送满 1 分钟后，插件会让 magpie 重读这一张订阅卡（`POST /v1/magpie/quotas/refresh`，同用量页单卡「刷新」，只查余额）；卡片读取时刻（`readAt`）早于上次发送的空闲读数一律不信，宁可晚发也不重发。

## 模型与思考档位

模型选「自动」时，任务里不存选中值，每次发送前按统一账号规则现选（目录与调度器同一份实现）：

- 可选模型以 Magpie 的模型缓存为基础，按账号收窄：key 账号只留该 key 能看到的模型（缓存里的 Keys 指纹），providers.json 的 accountModels 给账号配了清单就只留清单内的；
- 没有模型缓存的供应商（插件型订阅供应商本来就不写缓存）退而用 `/v1/models` 里的全部模型，此时不按账号区分；连 `/v1/models` 都没有该供应商的模型 → 本次失败「供应商 X 还没有模型列表，无法自动选模型」；
- 收窄后按模型 id 最后一段的规格词排序 `flash < lite < mini < nano < small < turbo`（整词匹配、不分大小写，"minimax" 不算 mini），都不含的排最后；同档按 id 数字感知降序（新版本优先），取第一个；
- 收窄后一个模型都不剩 → 本次失败「账号 X 没有可用模型」。

插件页的目录会直接显示每个账号「自动」当前会选中谁。

思考档位同样不保存在任务里，每次发送前从当次 `/v1/models` 取该模型自己的档位列表现算，模型配置变了下次发送自动跟随：

- 模型不支持思考或档位列表为空 → 不带 `reasoning_effort`；
- 档位里有 `none`（`disabled`/`off` 视同）→ `reasoning_effort: "none"`，能关就关；
- 否则取该模型列表里最低一档（已知名按 `minimal < low < medium < high < xhigh < max` 排，纯数字思考预算低于所有命名档；全部是不知名的取列表第一档）。

每次执行记录都会写下当次实际用的模型与档位。

## 失败与补发

- **失败不暂停**：失败、超时（30 秒内没有结果，记 `unknown`，「可能已发送」）只写进执行记录，原因原样显示在页面上，任务保持启用，下一个时刻照常；不自动重发本次。
- **同一任务不重叠**：上一次发送还没结束，本次记「跳过」。
- **Magpie 关闭期间不执行**：调度跑在 magpie 宿主进程里，magpie 没开就没有发送。重新打开（或从睡眠恢复）后，每个任务最多补发一次：每天定时/固定间隔任务补发最近错过的应到点（须晚于任务最后一次编辑；每天定时只回看最近 48 小时），多个错过的点只补一个；窗口任务由 `resetKey` 去重兜着，同一轮重置不会发第二次。
- 找不到账号或窗口时记失败原因，不发送；额度快照取不到（刷新一直失败）时静默等下一轮刷新，不写执行记录。
- magpie 刚启动、额度缓存还是空的时候，插件会兜底读一次完整额度接口（只读余额，不发模型请求，15 秒超时）；两次兜底读取至少间隔 5 分钟。

## 供应商 → 账号 → 模型：级联选择是怎么拼出来的

Magpie 没有给插件提供「列出供应商、每个供应商有哪些账号、每个账号能用哪些模型」的接口：`/v1/models` 只有一张不分账号的模型清单，`/v1/magpie/quotas` 只有额度卡，账号与 key 的对应关系只存在于 Magpie 自己的配置和缓存文件里。插件把下面四处现成数据拼成一份目录：

| 来源 | 取用内容 | 用在哪一级 |
|---|---|---|
| 网关 `GET /v1/models` | 全部模型 id、`owned_by`、思考档位 | 供应商归属、模型的最终白名单、思考档位 |
| 网关 `GET /v1/magpie/quotas?kept=1` | 额度卡：`provider`、`user`、`windows`、`readAt` | 订阅账号、窗口；补充只有额度卡的供应商 |
| 文件 `<配置目录>/providers.json` | 每个供应商启用的 key（只算指纹）、key 名、`accountModels` | key 账号；模型第 2 层过滤 |
| 文件 `<缓存目录>/models/<供应商id>.json` | Magpie 上次「获取模型」的结果：每个模型的 `ID` 与 `Keys`（能看到它的 key 指纹） | 模型第 1 层过滤（按 key 可见性） |

服务端 `/api/catalog`（`src/gateway.ts` 的 `fetchCatalog`）一次算好整份目录，页面打开时拉取、之后每 60 秒刷新一次；调度器每次发送前用**同一份规则**（`src/accounts.ts`）重新计算，所以页面上显示的账号、模型和「自动」选中项，与实际发送时一致。

### 1. 供应商

- `/v1/models` 里的每个模型按 `owned_by`（真正接住请求的一方）归到供应商，没有 `owned_by` 时取 id 的第一段；`group/` 路由组不列出，归不到供应商的模型丢弃（任务必须有供应商）。
- 额度卡上出现的供应商也列出，即使它暂时没有模型；远程 key 卡的 `<p>/~keys` 归一成 `<p>`。

### 2. 账号

Magpie 内部用「候选 ID」区分同一供应商下的多把 key 和多个订阅登录，但没有接口把它们列出来。插件从两处还原：

- **key 账号**：读 `providers.json`，取该供应商的第一把 `key` 与 `keys[]` 中未停用（`off` 不为 `true`）的 key，对 key 原文做 sha256 并取前 5 字节的小写 hex 作为指纹。这与 Magpie `internal/provider/keys.go` 的 keyID 算法一致，因此能同时对上模型缓存里的 `Keys` 和发送时的候选 ID。账号 id 是指纹，显示名是 key 名（没起名则显示指纹），按指纹去重。**key 原文算完指纹即丢。**
- **订阅账号**：该供应商名下、非 key 卡的额度卡的 `user`，去重后原样作为账号 id 与显示名。

窗口挂到账号上的方式：

- 订阅账号按 `user` 精确匹配额度卡。
- key 账号先用指纹反查 key 名，再找 `<p>/~keys` 卡里 `user` 与 key 名相同（不分大小写），或以「名字 · 」开头（同名多把 key 时的打码形态）的那张。远程 Magpie 会给每把网关 key 单独发这样一张限额卡。
- 没起名的 key 无法匹配：卡名是打码后的样子，插件算不出来，这类账号没有窗口。
- `unlimited: true` 的「不限额」占位不算窗口。没有窗口的账号不提供「窗口重置后」触发。

账号下拉没有「自动」项，所有任务都必须选账号。旧任务里存的账号值原样保留并标注「不在当前账号列表」；存的是 key 名的照样按名字发送，兼容升级。

### 3. 模型（三层过滤）

对选定的账号，候选模型依次经过：

1. **按 key 可见性**：仅当该供应商有模型缓存且账号是 key 指纹时，只留 `Keys` 为空（所有 key 可见）或包含这把指纹的模型。
2. **按 `accountModels`**：`providers.json` 给这个账号（键为 key 指纹，或小写的订阅账号名）配了模型清单时，只留清单内的（比对不带供应商前缀的 id）。
3. **按当前存在**：只留此刻仍在 `/v1/models` 里的。

没有模型缓存的供应商（插件型订阅供应商本来就不写缓存）退而用 `/v1/models` 里该供应商的全部模型，跳过第 1 层，所有账号共用同一份清单。缓存和 `/v1/models` 都没有该供应商的模型时，模型下拉禁用，并提示到 Magpie 里「获取模型」。

下拉首项「自动」按「模型与思考档位」一节的规则，从过滤后的列表里现选，并在旁边附注当前会选中哪个模型。

### 4. 发送时怎么指定到这个账号

预热消息发往 `/v1/chat/completions`，用 `X-Magpie-Account` 头钉住账号：

- **订阅账号**：头值是账号名原文；含非 ASCII 字符时按 UTF-8 字节写入头部。
- **key 账号**：该供应商启用的 key 不少于 2 把时，头值是 `<供应商>#<指纹>`；只有 1 把时不带这个头。此时候选 ID 就是供应商 id，带了反而选不中。
- **旧任务存的 key 名**：原样作为头值发送。

同时带 `X-Magpie-Session: window-warmup/<任务id>`，方便在 Magpie 日志里识别来源。

### 文件位置怎么推断

插件装在 `<配置目录>/plugins/node_modules/magpie-window-warmup/dist` 时，从这个路径往上 4 级就是 Magpie 的配置目录：

- 它等于安装版配置目录（`$XDG_CONFIG_HOME`，或 `~/.config` 下的 `magpie`）时，缓存目录取安装版位置（`$XDG_CACHE_HOME`，或 `~/.cache` 下的 `magpie`）。
- 否则视为便携版，缓存目录是 `<配置目录>/cache`。

路径对不上（源码态开发等）时，按安装版目录读取。两种文件的读取结果在进程内缓存 5 秒；读不出时按「没有」处理，目录照常返回，不会整体报错。

## 插件只读的 Magpie 数据

除本地网关外插件没有任何对外连接；上节表格里的两份文件和两个网关读接口（地址取 `MAGPIE_ADDR`，默认 `http://127.0.0.1:3425`）全部只读不写，另外只调用 `/v1/chat/completions` 发预热消息，以及 `/v1/magpie/quotas/refresh` 让 Magpie 重读单张额度卡。

- **providers.json 红线**：key 原文只在「读文件 → 算指纹」这一步存在，不保存、不写日志、不进错误信息、不外传；配置文件损坏时报固定文案，绝不把文件内容带出来。
- **模型缓存**只读每个模型的 `ID` 与 `Keys`（key 指纹），不含 key 原文与 key 名。

已知限制：

- 插件型订阅供应商（zcode、WorkBuddy 等）在 Magpie 里不写模型缓存，只有 `/v1/models`：它们的账号不做按账号区分的模型过滤，所有账号共用同一份模型清单。
- 订阅额度卡的供应商 id 是 agent 名：改过名的订阅供应商，目录里的账号与模型可能匹配不上。

模型下拉被禁用并提示「还没有这个供应商的模型列表。请到 Magpie『供应商』里打开它，点『获取模型』。」时，就是第 2、3 样都拿不到该供应商的模型；下拉下方常驻的灰字（「模型列表来自 Magpie 上次获取的结果……」）是提醒模型清单可能是旧快照，账号和模型对不上时去 Magpie 里重新「获取模型」再刷新本页。

## 数据在哪

- 数据目录：`WINDOW_WARMUP_DIR` 优先，否则 `${XDG_CONFIG_HOME:-~/.config}/magpie/window-warmup/`。`XDG_CONFIG_HOME` 只认绝对路径，留空或相对路径都按未设置处理（与 Magpie 自己的规则一致，插件数据、旧版迁移来源与 Magpie 配置目录因此总在同一个根下）。
- **从旧版自动迁移一次**：第一次启动时，若新目录还没有 `state.json` 而旧版定时消息的 `…/magpie/scheduled-messages/state.json` 存在，就只把这一个文件复制过来（锁文件不带，旧文件原地不动，方便回退）；新目录已有 `state.json` 就什么都不做，条件本身保证只做一次。
- `state.json` 存任务、执行记录与去重标记，每任务保留最近 50 条记录；写入用临时文件加 rename。
- 已知边界：落盘没有 fsync，断电极端情况可能留下损坏文件。程序会拒绝启动并显示原因，**原文件一个字节不动**，需要你确认后手动删除或修复。
- 单实例锁 `service.lock` 写入持有者 pid；锁内容读不出或解析不了时按「活性不明」处理，页面提示另一个实例可能正在运行并只读展示，不会抢占。持有者 pid 活着但端口上没有本插件在应答（典型：Docker 容器重建后 pid 被无关进程复用，持久卷上的旧锁成了假阳性），视为陈旧锁自动接管、正常读写。

## 安全与端口

本地服务只监听 `127.0.0.1`（默认端口 3492，可在插件设置里改）。每次启动生成随机口令，经首页注入，`/api/*` 全部要求带 `x-window-warmup-token` 头；服务同时校验 `Host` 与 `Origin`（防 DNS 重绑定），响应按沙箱框架给 CORS 与 CSP，别的页面读不到接口。所有响应都带 `x-window-warmup: 1` 自标记：启动前插件先探测端口，已有本插件的服务在跑就直接复用，不重开数据目录。除 magpie 本地网关（发消息、读额度、读模型）外没有任何对外连接。

## 费用

每条消息都会真实发给所选模型并计费（内容固定 `hi`、`max_tokens: 16`，只当探活）。窗口触发以 magpie 额度快照为准，同一轮窗口只发一次；额度缓存长时间不更新时，空闲窗口按小时计 key，同一小时内最多尝试一次；读数早于上次发送的空闲不算数。

## 发布与维护

仓库在 [magpie-community/plugins](https://github.com/magpie-community/plugins) 的 `packages/window-warmup/`，插件页的条目登记在同一仓库的 `registry.json`（`kind: "page"`、`community: true`）。改代码走 PR：改版本号（`packages/window-warmup/package.json`）与改动放在同一个 PR，合并后仓库 CI 自动跑测试、把新版本打进 `dist` 分支，并把 npm 上没有的版本发布出去。`dist/` 入库，宿主直接加载它，发布流程不构建，改源码后要 `bun run build` 并一并提交。

已安装的用户由 magpie 自动更新（社区包一小时内），无需手动操作。`registry.json` 里这一条的名称、图标或中英文简介变化时，才需要单独提 PR 同步。
