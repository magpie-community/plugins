# magpie-quwork

> **改这个插件前先读 [AGENTS.md](./AGENTS.md)** —— 尤其是「不要重启 magpie」那一条。

把 **QuWork（qurvis）** 的模型额度接成 magpie 的可路由供应商。

> 一句话：**一个 `llm_token` 就能调模型；平台 `token` 只影响额度显示与续期。**

---


## 安装

```bash
# 本地开发
magpie plugin add /path/to/magpie-quwork

# 或从 GitHub
magpie plugin add Practice019/magpie-quwork
```

装完在插件 → 已安装里能看到两张卡：`quwork`（供应商）与 `QuWork 面板`（管理面板）。

## 1. 它做什么

| 钩子 | 行为 |
|---|---|
| `config` | 把 provider 的 `baseURL` 指向模型平面 `https://llm.quwork.cn/v1` |
| `auth.loader` | 把任何 `/chat/completions` 请求改写到模型平面，鉴权换成 `Bearer <llmToken>`，按 `bodyMode` 补客户端形态（见 §2.5） |
| `auth.usage` | 有平台 `token` → 读 `/api/user/self` 的 **`points_entitlement`** 显示积分（`额度 · 平台积分`）；只有 `llmToken` → 给一条说明窗（`说明 · 额度未知`，不伪造额度） |
| `auth.methods` | **数组**（magpie 直接 `map` 它），四项：① 手机号 + 短信验证码（**真登录**）② 打开浏览器登录（读浏览器存储）③ 粘贴 `llm_token` ④ 粘贴 `llm_token` + 平台 `token` |
| `provider.models` | live `GET /v1/models` → 失败回落内置的 10 个权威模型 |
| `auth.checkin` | 签到：`GET /api/user/daily-reward/status` + `POST /api/user/daily-reward/claim` |
| `auth.import` | 「添加提供商」里的**从文件导入**（magpie 自有钩子，OpenCode 忽略）：单对象 / 数组 / `version:1` 容器 / NDJSON 都认，`llmToken` 必需；与 `plugin-auth.json` 里已有的 `quwork*` 去重，单次最多 100 条（超出会明确说还剩几条） |
| `icon`（`auth.icon`） | 官方图标的内嵌 PNG data URI（约 14 KB，magpie 不拉外部 URL） |
| `QuWorkPage`（**模块级具名导出**） | 本地面板服务：账号 / 邀请码 / 绑定 / 权益（见 §7.6） |

> ⚠ 形状踩过的坑：`auth.methods` 返回**对象或函数**会让真机装载直接炸
> （`magpie: (auth.methods ?? []).map is not a function`）。它必须是
> `Array<{type:"oauth", label, labels?, prompts?: Array<{type,key,message,placeholder?}>}>`。
> `auth.usage` / `auth.loader` / `provider.models` 则必须是**函数**，且
> `usage`/`loader` 的第一参数是 `getAuth`。`tests/shape.test.mjs` 钉住这些。
>
> ⚠ **积分字段**：真实可用额度在 `points_entitlement.total_points`（字符串，如
> `"1099.60"`）；`amount` / `quota` 在 qurvis 这套里**恒为 0**。早期读 `quota`
> 导致卡片永远显示「0 积分」。主窗用 `used = limit = total`（余额语义 ⇒ 显示 0% 占用），
> `permanent_points` / `limited_points` / `active_subscription` 各给一条 `aside` 窗
> （`额度 · 永久积分` / `额度 · 受限积分` / `说明 · 订阅 <套餐名>`）。

## 2. 两个 base（**别混用**）

```
模型平面  https://llm.quwork.cn/v1      ← /v1/chat/completions、/v1/models（Bearer llmToken）
平台 API  https://llm.rrzu.com         ← /api/user/self、/api/user/refresh（Bearer token）
```

真源：客户端缓存 `%APPDATA%\qurwork-desktop\qurwork-model-config-cache.json`
里 `provider.baseURL = https://llm.quwork.cn/v1`；平台接口见
`register-machine/docs/quwork/README.md §3.1`。

早期把两者当成同一个 host 会让 chat 打到平台 API 上 —— 所以代码里它们叫
`MODEL_BASE_URL` / `PLATFORM_BASE_URL`，各用各的。

### 2.5 请求形态（对齐客户端，见 `docs/CLIENT-REVERSE.md` §1.3 / §1.4）

**头**（调用方已设则不覆盖）：

