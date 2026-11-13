# magpie-jet-hub

[![repo](https://img.shields.io/badge/github-Betsy20/magpie--Jet--Hub-blue)](https://github.com/Betsy20/magpie-Jet-Hub)

把 **deepseek-harness-codearts 插件本体**装进 magpie。装上之后，magpie 的供应商列表里会多出 29 家 AI 编码渠道，用的是你在 DSH 里已经登录好的那批账号 —— 不需要重新登录，也不需要复制凭据。

> **上游插件**：[`iJetLi/dsh-providers-hub`](https://github.com/iJetLi/dsh-providers-hub)（MIT）。
> 它给 DSH 提供 29 家供应商的登录、多账号池、静默续期、积分领取。
> 本仓库**不是它的分支、也不修改它的行为** —— 只把它的发布产物装进 [`vendor/`](vendor/)，
> 外面加一层 magpie 适配。供应商适配、登录流程、续期算法本身的问题去上游提；
> 装不进 magpie、卡片显示不对、控制台没反应，才是本仓库的。
> `vendor/` 的来源、许可与逐文件差异见 [docs/vendor.md](docs/vendor.md)。

## 目录

- [架构](#架构)
- [安装](#安装)
- [29 个供应商，不是一个](#29-个供应商不是一个)
- [账号](#账号)
- [凭据：不需要再登一次](#凭据不需要再登一次)
- [从 dsh-providers-hub 的备份导入](#从-dsh-providers-hub-的备份导入)
- [模型目录：上游全量](#模型目录上游全量)
- [用量页的费用（目录价）](#用量页的费用目录价)
- [冷启动](#冷启动)
- [侧栏页与控制台](#侧栏页与控制台)
- [供应商开关与模型能力](#供应商开关与模型能力)
- [测试](#测试)
- [已知限制](#已知限制)
- [目录结构](#目录结构)
- [上游与致谢](#上游与致谢)

## 架构

magpie 的一个插件包可以注册多个供应商：宿主取模块导出的**每一个函数**当插件工厂，本包的 `index.mjs` 正好导出 29 个 `JetHub*Plugin`。

```
magpie 网关（默认 3425，JET_HUB_USER_GATEWAY 可覆盖）
  ├─ jet-hub-codearts   ┐
  ├─ jet-hub-workbuddy  │ 29 个 provider id
  ├─ jet-hub-qoder      ├─ 全部共用同一个容器实例
  └─ …                  ┘
       └─ auth.loader().fetch → JetHubContainer（内嵌 cordis + 本体 lib/index.js）
            └─ 直连本体 ctx.llm.stream()
                 └─ 各家真实上游
```

两个要点：

- **没有内嵌 HTTP 网关**。本体自己会开一个 OpenAI 兼容网关，但那层只是 `ctx.llm` 的 HTTP 外壳。插件在本进程里直接握着 `ctx.llm`，所以 `container.forward()` 进程内就完成整件事 —— 不占端口、不需要 apiKey。
- **容器必须模块级共享**。29 个工厂各自 new 一个容器会拉起 29 份账号池和模型目录，冷启动直接炸。

## 安装

```bash
# 1) 装运行时依赖（vendor/ 里的本体靠根 node_modules 解析 @deepseek-ai/* 与 jose / undici）
npm install          # 或 bun install

# 2) 装进 magpie
magpie plugin add <你 clone 下来的那个目录>

# 3) 在 magpie 的 Providers 页面里逐家点「Sign in / 连接」，
#    或者用命令行：magpie plugin login jet-hub-workbuddy
```

> ⚠️ **必须用目录路径，不要写包名**。这个包名不在 npm 上（`npm view` 直接 404），
> `magpie plugin add magpie-jet-hub` 只会失败，或者拿到名字相近的别人的包（表现为 `TypeError: undefined is not an object (evaluating 'self.ctx.reflect.provide')`）。
>
> 目录式安装是**直接引用**（不复制、不建软链），所以 `magpie plugin list` 里能看到的就是你改的那份目录。
> 但 magpie **不热重载插件**：改了 `src/` 或 `vendor/` 之后必须重新登录该供应商或重启 magpie，改动才生效。

### 从 GitHub 装（或换机）

`git clone` 下来的目录没有 `node_modules`（`.gitignore` 里就写着），而 magpie 的目录式安装**不会替你装依赖**，所以必须先自己装一次：

```bash
git clone https://github.com/Betsy20/magpie-Jet-Hub.git
cd magpie-Jet-Hub
npm install          # 必须；跳过这步插件会在加载时崩，控制台也就不会出现
magpie plugin add "$PWD"
```

也可以让 magpie 自己装（它用自带的 bun 按 `package.json` 的依赖树装）：

```bash
magpie plugin add github:Betsy20/magpie-Jet-Hub
```

装完可以用 `npm ls --depth=0` 对一眼 —— 根 `package.json` 的 `dependencies` 必须覆盖 `vendor/` 里本体 import 的全部第三方包（`jose`、`undici` 这两个漏过，换机一加载就 `ERR_MODULE_NOT_FOUND`，表现为「控制台打不开」）。`tests/t-deps.mjs` 会扫 Node 侧全部源码的 import 守着这条。

## 29 个供应商，不是一个

本体里有 31 个 provider，其中 **2 个是路由组**（`aggregate` 聚合路由、`jet-hub-auto` 自动选号）。路由组没有自己的账号池和模型目录，注册成 magpie 供应商只会得到一张永远空着的卡，所以**本插件只接那 29 家真渠道**。

完整名单以 `src/plugin.mjs` 的 `DSH_PROVIDERS` 为准（下表只列几行示例）。

| magpie provider id | 显示名 |
|---|---|
| `jet-hub-codearts` | CodeArts (华为云) |
| `jet-hub-workbuddy` | WorkBuddy (国际版) |
| `jet-hub-minimax` | MiniMax Code (中国版) |
| `jet-hub-accio` | Accio (阿里) |
| `jet-hub-codely` | Codely (Unity 团结引擎) |
| `jet-hub-magicrew` | 超级麦吉 (MagiCrew) |
| `jet-hub-magicrewintl` | MagiCrew (国际版) |
| `jet-hub-marvis` | 腾讯 Marvis |
| `jet-hub-qiniu` | Qiniu (七牛云) |
| …共 29 家 | |

模型 id 是 `<provider>/<model>`：

```
jet-hub-codearts/deepseek-v4.1-flash
jet-hub-workbuddy/deepseek-v4.1-flash
jet-hub-qoder/qfmodel
```

`auth.loader().fetch` 把这个前缀换成本体要的 `<dsh provider>/<model>` 再交给本体，本体按前缀分派到对应上游。真渠道的请求仍按到期 / 额度在**该渠道的账号池内**自动挑选账号。

## 账号

### 账号也按 provider 分开

magpie 的 `plugin-auth.json` 里，每家一个裸键，同一家的第二个起带 `#` 后缀：

```
jet-hub-workbuddy          → 第一个账号
jet-hub-workbuddy#a1b2c3   → 第二个账号
jet-hub-codearts           → 第一个账号
```

**这件事现在自动做。** 容器启动好之后插件会静默对齐一次（`src/auth-sync.mjs` 的
`syncAuthQuietly()`），所以账号增删后不用管它。对齐只动本插件的键
（`jet-hub` / `jet-hub-*` 及其 `#` 分支）与**旧版 provider id 的残留键**，别的插件
记录一条都不碰；内容没变就不写盘，写之前留 `.bak-lead-<时间戳>` 备份，写完回读校验，
缺键直接报错。零账号的 provider 会写一条**占位记录**（否则 magpie 报
`no plugin signs in to <id>`，卡片点不动）。

> **别按名字猜归属。** `plugin-auth.json` 里键名恰好等于 DSH provider 名的记录
> （`magicrew` / `workbuddy` / `zcode` / `codearts` …）**是别的插件的登录态** ——
> `plugin-providers.json` 的 `spec` 显示它们来自 `magpie-magicrew-auth`、
> `opencode-autoclaw-auth`、`opencode-codearts-auth` 等，形状是
> `{type:'oauth', refresh, access}`。本插件写的永远是
> `{type:'api', key:'jet-hub-local:…'}`。2026-11-01 曾按名字判断，误删了 18 条
> 别人家的登录态（已从备份恢复）—— 所以现在的判据只认内容，不认名字。

`node scripts/seed-auth.mjs` 是同一份逻辑的手动入口 —— 不重启 magpie 就想同步时用。
`--dry-run` 打印逐家清单与最终写入键数。**具体数字随你登录 / 新建 / 删除账号实时
变化**，别抄进任何文档或断言。

### 在 magpie 里新建账号

每家能建账号的渠道，点「Sign in / 连接」时会先让你选两种方法之一：

| 方法 | 做的事 |
|---|---|
| 连接本机 DSH 账号 | 从已有账号里挑一个接进 magpie，挑完把账号 id 编进 key |
| 在浏览器里新建一个账号 | 让本体真的建一个新号：调 `account.create` 拿登录页，你去浏览器登录，完成后这一行自动变成已签入 |
| 新建一个账号（粘贴 API Key） | 只有 Key 型的三家（`jet-hub-modelscope` / `jet-hub-opencode` / `jet-hub-qiniu`）有这条：贴一把 Key，插件调本家的 `*.addAccount` 直接建号 |

超级麦吉两站（`jet-hub-magicrew` / `jet-hub-magicrewintl`）的「在浏览器里新建一个账号」会先真开一个**一次性独立 profile 的可见窗口**让你登**新号**（不是 `--incognito`：`vendor/lib/chromium-session.js` 只传 `--user-data-dir`），退回「导入本机浏览器里已有的登录态」只在 `account.create` 这个 RPC 本身没给出可用结果时发生：账号池写不进去 / RPC 超时 / 容器异常 / 返回体里 `accountId` 是空串。**本机没有浏览器不会触发它** —— `browser` 那条腿是「先返回、后开窗」，开窗失败只会变成 `login.poll` 的终态错误显示在卡片上，不会退回导入。这是刻意的：用户点的是「新建」，拿回一个本机旧号（可能还是别人的卡）比看到一句「窗口起不来」更糟。这个顺序是 2026-11-02 定的：反过来的话，只要本机浏览器登着超级麦吉，点「新建」就永远只是把那个旧号导进来，新号根本建不出来。

> 「导入本机会话」那条腿拿到凭据后没有授权页可等，插件返回 `opened: true` + `url: ''`。这只是**纯防御**：当前 magpie 版本下 `opened` 取真取假渲染完全相同（`internal/gui/api.go` 的 `openError` 对空 URL 直接 `return ""`，注释原话「"" when it did, or when there is no url」；`app.js:12106`/`:12210` 两处都 `&& signing.url` 短路）。真正让用户看到正确提示的是 `instructions` ——「已经读到登录态，不需要在页面上做任何操作」，而原来那句「在打开的页面里登录」会让人去找一个永远不出现的窗口。

`jet-hub-modelscope` / `jet-hub-opencode` / `jet-hub-qiniu` 是 Key 型渠道，本体对它们调 `account.create` 会回 `unknown provider` —— 上游 UI 走的是各自的 `modelscope.addAccount` / `opencode.addAccount` / `qiniu.addAccount`（贴 Key 就建号，按 Key 尾段派生账号 id，同一把 Key 反复贴只会落到同一条）。插件照抄同一条路，所以这三家**能新建**，只是方法形状不同：`api` 型 + `keyless`，用 `ask()` 收 Key（`type: 'password'`），`authorize(inputs)` 里再把 Key 交给本家的 RPC。

> 为什么 `keyless`：magpie 对 `api` 型方法会先弹它自己的 personal-key 输入框，而那个框的值只进 `key` 字段、**不会**传给 `authorize(inputs)`。标 `keyless` 让 magpie 跳过它，用户看到的就是插件自己的 Key 输入框。

### 挑哪一行就真的走哪个账号

`seed-auth.mjs` 摊平出来的有账号的行都带 `uid`，插件的 `loader(getAuth)` 会读出「当前这个 magpie 账号是谁」，在请求作用域里把本体的选号收窄到那一个账号（`src/container.mjs` 的 `_pinAccounts` + `AsyncLocalStorage`）。

四条边界：**签入阶段**你挑了一个已不在池里的账号 → 直接报错让你重新点「连接」（否则你以为钉了 A、实际走池内顺序）；
**签入阶段**你挑了一个「账号在、凭据不在」的空壳 → 也报错，让你回 DSH 重新登录或改用「新建账号」（否则 magpie 显示「已登录」，实际查额度报错、请求抛 `MISSING_CREDENTIAL`）；
**请求阶段**钉住的账号被删了 → 退回池内顺序、不让整家 502；钉住的账号已停用或凭据不可用 → 返回空，不绕过 `enabled` 判据。

空壳账号的判据是 `~/.dsh/.credentials.yaml` 里有没有它那条 `credentialRef`（`container.credentialAlive()`，纯读文件、不启动容器）。
弹窗里这类账号会标「（无登录凭据）」。本机实测 2026-11-01：59 个账号里 2 个是空壳 —— 一个是 9 月建的旧账号（凭据早丢了、`refreshable: false`），
一个是没登完留下的占位（昵称等于 id）。**从 DSH / magpie 新建的账号不是空壳**：那条链路会真走上游认证并写凭据。

**钉不住的两类行**（钉不住 = 整家一起用、按池内顺序选号，不影响使用）：`seed-auth.mjs` 写的占位行（零账号的 provider），以及**没挑账号**时点「连接」生成的 `:direct` 行。想钉住就在弹窗里挑一个账号。

## 凭据：不需要再登一次

本插件不向用户要任何凭据。DSH 已经把账号写在 `~/.dsh/.credentials.yaml` 的 `refs:` 段里，`src/credentials.mjs` 用一个 `FileCredentialProvider` 把它桥成容器的 `credentials` 服务 —— 本体读到的就是它平时读的那份。

⇒ 在 DSH 里登录过的账号，在 magpie 里立刻可用；反过来，本体刷新出的新 token 也会写回同一个文件（原子替换 + `.bak`）。

## 从 dsh-providers-hub 的备份导入

上游导出的备份是一份自包含快照（`format: 'dsh-codearts-auth/backup'`）：账号池 + 凭据 + 模型黑名单 + 永久锁定表。本插件用它自己那三处落点（`.credentials.yaml` 的 `refs:` 段、`~/.dsh/jet-hub/state.json`、`~/.dsh/jet-hub/permanent-locks.json`），所以导入就是**翻译**：

```bash
node scripts/import-backup.mjs <备份文件.json> --list      # 先看里面有什么
node scripts/import-backup.mjs <备份文件.json> --dry-run   # 再看会改什么
node scripts/import-backup.mjs <备份文件.json>             # 真写（默认 merge）
```

- **`--mode merge`（默认）**：账号只增加不覆盖（按 `id` 判重）；凭据**只补不抢** —— 本机缺的 ref 用备份补上，本机已有值的一律保留（运行时 refresh 会把新 token 写回同一 ref，用几天前的备份盖掉它等于把 refresh_token 打回上一代，直接登不上）；黑名单与永久锁定表不碰。
- **`--mode replace`**：账号池与永久锁定表整体换成备份里的值，本机现有账号会被丢弃。永久锁定表落在独立文档 `~/.dsh/jet-hub/permanent-locks.json`，不是 `state.json` 的字段。
- **模型黑名单两种模式都不写**。`disabledModels` 的语义是「本体自己那份模型目录里哪些别列出来」，而「哪些模型给 agent 用」由 magpie 的 Providers 编辑器决定。把备份里那份旧状态盖回来，只会让每条模型挂上 `· 已在 Jet Hub 关闭` 的尾巴，而用户没有界面能清掉它。真要写回得显式加 `--keep-disabled`。
- **加密备份**直接喂给脚本即可。口令按 `--passphrase` → 环境变量 `JET_HUB_BACKUP_PASSPHRASE` → 交互输入 的顺序取：

  ```bash
  JET_HUB_BACKUP_PASSPHRASE='…' node scripts/import-backup.mjs backup.enc.json
  ```

  控制台的「备份 → 导入」也认加壳备份：选好文件、在「加密备份的口令」框里填口令再点导入（页面用 WebCrypto 复刻同一套参数解壳）。不加壳的备份把口令框留空。控制台调 `backup.import` 时恒传 `keepDisabledModels: true`，所以在界面上选「覆盖」也不会换黑名单。

写完账号池后脚本会接着跑一次 `seed-auth.mjs`，把账号摊平进 magpie（`--no-seed` 可跳过）。三处写入前都留 `.bak-import-<时间戳>` 备份，写完回读校验，值对不上直接报错退出。

> 顺序很重要：**账号池与凭据先落地，magpie 才看得到**。反过来只改 `plugin-auth.json` 的话，卡片上会出现一堆账号，但容器里没有它们，chat 一律 502。

## 模型目录：上游全量

有两套目录，不要混用：

| 来源 | 含义 |
|---|---|
| 网关 `/v1/models` | 此刻**能用**的 |
| 本体 `model.list` RPC | 上游**全量** |

magpie 里每个 `jet-hub-*` 用的是后者。全量里已在本体关掉的模型照样列出，名字后缀 `· 已在 Jet Hub 关闭`、页面里显示为灰，提示你到 magpie 的 Providers 编辑器里打开。

取数链路：容器启动 → 网关 `/v1/models` + `model.list` RPC → 落盘 `~/.config/magpie/jet-hub-models.json`（`{ at, models, full, meta }`，`meta` 是模型能力元数据）→ 宿主 `provider.models()` 同步读盘立刻返回 → 页面由 `node scripts/snapshot-models.mjs` 读同一份盘生成 `page/models.js`。

两种情况下要重跑 `node scripts/snapshot-models.mjs`：上游上新模型后；以及**控制台端口变了以后** ——
侧栏「控制台」标签的地址读的就是这份快照（`page/models.js` 的 `console` 字段），不重跑会一直指向旧端口、连到别的实例。

## 用量页的费用（目录价）

magpie 的「观测 / 用量」里有一列**费用**。默认它对本插件的请求显示「—」，因为它自己
查价时走 `pricedNames()`，那个函数**只按整串模型名**查 models.dev 目录、不剥
`provider/` 前缀；而这里的模型 id 是 `workbuddy/deepseek-v4.1-flash` 这种形状，
一律查不到。

所以由插件把价格挂到模型条目上（`provider.models()` 返回项的 `cost` 字段，magpie 的
`pluginPrice()` 认这个形状）：

```jsonc
"deepseek-v4.1-flash": {
  "name": "DeepSeek V4.1 Flash",
  "cost": { "input": 0.247776, "output": 1.152575, "cache": { "read": 0.006, "write": 0 } }
}
```

（这条是 22 家来源的中位数，所以小数位很长；官方直营的条目常见一到两位，
`cache.*` 可能到三四位。）

单位是 **USD / 1M tokens**，与 magpie 内部的 `catalog.Price` 同口径。价格表在
`src/model-prices.mjs`，由 `node scripts/gen-model-prices.mjs` 从 magpie 缓存的
models.dev 目录（`~/.cache/magpie/models.json`）按**模型尾名**匹配生成（尾名 = 去掉
`jet-hub-xxx/` 首段后的剩余部分，`@preset/…` 这类多级路径会原样保留）：本插件的快照
里有 979 个模型（`snapshot-models.mjs` 重跑后；旧版 894），价表 464 条里有 459 条对得上；表是 2026-11-01 那版
目录算出来的（本轮换 vendor 后没重跑，`node scripts/gen-model-prices.mjs` 可刷新）；
剩下的多是各渠道自造的私有名（`@preset/cline-*`、`DeepSeek-V4-Pro-Official` 之类），
公开目录里没有。

尾名匹配会**撞上别家同名型号** —— 同一个名字目录里常有多家在卖、价差 2–10 倍。所以
取价有三条规则：`auto` / `standard` / `professional` / `ultimate` 这类**路由名和档位名直接跳过**
（它们在目录里撞上的同名条目属于别家产品，贴过来就是编数字）；有**厂商直营**报价就用
它；官方没收录才取所有来源的**逐字段中位数**。每条价来自哪家记在同文件的
`MODEL_PRICE_SRC` 里（`official:google` 或 `median(3)`），换价时 `git diff` 能看出是
谁变了。

三条要记住的：

- **表里没有就绝不发这个字段。** magpie 的判据是 `Cost == nil || (Input <= 0 && Output <= 0)`，
  发一个全 0 的对象等于「确认免费」，会把「不知道」说成 0；不发才落回它自己的兜底链。
- **这是参考价，不是账单。** 这些渠道多数是订阅制（买会员、送积分），按 token 计价只是
  拿公开目录价换算出来的口径，用来横向比较「哪个模型贵、这次调用大概多少钱」。
- 换新模型后重跑 `node scripts/gen-model-prices.mjs` 再重启 magpie。生成器是**可复现**的：
  枚举与输出都按名字排序、表头时间取目录文件的 mtime，所以目录没变就不会产生假变更，
  重跑后 `git diff` 里只会出现「价格真的变了」的条目。

## 冷启动

本体冷启动要建容器、拉凭据链、预热目录，**20–30 秒**（预热过的实例通常 1–2 秒），而 magpie 给 `provider.models` 的超时只有 **20 秒**。所以在 `models()` 里 `await` 必然超时。

`models()` 因此分三档：内存缓存命中 → 立刻返回并后台刷新；磁盘缓存命中 → 立刻返回真实目录；都没有 → 返回静态兜底表（29 家各一条），启动甩到后台。`authorize()` 与 `usage()` 由用户点击触发、允许长时间，走真等。

## 侧栏页与控制台

magpie 里这个插件有两个界面：

**侧栏页**（`page/`）跑在 magpie 的窗口沙箱 iframe 里，只能读 `providers:list` 一项，所以是**只读**的三个标签：接入 / 控制台 / 设置。
它只回答两件事 —— 「客户端怎么填」和「其余的事去哪做」；模型目录、用量、供应商列表都在 magpie 自己的页面里，插件不重复一遍。

**本地控制台**（`console/`）是完整功能，注册在 `http://127.0.0.1:18500/`。端口被占时向后顺延（18501、18502…），
但**只有拿到首发端口 18500 的那个实例**才会把地址写进 `~/.config/magpie/jet-hub-console.json` ——
漂移到别的端口时不写，别拿那个文件当唯一来源。左栏是**供应商列表**（注册 29 家，快照里 29 家都有模型条目
—— `marvis` 那条是静态兜底（`main-auto`），上游没有模型目录端点），底部一行三个切页按钮，主区是**账号页**（默认视图）：

| 位置 | 做什么 |
|---|---|
| 供应商列表（左栏） | 点一家就切到它的账号池；选中项品牌色描边 |
| 账号（默认视图） | 登录、续期、停用 / 启用 / 删除、批量重置；每张账号卡自带积分读数（其余 / 临期）与全部领取、永久锁定；「补偿」只在 buddy 出现，「新人奖励」只在 loomy / raccoon / magicrew / magicrewintl 四家出现 |
| 概览（底部按钮） | 容器状态、模型目录、网关地址、每日签到、专项额度 |
| 设置（底部按钮） | 渠道原生搜索、面板入口、MiniMax XFF、徽章偏好、验证码载体 |
| 备份（底部按钮） | 导出 / 导入（含加壳备份） |

> 2026-11-05 起「积分」不再是一个独立标签 —— 积分本来就是账号的属性，摊到每张账号卡上
> 才是它该在的位置（上游控制台也是这么排的）。原来那个标签里的批量操作（查状态 / 查余额 /
> 查徽章 / 全部领取 / 永久锁定）挪到了账号页第二行工具栏，每日签到与专项额度挪到概览。
> 同一天「账号」也不再是一个标签：侧栏点供应商就是看账号池，它不值得和概览/设置/备份并列。

界面照搬上游 `jet-hub.js` 的设计语言：`#1677ff` 品牌色、卡片 14px 圆角、`0 2px 8px rgb(31 35 41/3%)` 阴影、
228px 侧栏。供应商图标直接内联上游 `provider-icons.js` 的 data URI（`console/icons.js`，29 个）；
账号列表是**卡片流**而不是表格 —— 每张卡把凭据 ref / 有效期 / 可续期 / 出口代理 / 操作
收在一处，操作按钮贴在该行最右；容器窄于 420px 时按钮自动落到「操作」标签下方换行。
（正文灰 `--fg3` 刻意比上游深一档：`#7c838e` 而非 `#8f959e` —— 后者对白底只有 3.02:1，压暗后 3.82:1。）

写操作全在控制台 —— 侧栏页受 magpie 的 CSP 限制（`connect-src 'none'`、opaque origin），做不出按钮，也别指望它嵌一个进来。

> **哪些事不在这里做**：供应商启用 / 停用 / 排序、每家给 agent 暴露哪些模型、推理档位 —— 这些归 magpie 的 Providers 编辑器；用量与费用归 magpie 的 Usage 页（读的是同一份 `~/.config/magpie/usage.jsonl`）。控制台 2026-10-31 起把「模型」和「用量」两个标签交给了 magpie，侧栏页同日把「模型 / 用量 / 供应商」三个标签一并去掉。

## 供应商开关与模型能力

magpie 的 auth 契约允许插件声明开关，用户在「供应商 → 高级」里拨，插件现读、**不重启就生效**：

| key | 默认 | 打开 | 关掉 |
|---|---|---|---|
| `prefer_full` | 开 | 模型列表用上游全量（含已关闭） | 只列网关此刻可用的 |
| `dead_account_skip` | 开 | 已过期且不可续期的账号不参与选号 | 死号也参与（会 502） |

模型列表里那三列（上下文 / 支持图片 / 推理强度）只能由 `provider.models()` 给：上下文与输出上限来自上游的 `limit`，图片支持看 `input` 里有没有 `image`，推理强度看 `variants` 键列表（magpie 的下拉只认这个）。本体的私有档位名（`off` / `on`）会被翻成规范名（`none` 本身就是规范名之一）。

附件（图片）由 `src/attachments.mjs` 提供：内容寻址 `sha256:<64hex>` 落盘 `~/.config/magpie/jet-hub-attachments`。

## 测试

```bash
node scripts/test-all.mjs        # 全部不需要环境的单测（退出码即结论）
node scripts/test-all.mjs --all  # 连环境的一起跑（要 magpie 网关 3425 与 web 3456 都在）

npm test                         # 等价于第一条（package.json 里的转发脚本）
npm run test:all                 # 等价于第二条
```

> 两条路完全等价 —— `package.json` 的 `scripts` 只是转发到 `scripts/`，逻辑不重复。
> ⚠ 发布出去的插件包不含 `scripts/` 与 `tests/`（`files` 白名单），所以这两个入口
> 只对**从源码 clone** 的目录有效。

`scripts/test-all.mjs` 用**跑它的那个 node**（内部是 `process.execPath`）。要模拟宿主环境时改用 magpie 自带的 bun。
逐项说明、分层规则与 `MAGPIE_WEB_KEY` 的用法见 [docs/testing.md](docs/testing.md)。

## 已知限制

- **账号自身的额度 / refresh token 过期与本插件无关**。`codearts` / `officeace` 等会报
  `STS5.1806 invalid refresh token: 'the refresh token has been used'`，需要在 DSH 里重新登录
  （refresh token 一次性，是上游设计）。
  **为什么会被消耗**：DSH 本体与这里的容器各自持有一份凭据副本，两边都可能去续期；
  谁先续期成功，另一份的 refresh token 就作废了。所以这条报错一旦出现就不会自己恢复，
  必须回 DSH 重新登录那一个账号。
- **额度查询失败时，卡片会显示「上一次成功读到的数据 + 本次未刷新的标注」**，不显示空白。
  上游对「本次查询失败但还有快照」的情形是刻意把快照一起回传的（`stale` 读数）；
  插件原本把它当成「没有数据」直接报错，结果是「说自己显示了旧数据、画面上却什么都没有」
  （2026-11-01 用户截图）。现在照常画数据，并在第一条名字后标「本次未刷新，显示上次数据」——
  因为 magpie 见到 `error` 就整块只画错误、不画 `windows`，所以那层标注只能写进条目名字里。
- **死号会拖垮整个渠道**。本体的选号只看 `enabled` 与限流，不看 `expiresAt` / `refreshable`，所以「已过期且不可续期」的账号一旦排在前面，每次请求都撞 502。本插件在容器层过滤掉这类死号（`src/container.mjs` 的 `_filterDeadAccounts`）—— 但过滤只让它不参与选号，**不会删除**，彻底清掉请去 DSH 的 Jet Hub 删账号。
- `zcode` 可能报「上游并发限流」，本体自带退避，属上游限制。
- **本体的设置界面搬不过来**。那是 DSH 的前端 UI（`vendor/lib/client/jet-hub.js` 依赖宿主注入的 react 与 `connection` 服务），magpie 里由本插件自己的侧栏页 + 控制台替代。
- **侧栏页的模型下拉是快照**（`page/models.js`，设置页「默认模型」用），不随账号变化自动更新；实时清单看 magpie 的 Providers 页。
- magpie **不热重载插件**：改完代码要重启 magpie。

## 目录结构

```
index.mjs              只导出 29 个插件工厂（宿主遍历全部导出）
src/
  plugin.mjs           29 个工厂、auth 契约（methods / loader / usage / checkin）
  container.mjs        内嵌 cordis 容器、直连转发、选号钉住、死号过滤
  llm-bridge.mjs       进程内直连本体 ctx.llm
  credentials.mjs      ~/.dsh/.credentials.yaml ⇄ 容器 credentials 服务
  connection.mjs       给容器补一个 connection 服务（DSH 里由宿主提供）
  hub-server.mjs       控制台 HTTP 服务
  attachments.mjs      图片附件服务
  icons.mjs            29 家内联图标（SVG / PNG data URI 混用）
  site-icons.mjs       四家从官网取的位图（base64）
  magicrew-icon.mjs    \ 两家单独存放的位图，体积大、与上面分开
  zcode-icon.mjs       /
vendor/                上游本体（MIT，见 docs/vendor.md）
page/                  侧栏页（只读三标签，跑在 magpie 沙箱 iframe）
console/               本地控制台（完整功能）
scripts/               snapshot-models / verify-vendor / seed-auth / import-backup / test-all /
                       gen-model-prices / run-console / shot-console.cjs / shot-usage.cjs
tests/                 38 个 UNIT + 2 个 ENV 的 t-*.mjs，加 ui-check.cjs / t-gateway.py（公共桩 _iso.mjs）
docs/                  截图、vendor.md、testing.md
```

## 上游与致谢

- 上游插件：[`iJetLi/dsh-providers-hub`](https://github.com/iJetLi/dsh-providers-hub)（MIT，`Copyright (c) 2026 Jet`）—— 本仓库 `vendor/` 是它的构建产物，`vendor/LICENSE` 随目录一起分发。
- 29 家渠道的登录 / 续期 / 选号逻辑全部来自上游，本仓库只做 magpie 适配层。
- 图标：多数来自各厂商官方标识，少数取自 [LobeHub icons](https://github.com/lobehub/lobe-icons)。
