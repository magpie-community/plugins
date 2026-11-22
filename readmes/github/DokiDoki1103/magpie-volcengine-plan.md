# magpie-volcengine-plan

[magpie](https://github.com/yetone/magpie) 的供应商插件：**火山方舟订阅**（Agent Plan / Coding Plan，走 Anthropic 协议 `/api/plan`、`/api/coding`）。

多个订阅账号轮着用时，插件替你处理这些事：

| 场景 | 插件做的 |
|---|---|
| 某个账号额度用完（429 `AccountQuotaExceeded`） | 从返回里读出恢复时间，**暂停这个账号到那个时间**，期间不再请求火山，magpie 自动切到下一个账号；周额度还是月额度也从原话里分出来 |
| 订阅失效（`InvalidSubscription` / `AccountSuspended` / `AccountDisabled`） | 让 magpie 把账号标成需要重新登录，不再往它发请求 |
| 订阅到期 | 到期后**不再请求火山**；续费后读到新的到期时间自动恢复 |
| **只填 AccessKey（推荐）** | **全自动**：识别是 Agent Plan 还是 Coding Plan、自己取聊天用的 API key、定 Base URL，并读 5 小时 / 周 / 月额度、到期时间、是否自动续费。你只需要给 `ak=… sk=…` |
| 手填 API key，再可选加 AccessKey | 聊天用你填的 key；加了 AccessKey 就同样读真实额度和到期 |

没有 AccessKey 也能用：手填 API key，只靠 429 事后暂停，到期日手填。

## 安装

```bash
magpie plugin add github:DokiDoki1103/magpie-volcengine-plan
```

更新到最新版：

```bash
magpie plugin update
```

装在 Docker / k3s 里的 magpie：

```bash
kubectl exec deploy/magpie -- /magpie plugin add github:DokiDoki1103/magpie-volcengine-plan
```

> 插件由 magpie 的插件运行时（Bun）从 GitHub 拉取。国内节点连 GitHub 慢的话，在 magpie 设置 → Network and sharing 里给 **Plugin downloads** 选一个代理。

## 添加账号

在 magpie 里点"添加账号"，先选**订阅类型**，再一项一项填（界面里是"下一步"，终端里是依次提示）。**只会问跟这个类型有关的项**，其余自动跳过；**Secret 和 API key 用密码框，输入时不显示**。

| 订阅类型 | 依次问的项 |
|---|---|
| `自动识别`（推荐） | 名称（可省略）→ AccessKey ID → Secret → 地区（可省略） |
| `plan` / `coding` | 名称（可省略）→ API key → 订阅到期日（可省略）→ AccessKey ID（可省略；填了才再问 Secret 和地区） |
| `自定义地址` | 先问 Base URL，其余同 `plan` / `coding` |

### 推荐：自动识别，只填 AccessKey

下拉选 `自动识别`，然后：

1. 名称：想怎么叫都行，可省略（同名再次添加会替换旧账号，不能有空格）。
2. AccessKey ID：火山控制台 → 访问控制 → 访问密钥。
3. Secret AccessKey（密码框）。
4. 地区：可省略，默认 `cn-beijing`。

插件会自己：

1. 识别套餐类型（Agent Plan / Coding Plan，个人版或团队版）；
2. 取这个套餐专用的 API key（只放内存，**不写进保存的数据**）；
3. 定 Base URL（Agent → `/api/plan`，Coding → `/api/coding`）；
4. 读额度、到期时间、是否自动续费。

API key 被你在火山控制台轮换后，插件收到 401 会**自动重新取一次再重试**，不用你更新。识别失败时会说清楚原因：AccessKey 不对 / 没有订阅（会标成需要重新登录）、没有可用的 key、读取 key 被火山拒绝、临时网络故障。

### 手填 API key

下拉选 `plan` / `coding`（地址不一样时选 `自定义地址`），然后：

1. 名称：可省略。没填名称，卡片标题用 magpie 默认的 "API key …尾号"。
2. API key（密码框）：`ark-` 开头，聊天用。
3. 订阅到期日：`YYYY-MM-DD`，按北京时间当天 23:59:59 到期；可省略，填了 AccessKey 就能读到真实的，不用填。
4. AccessKey ID：可省略。填了就会再问 Secret 和地区，之后读真实额度和到期。

**换 key / 续费后改日期**：自动识别的账号都不用管；手填的账号用同名重新添加一次。

## AccessKey：自动识别、真实额度与到期

火山没有用 Ark API key 查额度的接口，要用火山账号的 **AccessKey**（IAM 访问密钥，和 `ark-…` 的 API key 是两套东西）调控制面：

1. 火山控制台 → 访问控制（IAM）→ 访问密钥，创建一对 AK/SK。
2. 给这个 IAM 用户授予方舟（ark）的权限。**自动识别要读取 API key 明文**（`ListApiKeys` + `GetRawApiKey`），需要比"只读额度"更大的权限；只想查额度、聊天仍手填 key 的话，只读权限就够。
3. 添加账号时填上 AccessKey ID 和 Secret。

**每个火山账号各自一套 AccessKey。** 只给你最看重的几个账号配也行，其余照旧。

### 安全说明（自动识别）

AccessKey 能读到账号的聊天 API key，所以**它比 API key 更敏感**：

- AccessKey 和 Secret 明文保存在 magpie 的 `plugin-auth.json`（权限 600），谁能读到 magpie 的数据目录就能拿到。
- 聊天 API key 本身**不落盘**，只在内存里，进程重启后重新取。
- `GetRawApiKey` 是火山定义的敏感凭证读取，火山那边可能有审计记录；个人版也可能被协议 / Access 闸门拒绝，被拒时插件如实报告，不绕过。
- 插件只调只读接口：不轮换、不创建、不禁用任何 key。
- 建议给这对 AccessKey 单独建一个 IAM 用户，只给方舟相关权限，并定期轮换。

读到的内容：

- 套餐类型：Coding Plan → `GetCodingPlanUsage`；Agent Plan → 团队版席位 `GetSeatInfo` → `GetAgentPlanSeatAFPUsage`，个人版回退 `GetAFPUsage`。
- 窗口：5 小时 / 周 / 月，已用百分比（或 已用 / 总额）、重置时间。magpie 的路由据此在接近用完时把账号排后面。
- 套餐到期：个人版 `GetPersonalPlan`（到期时间 `EndTime`、`AutoRenew`、`Status`）；团队版用席位的 `ExpiredTime`。读到的值**优先于手填的日期**。

规则：

- **自动续费的账号到期那一刻不拦截**（可能正在续）。
- 状态是 `Reclaimed` / `Expired` 的算结束，哪怕没有日期。
- 已到期的账号也会继续查：续费后读到新的到期时间，**不用重新添加账号就自动恢复**。
- AK/SK 报错（签名不对、没有权限）只会在卡片上显示错误，**不会让账号下线**，聊天用的 API key 不受影响。
- 控制面结果缓存 60 秒（失败缓存 30 秒），不会频繁打火山。

### 安全说明

- AccessKey 和 API key 一样，**明文**保存在 magpie 的 `plugin-auth.json` 里（文件权限 600）。谁能读到 magpie 的数据目录，谁就能拿到它们。
- AccessKey 只发往 `open.volcengineapi.com` 和 `ark.<region>.volcengineapi.com`，用来签名；聊天请求只用 API key。
- 如果给 magpie 的插件下载设置了代理，插件宿主进程的请求也可能走这个代理。火山是国内服务，建议确认控制面请求走的是直连。

### 验证情况

2026-11-22 用一对有效的 AK/SK 在**个人版 Agent Plan（Medium）**账号上打了真实接口：

- 控制面签名通过（`open.volcengineapi.com` 和 `ark.cn-beijing.volcengineapi.com` 两个域名都能用）。
- `GetPersonalPlan`：`EndTime` 是 RFC3339 UTC（如 `2027-01-22T15:59:59Z`），另有 `PlanType`、`Status`、`StartTime`、`AutoRenew`。
- `GetAFPUsage`：额度桶是 `{Quota, Used, SubscribeTime, ResetTime}`，`ResetTime` 是毫秒；档位字段是 `PlanType`；另有不展示的 `AFPDaily`。
- `GetSeatInfo`：个人版返回一个**全空的对象**（不报错），不能当作有席位。
- `GetCodingPlanUsage`：没有 coding 套餐的账号返回 `{"Status":"Reclaimed"}` 而不是窗口，插件把它当作订阅已结束。
- **自动识别（个人版 Agent Plan）整条链路已端到端验证**：`GetPersonalPlan`（Agent 有数据、Coding 返回 `ResourceNotFound.Plan`）→ `ListApiKeys`（`Filter.Scene="RealAgentPlanPersonal"`，列表里的 `Key` 是打码的）→ `GetRawApiKey({Id})` 取回 46 位 `ark-…` 明文 → 用它发聊天请求，认证通过。另外验证了：普通账号级 key 池里的 36 位 key 打 `/api/plan` 会 401 `API key format is incorrect`，所以必须走专属池。

- **自动识别（个人版 Coding Plan）也在真实账号上跑通**（2026-11-22，用另一个账号在 magpie 里添加，只填 AccessKey）：识别为 Coding Plan、地址 `/api/coding`、`GetCodingPlanUsage` 返回 5 小时 / 周 / 月三个窗口（`QuotaUsage` 的 `Level` 为 `session` / `weekly` / `monthly`）、`GetPersonalPlan` 读到到期日。

**还没有在真实账号上验证的**：Coding 个人版用普通 key 池取回的 key 能否真的用于聊天（识别和取 key 这一步成功了，但没有发过聊天请求去核对认证）、团队版席位（`GetAgentPlanSeatAFPUsage`、席位的 `ExpiredTime` 和 `GetSeatInfo.ApiKey`）、`AutoRenew: true` 的账号。这几条按火山官方 `ark-cli` 文档和社区工具的代码实现。你有这类账号的话，用下面的探测脚本跑一遍，把结果（扫过敏感信息）发 issue，我来核对。

用探测脚本看一眼真实返回（AK/SK 走环境变量，不要写在命令行里）：

```bash
export VOLC_AK=AKLT…
read -rs VOLC_SK && export VOLC_SK
node scripts/probe.mjs coding      # 或 agent
```

输出是火山的原始 JSON，不含你的 AK/SK，但可能带账号 ID，对外贴之前请自己扫一眼。

## 批量导入

从你自己的 ai-gateway（`GET /api/admin/keys`）一次导入多个账号。key 不经过任何第三方，只在你自己的终端和 `kubectl exec` 的标准输入里流转。

```bash
# 默认只演练：key 打码，不改任何东西
node scripts/import-accounts.mjs keys.json --skip 13306063178,18197266405

# 确认没问题再真正导入（先用 --only 拿一个试）
node scripts/import-accounts.mjs keys.json --yes --only 18392357709
```

导入脚本是按固定顺序往 `magpie plugin login` 灌答案的（订阅类型编号、名称、API key、到期日、AccessKey 留空），顺序必须和插件的登录提示一致，`npm test` 里有测试盯着这一点。**第一次用请先 `--only` 导一个**，确认 magpie 的 CLI 接受这样的输入再全量。

只想要整理好的清单、自己手动添加：`node scripts/export-for-magpie.mjs keys.json`。

导出的 `keys.json` 里有明文 key，用完请删除，不要提交（`.gitignore` 已忽略）。

## 选项

在 magpie 的 `plugins.json` 里给这个插件传 options：

```json
{ "baseURL": "https://ark.cn-beijing.volces.com/api/plan",
  "models": { "你的模型ID": { "name": "显示名" } } }
```

火山没有模型列表接口，模型要手写。默认只有一个占位的 `ark-code-latest`，**请换成订阅里真有的模型**。

## 开发

```bash
npm test
```

- `test/plugin.test.mjs`：429 暂停、永久错误、手填到期、登录解析。
- `test/quota.test.mjs`：控制面签名、窗口解析、三条取数路径、套餐到期自动读取与拦截、与 429 暂停合并。
- `test/discover.test.mjs`：自动识别（Agent / Coding / 团队版、多把 key 的选择、失败分类）、分项登录（每种类型问哪些项、密码框、校验）、识别结果缓存与并发、key 被轮换后重试、明文 key 不落盘。
- `test/scripts.test.mjs`：批量导入脚本灌的答案和插件登录提示的顺序对齐（模拟 CLI 逐项提问）。

测试里的接口返回是 mock。个人版 Agent Plan、"Coding 已回收"和自动识别流程的样本取自真实返回（见上面的验证情况，已去掉账号标识）；Coding Plan 有效订阅、团队版席位、自动续费的样本来自官方文档和社区工具的代码，**不等于火山的真实返回**。签名的单元测试是回归向量加独立推导的对照，只保证以后改动不会悄悄变样；签名与火山一致这件事，已经由上面的真实调用验证过。

## 局限

- 只接了 Anthropic 协议（`/v1/messages`）。OpenAI 兼容的 `/v3` 没接，需要的话看 [hzk8000/magpie-ark](https://github.com/hzk8000/magpie-ark)。
- 一个账号只属于一个插件：装了本插件，就不要再用同一个 key 添加到别的火山插件里。
- 非官方插件，与火山引擎、magpie 上游均无隶属关系。

## 许可证

MIT。`quota.mjs` 里的签名、控制面调用和额度窗口解析移植自 [hzk8000/magpie-ark](https://github.com/hzk8000/magpie-ark)（MIT, Copyright (c) 2026 hzk），见 [NOTICE](./NOTICE)。