```
Authorization: Bearer <llmToken>
X-QurWork-Env: prod            # dev 环境时为 dev
X-QurWork-Version: 1.7.5
User-Agent: pi/1.5.0 (win32; node/v<运行时真实版本>; x64)
Accept: application/json
```

⚠ **不发** `traceparent` / `x-request-id` / `session_id` 类头 —— 客户端对模型平面
请求是 `sendSessionAffinityHeaders: "withhold"`（§1.3）。多带一个反而更像「不是客户端」。

**body**（`bodyMode: "client-shape"`，默认）：

| 字段 | 处理 |
|---|---|
| `stream` | **强制 `true`**（客户端写死流式，§1.5） |
| `stream_options` | 缺省补 `{ include_usage: true }`；显式给的尊重 |
| `thinking` | **仅 deepseek 系**（`deepseek-flash` / `deepseek-v4-pro`）缺省注入 `{type:"enabled"}`；`reasoning_effort:"off"` 时是 `{type:"disabled"}`；已经给了就不覆盖 |
| `reasoning_effort` | **仅 deepseek 系**缺省补 `"high"`；其它模型不动 |
| `messages` / `tools` / `tool_choice` / `max_tokens` | **一个字不动**（`max_tokens` 不裁剪、不补默认） |

`bodyMode: "passthrough"` → 完全不调 `shapeBody`，**逐字节原样发**（连 `stream` 都不补）。

> `thinking` 是最容易漏的那个字段：只按「OpenAI 标准参数」写 body 会把它丢掉，
> 于是请求长得不像客户端（`docs/CLIENT-REVERSE.md` §1.4 末条）。

## 3. 凭据

```jsonc
// <magpie 配置目录>/plugin-auth.json
{
  "quwork": {
    "type": "oauth",
    "access": "llm_token_xxx",   // = llmToken（magpie 只读 access）
    "llmToken": "llm_token_xxx", // 模型 token：能调模型
    "token": "platform_xxx",     // 可选：平台 token，用于积分显示与续期
    "expire": 1800000000,        // 可选：平台 token 过期时间（秒）；缺失按 2 小时
    "uid": "u-1",                // 可选
    "phone": "138****0000"       // 可选
  },
  "quwork#1": { "...": "第二个账号依次用 quwork#1、quwork#2 ……" }
}
```

- 重复导入同一个 `llmToken`（或同 `uid`）**不会**产生重复条目
- `access` 恒等于 `llmToken`；续期只覆盖 `token`/`expire`，**绝不动** `llmToken`

### 3.1 从文件导入（`auth.import`）

供应商编辑页的「**从文件导入账号…**」由 magpie 自己画 —— 插件提供 `auth.importFrom` +
`auth.import`（缺这两个键，那一行**整行不出现**，且不报错）。

认的输入形状（`llmToken` 优先级：`llmToken` → `llm_token` → `access`）：

```jsonc
// ① 客户端/面板导出的形态
{ "llmToken": "sk-...", "token": "eyJ...", "phone": "150...", "uid": "6415", "expire": 1797702136 }
// ② magpie 账号卡片的形态（access/refresh 是 magpie 的字段名）
{ "access": "sk-...", "refresh": "eyJ...", "accountId": "150...", "expires": 1797702136000 }
// ③ 带 platform 标记的行
{ "platform": "quwork", "llmToken": "sk-..." }
```

外层可以是**单对象**、**数组**、`{provider, version: 1, accounts: [...]}` 容器，或
**每行一个对象的 NDJSON**（空行、`#` / `//` 注释行跳过；中间坏一行只丢那一行）。

- `expire` 是**秒**（自动 ×1000）；`expires` 按毫秒原样收
- 单次最多 **100 条**，超出会**明确**回一条 failed 说明还剩几条（不会静默截断）
- 已存在于 `plugin-auth.json` 的 `quwork*` / 本批次内重复的 `llmToken` → 该条 failed
- 每条错误都带位置：`文件 N 第 M 条：<原因>`

## 4. 模型

默认 10 个（客户端缓存的权威列表）：

`kimi-k2.7-code`、`glm-5.2`、`qwen3.7-plus`、`MiniMax-M2.5`、`kimi-k2.6`、
`glm-5.3-flash`、`deepseek-flash`、`deepseek-v4-pro`、`qwen3.8-max`、`qwen3.8-flash`

默认模型（客户端口径）：`deepseek-flash`。

`deepseek-flash` / `deepseek-v4-pro` 在客户端配置里还带 `compat`
（`maxTokensField: "max_tokens"`、`supportsReasoningEffort: true`、
`thinkingFormat: "deepseek"`）。**本插件不硬编码这些** —— 它们属于客户端运行时，
写进 hook 只会让「请求看起来不像客户端」。需要时由调用方自己带字段。

### 4.1 能力（收不收图 / 调不调工具）从哪来

**只来自上游，不写死。**

| 来源 | 字段 | 说明 |
|---|---|---|
| 客户端 `qurvis-model-config.json`（`DEFAULT_MODELS`） | `supportsImage` | 上游自己的模型配置，冷启动/离线时用它 |
| 实时 `GET /v1/models` | `capabilities` / `vision` / `supportsImage` | 有就以它为准 |

映射（`src/hooks/models.mjs` 的 `mapUpstreamCapabilities`，**唯一一处**）：

| 上游 | magpie |
|---|---|
| `supportsImage` / `vision` / `input_modalities` 含 `image` | `capabilities.input.image`、`modalities.input`、`attachment`、`supportsImage` |
| `input_modalities` / `output_modalities` | `capabilities.input/output.*` 与 `modalities.*` |
| `function_calling` | `capabilities.toolcall` |

两条纪律：

* **上游没给能力字段 ⇒ 回落 `["text"]`**，不按模型名猜。
* `reasoning`：上游没声明时沿用客户端 compat 表的结论（这一族都带推理链）；
  上游一旦显式写 `false` 就照抄。

### 4.2 缓存（T-42 最终口径：**只有模型目录做缓存**）

用户原话：「所有的东西都需要缓存。更新缓存是我们来控制的，不要自动更新缓存」
「重启项目的时候，我不希望它就会自动去发送什么请求」。

但同样明确：「那个 usage 这些也不要改」—— 所以只有 `provider.models` 缓存化：

| 钩子 | 现在的行为 |
|---|---|
| `provider.models` | **只读缓存**：命中 = 0 次；未命中 = **1 次**（provider 级，不是账号数），成功才写；失败回落静态表且不写缓存 |
| `auth.usage` | **每次真实读 `/api/user/self`**（不缓存） |

缓存文件在 magpie 的配置目录（`input.directory`）：

```text
quwork-models-cache.json   { [baseUrl]: { at, list } }     # 模型目录
```

`auth.usage` 每次被问都真读一次上游；面板「刷新选中 / 刷新全部」顺带写的那份
`quwork-usage-cache.json` 只是**副产品**（零额外请求），钩子不读它。

**更新模型目录缓存的是按钮，不是后台**：

- 面板「**刷新模型目录**」→ `/api/models/refresh`：读 **1 次** `/v1/models` 并写缓存
- 打开面板**不会**发任何上游请求；「打开页面时自动刷新一次」默认**关**，
  且即使打开也只有**一次**，没有 `setInterval` 轮询

失败**不写缓存**（下次还会重试）；缓存文件删掉 = 下次重新读。

## 5. 续期（T-41：**总有效期的 50%**）

- `expire` 缺失 → 按 **2 小时**算（客户端 `DEFAULT_ACCESS_TOKEN_TTL_MS`）
- **走完总有效期的一半才续**：`剩余 <= 总长 × 0.5` ⇒ 续；否则**零请求**
  （签发时间优先取 JWT 的 `iat`；拿不到 iat 才回落到固定窗口兜底）
- **60 秒内最多一次**（本插件自加，防止并发请求互相把 token 换废）
- 失败只 `log.warn`，不写盘、不影响对话请求

## 6. 限制与未验证项

| # | 项 | 状态 |
|---|---|---|
| 1 | `/v1/models` 是否真的存在 | ❓ 文档只列了 chat；拿不到就回内置表 |
| 2 | `/api/user/self` 的响应字段名 | ❓ 无实测样本；按 `points/quota/balance/score` 宽容解析，认不出就说认不出 |
| 3 | `refresh` 后旧 token 是否作废 | ❓ 未验证（§7 验证清单第 2 条） |
| 4 | `llm_token` 能否打平台 API | ❓ 推测不能（用途分离）——所以只有 `llmToken` 时显示「`说明 · 额度未知`」 |
| 5 | 注册链路 | ⚠ 发码要过阿里云滑块（§1），本插件不自动化 |

## 7. 登录（四项，按现实可行性排序）

```bash
magpie plugin install D:\project_GIT\magpie-plugins\magpie-quwork
magpie plugin login quwork        # 选登录方式
```

| # | 方式 | 说明 |
|---|---|---|
| ① | **手机号 + 短信验证码** | 真登录（登录即注册）。发码用 **form-urlencoded**、**不需要滑块票据**（服务端没强校验，旧报告的「滑块是硬门槛」是拿 JSON 打出来的误判）。有频率限制：连发会回「验证码发送过于频繁，请稍后再试」 |
| ② | **打开浏览器登录（自动抓取）** | 点一下就**用系统浏览器打开 quwork.cn**（网页版自带完整登录），然后在 3 分钟内每 3 秒轮询浏览器存储里的 token；判「新登录」看四个信号（token 变 / 会话更新变新 / 文件 mtime 变新 / 首次出现平台 token） |
| ③④ | 粘贴 `llm_token`（± 平台 token） | 最后兜底，任何情况下都能用 |

> **凭据来源顺序**（`readLocalCredential`）：浏览器 profile → 客户端 sqlite →
> `.credentials.yaml` → 客户端 leveldb。
>
> 浏览器 profile 候选：Chrome / Edge / Brave（`User Data\{Default,Profile N}`）、Opera。
> 读的是 `Local Storage/leveldb/*.log|*.ldb`；多 profile 命中时优先 host 含
> `quwork`/`rrzu` 的那条，其次取最近写入的。
>
> ⚠ **平台接口不带 `X-QurWork-Env` / `X-QurWork-Version`**：真机实测，同一发码请求
> 带上这两个头就会回「阿里云验证码校验未完成」。这两个头只属于**模型平面**
> （chat / models）。
>
> ⚠ 「新登录」不能只比 `llm_token` 字符串：真机实测服务端会**复用同一个 token**，
> 只比字符串会把「真的登录成功了」判成没变化。见 `isNewCredential()` 的四判据。

登录成功后 magpie 存下：`access = llm_token`（调模型用）、`refresh = 平台 token`（额度与续期）、`expires`（毫秒）。

> 发码端点：`POST https://llm.rrzu.com/api/sendVerifyCode`，`content-type: application/x-www-form-urlencoded`，body `phone=…&type=login`。
> 登录端点：`POST https://llm.rrzu.com/api/user/client/login`，json `{phone, verification_code, platform:"qurvis", device_identifier, device_uuid:""}`。
> `device_identifier` = `sha256("quwork-sha256-v1:" + MachineGuid|SMBIOS-UUID)`（全 0/全 F 来源跳过）。

验证模型能通：

```bash
curl https://llm.quwork.cn/v1/chat/completions \
  -H "Authorization: Bearer <llm_token>" -H "Content-Type: application/json" \
  -d '{"model":"deepseek-flash","messages":[{"role":"user","content":"ping"}]}'
```

## 7.5 迁移：清理已脏的 `plugin-auth.json`（**手工操作，插件不会自动跑**）

早期版本登录后写成了这样（真机截图）：

```jsonc
"quwork#pjcsg3": {
  "type": "oauth",
  "accountId": "",                              // ← 空 ⇒ 卡片显示 Signed in (pjcsg3)
  "access": "sk-…",
  "metadata": { "uid": "", "phone": "", "token": "" }   // ← 空串等于没写
  // expires 整个缺失
}
```

现在登录会正确写入 `accountId` / `metadata` / `expires`，但**旧条目不会自动修**。两种清理方式：

**A. 最简单 —— 删掉重新登录**

在 magpie 里删掉该 QuWork 账号，再 `magpie plugin login quwork` 走一遍。

**B. 手工改 JSON**（<magpie 配置目录>/plugin-auth.json）

```jsonc
"quwork#pjcsg3": {
  "type": "oauth",
  "access": "sk-…",            // 保持不动
  "llmToken": "sk-…",          // 保持不动
  "accountId": "13800000000",  // ① 填手机号（或任何你想要的名字，**不能是空串**）
  "metadata": {                // ② 只留非空值；全空的 metadata 直接删掉这个键
    "nickname": "13800000000",
    "phone": "13800000000"
  }                            // ③ 没有平台 token 就别写 "token" 键
}
```

判断标准（贴进去前自查）：

- `accountId` 是**非空字符串**；
- `metadata` 里**没有任何** `""` 值（全是空就整个删掉）；
- 有平台 token 才写 `token`，否则卡片会一直显示「`说明 · 额度未知`」。

## 7.6 面板（账号 / 邀请 / 权益 / 设置）

装好后 magpie 会显示「QuWork 面板」；也可以本地直起：

```bash
node server.mjs             # 读 $PAGESVC_PORT 或 4392
```

视觉系统与结构照 magpie-loomy 的面板：`page/assets/style.css`（CSS 变量 + 卡片 / 按钮 /
pill / 表格 / 暗色适配）、顶栏 + tab + 统计条、`page/boot.js`（宿主桥接 → 本机面板）。

| tab | 内容 | 端点（平台平面，`Bearer 平台token`，**不带** X-QurWork-*） |
|---|---|---|
| **账号** | 账号表（手机号 / 平台积分 / 到期 / 平台 token 有无 / 键）+ 统计条（账号数 / 积分合计 / 最近到期） | 读：`GET /api/accounts`（缓存）；刷新：`POST /api/accounts/refresh` → `/api/user/self` |
| **邀请** | 自己的邀请码（大字 + 复制）、邀请人数、已获积分；绑定邀请码；邀请记录（job + 进度条） | `GET /api/user/invite/summary`、`POST /api/user/activate`、`GET /api/user/invite/records?page=&page_size=` |
| **权益** | 签到状态 / 签到按钮 / 月月送 / 兑换（订单号 int64） | `daily-reward/status`、`daily-reward/claim`、`benefit/monthly-gifts`、`benefit/redeem` |
| **设置** | 面板端口、自动刷新开关、账号刷新并发、记录拉取页数、上游地址（只读）、设置文件路径 | 读写 `quwork-panel-settings.json` |

**缓存与刷新（硬规则）**

| 文件 | 用途 |
|---|---|
| `quwork-accounts-cache.json` | 账号积分缓存（`GET /api/accounts` 只读它） |
| `quwork-invite-cache.json` | 邀请码缓存（`GET /api/invite/summary` 无缓存则 `cached:false`） |
| `quwork-panel-settings.json` | 面板设置（白名单字段） |

- **打开页面零上游请求**：只调 `GET /api/accounts`、`GET /api/invite/summary`、`GET /api/settings`
- 每个缓存区块显示「缓存时间」（`at` / `updatedAt`）+ 单独刷新按钮
- job：`POST /api/invite/records` → `{jobId}`；`GET /api/job?jobId=` → `{running,done,total,result}`
- 平台接口**一律不带** `x-qurwork-*`（带上会触发阿里云滑块/风控）

**面板连不上时先看这三件事**

| 症状 | 原因 | 处理 |
|---|---|---|
| 表格一直「加载中…」 | **①** 服务端没回 CORS（magpie 用 `file:` 加载页面 ⇒ origin 是 `null` ⇒ 跨域被浏览器拦掉）；**②** `app.js` 用相对路径 fetch，打到页面所在 origin | 已修：所有响应带 `Access-Control-Allow-Origin: *`（含 `OPTIONS` 预检 204 与 PNA 头）；`BASE` 由 `?port=` → `document.currentScript.src` → 同源 逐级推导，**失败再依次换 3 个候选 base**；全失败时表格显示「无法连接面板服务」 |
| 面板打不开（端口被占） | 4392 被别的进程占着 | 已修：`pickPort` 依次试 4392 → 4393 → 4394，最终端口写进 `quwork-panel-settings.json` |
| 重启后没有面板 | magpie 不会替你常驻 | 想常驻可设 `QW_PANEL_AUTOSTART=1`（默认关，避免测试抢端口） |

**验证 CORS（真机）**

```bash
curl -D - -o NUL -H "Origin: null" http://127.0.0.1:4392/api/accounts | grep -i access-control
# Access-Control-Allow-Origin: *
curl -I http://127.0.0.1:4392/            # HEAD 也 200（只发头）
curl -s http://127.0.0.1:4392/任意路径 | head -c 60   # SPA 兜底：回面板 HTML，不 404
```

> ⚠ **平台接口的版本头分两组**（2026-11-20 真机实测，纠正 T-15 的过度修正）：
>
> | 接口 | `X-QurWork-Env` / `Version` | 原因 |
> |---|---|---|
> | 发码 / 登录（`sendVerifyCode` / `loginWithCode`） | **不带** | 带上会被阿里云滑块拦（`阿里云验证码校验未完成`） |
> | 已登录后的全部平台接口（`activate` / `invite/*` / `daily-reward/*` / `benefit/*` / `user/self` / `wechat/bind`） | **必须带**（`prod` + `1.7.5`） | 不带会假报 `client_version_too_low`，把真实原因（如 `wechat_bind_required`）盖掉 |

## 7.7 微信绑定（面板）

平台要求部分账号**先绑微信**才能签到 / 绑定邀请码（回 `error_code: wechat_bind_required`）。

链路（从客户端 `dist-electron/main/auth/` 逆向）：

```
① https://open.weixin.qq.com/connect/qrconnect?appid=wxac3315fe86ebb901
     &redirect_uri=https://llm.rrzu.com/oauth/wechat&response_type=code&scope=snsapi_login&state=<32 hex>
② 扫码 → https://llm.rrzu.com/oauth/wechat?code=…&state=…
③ GET /api/oauth/wechat?code=&platform=qurvis&state=   → wechat_token（10 分钟、用后即焚）
④ POST /api/user/wechat/bind  { wechat_token }          Bearer <平台token>
```

面板操作（账号表 → 状态「需绑微信」→ 行内「绑定微信」）：

1. **① 打开微信扫码** → `POST /api/wechat/start {key}` → 系统浏览器打开授权页
2. 扫码后把浏览器地址栏**整段**粘进「粘贴回调地址」
3. **② 完成绑定** → `POST /api/wechat/finish {key, callbackUrl}` → 服务端解析 code/state 后走 ③④

> ⚠ `redirect_uri` 必须是**已备案域名**，不能指向 `127.0.0.1`（本地 80/443 需改 hosts + 证书，不可行），
> 所以「粘贴回调地址」是必须的一步。`state` 只在内存里存 10 分钟、用后即焚。

> ⚠ 兑换接口要的是 **`order_id`（int64）**：传空/0 会回
> `Key: 'RedeemBenefitRequest.OrderId' ... required`，传字符串会回
> `json: cannot unmarshal string ... of type int64`。所以界面把输入框标成「订单号（纯数字）」，
> 并在本地先挡掉非整数（不发注定失败的请求）。
>
> ⚠ 积分窗（`额度 · 平台积分`）用 magpie 的 **`balance`** 字段（「预付费钱包还剩多少」），**不发 `used`/`limit`**：
> 之前 `used = limit = total` 会被算成「已用 100% / 剩余 0%」（真机截图：872.04 的号显示剩余 0%）。
> `balance` 是 number，magpie 还会按它把余额多的号排前面。
>
> ⚠ 绑定自己的邀请码会回 `不能使用自己的邀请码` —— 这是**正常回执**，面板原样显示。

## 8. 开发

```bash
cd D:\project_GIT\magpie-plugins\magpie-quwork
node --test            # 全绿（当前 175 条）
node -e "import('./index.mjs').then(m=>console.log(Object.keys(m)))"
# → [ 'QuWorkAuthPlugin', '_internal' ]
```

> ⚠ `node --test tests`（目录作参数）在 Node 24 下会被当成**入口模块**，报
> `Cannot find module ...\tests`。用 `node --test` 自动发现，或
> `node --test "tests/*.test.mjs"`。

### 目录

```
index.mjs                  组装（config / auth.methods / auth.loader / auth.usage / provider.models）
src/constants.mjs          两个 base、路径、10 个模型、TTL、客户端 UA
src/identity.mjs           accountId 兜底链 + metadata 紧凑化（compact）
src/auth-store.mjs         plugin-auth.json 读写（多账号、去重、空值不覆盖旧值）
src/login.mjs              手机号+短信登录（form 发码 / json 登录 / device_identifier）
src/browser-login.mjs      读本机客户端会话（sqlite session_json / credentials.yaml）
src/body-shape.mjs         客户端形态：stream / stream_options / deepseek 的 thinking
src/hooks/loader.mjs       请求代理（改 URL、换鉴权、补头、按 bodyMode 塑形、旁路续期）
src/hooks/models.mjs       live 目录 → 失败回落
src/hooks/usage.mjs        积分 / 说明窗（带账号名）
src/refresh.mjs            续期（2h 兜底 / <1h 触发 / 60s 节流）
tests/*.test.mjs           86 条
```

## 9. 出处

协议真源：`D:\project_GIT\register-machine\docs\quwork\README.md`
（端点、token 语义、续期规则、证据分级）。模型表真源：客户端缓存
`qurwork-model-config-cache.json`。代码注释里以 `§x.y` 标注对应小节。
