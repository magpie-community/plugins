<p align="center">
  <img src="./page/icon.svg" width="56" height="56" alt="magpie-gateway-admin icon">
</p>

<h1 align="center">magpie 网关用户管理</h1>

<p align="center">
  给 <a href="https://usemagpie.ai">magpie</a> 的网关加上多用户管理：批量发 key、限额、模型权限、用量看板。成员自己查用量走 magpie 网关自带的 <code>/me</code> 页，不需要额外部署。
</p>

<p align="center">
  <a href="./README.md"><b>简体中文</b></a> ·
  <a href="./README.en.md">English</a>
</p>

<p align="center">
  <img alt="magpie 0.1.3078+" src="https://img.shields.io/badge/magpie-0.1.3078%2B-6b46c1">
  <img alt="Bun 1.1+" src="https://img.shields.io/badge/Bun-1.1%2B-000000?logo=bun&logoColor=white">
</p>

<p align="center">
  <img src="./docs/banner.png" width="1012" height="637" alt="网关用户管理界面：用户与密钥列表，顶部是批量发 key / 导出 CSV / 搜索筛选，列表里有每把 key 的限额、调用次数和花费估算">
</p>

magpie 自带的 Gateway 页面是给单用户准备的：一把共享 key，改不了名、停不了用。这个插件补的是「把网关开给一群人」的那部分——每把 key 有自己的权限、限额和用量。

> [!NOTE]
> 插件不替换 magpie 的 Gateway 页面。默认共享 key 仍然由 magpie 自己管理；这里管理的是新建的多用户 key。

## 快速开始

1. 安装插件：

   ```bash
   # 本地目录
   magpie plugin add /path/to/magpie-gateway-admin

   # 或者 GitHub
   magpie plugin add github:guangzan/magpie-gateway-admin
   ```

2. 打开侧边栏里的「网关用户管理」。
3. 点「批量发 key」，设置名称前缀、有效期和权限；创建后复制或导出明文。
4. 要让用户自己查用量，把**网关的 `/me` 页**发给他们：`http://<运行 magpie 的机器>:3425/me`（端口以 magpie 的设置为准）。他们输入自己的 key 就能看到额度、用量和客户端配置，见下面的「成员自助查用量」。这个地址在 magpie 的 Gateway → Gateway keys 里可以一键复制。

第一次打开会启动插件自己的本地服务，默认地址是 `http://127.0.0.1:3478/`（只在本机，给管理员用）。

## 能做什么

### 用户与密钥

- **批量发 key**：一次发 1–100 把，名称按前缀自动编号（`team-a-01`、`team-a-02`…）。整批是一个事务：任何一把失败，这一批已经落盘的 key 全部删掉，不留半批没限额的孤儿。
- **权限配置**：新建页把模型白名单（`openai/*`、`anthropic/claude-*`、`group/<路由组>`、`group/*`）、上游账号、限额、只读、是否允许查看上游账号余额、是否允许签发子 key 收在一起。
- **限额**：支持每天 / 每周 / 每月 / N 天 / N 小时，最多五条，可按 tokens 或美元计，也可把缓存读计入 tokens；tokens 和美元都填 0 表示这条不限。默认每月 $20 一条，可改可删。
- **限额的作用范围**：magpie 的限额目前不能按模型拆分（`access.Limit` 没有这个字段），所以这里也不提供「只算某些模型」的假开关；限额作用于这把 key 的全部调用。
- **到期与窗口**：单把新建可以直接选到期日；批量按「有效期（天）」算。编辑已有 key 时窗口起点（`since`）和缓存读开关会原样保留，改限额不会把周期窗口清空重发。
- **交付密钥**：创建成功后直接打开交付弹窗，明文可以逐把复制、复制全部或导出 CSV。列表本身只显示掩码；轮换后会再弹一次新明文。
- **限额状态**：列表显示每把 key 当前最紧的一条限额：已用 / 上限 / 重置时间，跑满标红；详情页可以清零已用量（日历窗口的结束时间不变）。
- **用量列**：列表能看到每把 key 今天 / 近 7 天 / 近 30 天的调用数和花费；花费按网关价格估算，未计价的调用会标 `*` 并写明次数。
- **需要关注**：出现限额用尽、接近上限（≥80%）、7 天内到期时，列表顶部会给出提示，点一下就筛选到对应 key；还可以按状态筛选、按名称 / 调用 / 花费 / 限额使用率排序。
- **批量操作**：列表支持多选，批量启用 / 停用 / 删除；停用和删除的确认框会列出受影响的 key 名称。
- **搜索与分页**：按名称 / id / 掩码搜索，本地分页；key 多的时候不用滚到底。
- **导出 CSV**：含用量，由服务端生成，文件写在配置目录下的 `plugin-data/magpie-gateway-admin/exports/`，文件名带时间戳，不会互相覆盖。用量取不到时导出会失败，不会生成一份「调用 0 / 花费 0」的假报表；已经删除的 key 只要有调用，也会以「已删除」一行保留在导出里，不会让这部分花费对不上账。

### 用量

- 按区间汇总：总调用、错误、tokens、缓存读写、花费（估算）、未计价调用。
- 按 key 分组，可点列头按调用 / 错误 / 输入 / 输出 / 缓存读 / 花费排序；点分组里的任意一行，下面的「最近请求」就只看这把 key，可用标签上的 × 取消。
- 单个请求能看到时间、模型、状态、耗时、输入输出和花费，支持失败 / 重试过滤和搜索。
- 网关连不上或接口报错时显示持久错误提示和「重试」，不会把失败显示成 0 和空表；切换区间会先清掉旧数字，避免两个区间混在一起。

> [!NOTE]
> 花费按网关价格估算；未计价调用按 $0 计，不计入美元限额。统计区间以运行网关的机器时区为准。

### 成员自助查用量

成员不需要装任何东西：magpie 网关自带 key 页面，打开网关地址下的 `/me` 就行。

- 用户在 `http://<运行 magpie 的机器>:3425/me` 输入自己的 key，看到的是这把 key 自己的名称、限额和进度、今日 / 7 天 / 30 天用量、最常用的模型，以及 Claude Code、Codex、OpenAI 兼容客户端的配置片段。页面支持简体中文、繁体中文、日语和德语。
- key 只放在标签页的 `sessionStorage` 里，不下发 cookie，页面不接受被别的网页嵌入；数据接口是 `GET /v1/magpie/me`，未知、停用或写错的 key 一律 401，`?key=` 直接被拒（key 不会进地址栏或日志）。
- 这是 magpie 自己的功能，从 0.1.2226 起就有；只要成员能调用网关（局域网共享或反向代理），就一定能打开它。这个插件不再单独提供用户端页面，避免维护第二套登录、会话和用量裁剪逻辑。
- 如果确实需要**请求级明细**（逐条调用、失败原因、key 到期时间），现在的做法是把这部分上游到 magpie 的 key 页面，而不是在插件里再做一个页面。

### 模板

- 把常用的「模型 + 账号 + 限额 + 有效期 + 只读 + 子 key 签发」存成模板，单个或批量发 key 时选一下就行；所有限额窗口和缓存读开关都会原样带过去。
- 模板页可以改名、删除，也可以直接点「用此模板发 key」跳到批量发 key 并预选这个模板。
- 模板存在配置目录下的 `plugin-data/magpie-gateway-admin/templates.json`，不碰 magpie 自己的配置。模板只保存相对的窗口定义，不保存某一把 key 的 `since`。
- 最多保存 40 个模板；模板名称最长 60 个字符。

## 安装

需要 magpie ≥ 0.1.3078（更早的版本没有插件页面）。插件按 Bun 运行时编写，`package.json` 要求 Bun ≥ 1.1；开发和直接运行本地服务时也需要 Bun。

```bash
# npm
magpie plugin add magpie-gateway-admin

# GitHub（不用 npm，直接读仓库里提交的构建产物）
magpie plugin add github:guangzan/magpie-gateway-admin

# 本地目录
magpie plugin add /path/to/magpie-gateway-admin
```

装好之后侧边栏会多出「网关用户管理」。第一次打开会启动插件自己的本地服务（默认 `127.0.0.1:3478`），页面跳到它上面跑。

### 配置目录

配置目录默认按 magpie 自己的规则解析，不会出现「插件读写另一份 `caller-keys.json`」：

1. magpie 可执行文件旁的 `data/`（portable 安装，或有 `.portable` 标记）；共享目录和系统搬走的下载 / 桌面 / 文档目录按 magpie 的 `shared` / `movedFolder` 规则判断；
2. `XDG_CONFIG_HOME/magpie`；
3. `~/.config/magpie`（Windows 用 `USERPROFILE`，不是 `APPDATA`）。

`MAGPIE_ADMIN_CONFIG_DIR`（或 `MAGPIE_CONFIG_DIR`）可以让插件强制换一份配置目录，但 **magpie 本身不读这两个变量**。设了以后插件和 magpie 很可能不是同一份数据，页面顶部会显示警告——只在明确知道 magpie 也指向那里时使用。

> [!WARNING]
> 不要用配置目录覆盖来「隔离测试环境」，除非你也把 magpie 指到同一目录。插件写进去的 key 和限额，magpie 可能根本看不到。

网关地址优先读 `MAGPIE_ADDR`，否则读 `settings.json` 里的 `port`，最后才回落到默认的 `3425`。

### 端口

管理服务的端口被占用时可以在插件选项里改：

```bash
magpie plugin options magpie-gateway-admin '{"port": 3479}'
```

这个服务只监听 `127.0.0.1`，不给局域网开放：插件页面本来就在本机的沙箱 iframe 里，而成员入口是 magpie 网关自己的 `/me`，不需要第二个对外端口。

卸载：

```bash
magpie plugin rm magpie-gateway-admin
```

## 它是怎么工作的

magpie 的插件页面跑在 `sandbox="allow-scripts"` 的 iframe 里，CSP 是 `connect-src 'none'`，源是不透明的：页面发不出请求，也没有 cookie 和 localStorage，更拿不到 `/api`。

所以页面只做一件事——把自己导航到插件宿主起的本地 HTTP 服务（`package.json` 里的 `magpie.page.service`）。真正的界面和接口都在那个服务上：

```text
magpie 窗口
└── iframe（sandbox=allow-scripts，只能加载自己的文件）
    └── location.replace → http://127.0.0.1:3478/
        ├── ui/              管理界面
        ├── lib/server.mjs   本地接口
        ├── magpie gateway-key …   发 key / 轮换 / 删 key / 改账号 / 清零已用量
        ├── <配置目录>/caller-keys.json  限额、模型、账号、到期
        └── 网关（settings.json 的 port，默认 127.0.0.1:3425）  限额余量、用量、请求明细、模型目录

成员侧不经过这个服务：他们打开的是网关自己的 http://<网关地址>/me。
```

插件读取网关的只读接口（`/v1/magpie/limit`、`/v1/magpie/usage`、`/v1/magpie/usage/requests`、`/v1/models`、`/v1/magpie/quotas`），写入 `caller-keys.json`。写入和 magpie 用同一个 `caller-keys.json.lock`（`flock`；Windows 退化成插件自己的锁文件），采用「临时文件 + rename」原子写，权限 `0600`，改之前留一份备份。

## 安全

- **只监听本机**：管理服务固定绑定 `127.0.0.1`，不对外网开放；请求的 `Host` 必须是 `127.0.0.1` / `localhost` / `[::1]`，否则直接 421，防止 DNS rebinding。管理接口还会检查连接来源的 IP，只接受回环地址——别的机器即使伪造 `Host: 127.0.0.1` 也进不来。
- **每次启动换 token**：服务启动时生成随机 token，内联进 HTML，接口用 `x-magpie-admin-token` 校验（`timingSafeEqual`）。别的网页拿不到这个 token，也就调不动接口。
- **同源检查**：非本机 `Origin` 一律 403；CORS 只把请求里的本机 `Origin` 原样还回去，不做通配反射；`Origin: null` 只留给 magpie 自己的沙箱页面。
- **严格 CSP**：管理页使用 `default-src 'none'`、`script-src 'nonce-…'`、`connect-src 'self'`，并显式放行 `http://127.0.0.1:<port>` / `localhost` / `[::1]` 这几个本机源。这里不能加 `X-Frame-Options` / `frame-ancestors 'none'`：这一页本来就跑在 magpie 的 sandbox iframe 里，禁框会把整个插件挡在外面；防跨站靠 Host、Origin 校验和每次启动的 token。同理也不发 `Cross-Origin-Resource-Policy: same-origin`，否则 opaque 源的 iframe 加载不了自己的构建产物。
- **成员侧的安全由 magpie 负责**：`/me` 的登录、会话、数据裁剪都是网关自己的实现（`keypage.html` + `GET /v1/magpie/me`），这个插件不接触成员的 key 和会话。
- **明文按需取**：列表接口只给掩码（末 4–6 位）；点「复制」时向本地服务单独取一次明文，只有拿着页面 token 的管理页调得动。轮换后会弹一次新明文。
- **文件权限**：导出的 CSV 和备份都是 `0600`，和 `caller-keys.json` 同目录权限。交付用的密钥 CSV 是明文，分发完请手动删除——它不会自动过期。

## 沙箱里做不了的几件事

这几个不是 bug，是 magpie 的 iframe 策略决定的，插件里都做了替代方案：

| 能力 | 沙箱里的结果 | 这里的做法 |
| --- | --- | --- |
| `<form>` 提交 | 没有 `allow-forms`，`submit` 事件不触发 | 全部用按钮点击，回车在输入框里手动接管 |
| `confirm()` | 没有 `allow-modals`，直接返回 `false` | 自己画确认弹窗 |
| `navigator.clipboard` / `execCommand('copy')` | 被拒（`NotAllowedError`） | 弹窗里把内容全选，提示按 ⌘C |
| `a[download]` | 没有 `allow-downloads`，静默失败 | 让宿主服务把文件写到磁盘，界面给出路径 |
| `localStorage` | 不透明源，`SecurityError` | 用量区间这类偏好不持久化 |

## 已知限制

- `magpie.page.service` 目前没有写进公开文档（社区插件 `@magpie-community/page-chat` 用的也是它）。magpie 改了这个字段的话，页面会退化成一张静态说明页。
- 默认的共享 key（LAN key）不能在插件里改名、停用、改到期、设只读、删除或轮换——那是 magpie 自己 Gateway 页面管的。改到期同样能让 key 失效，所以和「停用」一样被拦住。插件里会明确拒绝并提示，列表里对应的操作也会禁用。
- 端口被另一个管理台占着时，只有在配置目录和版本都一致时才复用；不一致会拒绝启动并给换端口的命令，避免页面管到另一份 `caller-keys.json`。
- 账号绑定走 `magpie gateway-key accounts`，由 magpie 自己校验 provider 是否存在。magpie 0.1.3078 的 `gateway-key` 没有 `mcp` 子命令，所以插件不提供 per-key 的 MCP 绑定。
- 插件假定 magpie 网关和管理服务跑在同一台机器上：服务端以 loopback 身份读取用量、限额和模型目录。`MAGPIE_ADDR` 指向远端网关时，远端会把无 key 的请求拒掉，列表里的用量和限额会取不到。
- 成员自助入口依赖 magpie 自带的 `/me`（0.1.2226+）。需要请求级明细时，请上游到 magpie 的 key 页面，而不是在这里再加一个用户端。
- 导出落在运行 magpie 的那台机器上。沙箱页面不能直接下载，这是取舍。

## 开发

```bash
pnpm install      # React / Ant Design / zustand / vite / typescript
pnpm build        # tsc 检查 + vite 打包到 ui/dist（提交了构建产物，装插件时不用再 build）
pnpm dev:ui       # vite dev server，/api 代理到 127.0.0.1:3478

bun test          # 62 个测试：路径解析、校验、文件读写、HTTP 接口、批量操作、静态页、安全头
bun run serve     # 不起 magpie，直接跑服务，浏览器开 http://127.0.0.1:3478/
```

测试用假的 `magpie` CLI 和一个临时配置目录，不会碰你真实的 key。

`ui/dist` 是提交进仓库的构建产物：magpie 从 git 或 npm 安装插件时不会执行构建脚本，改完界面要重新 `pnpm build` 并一起提交。

### 环境变量

| 变量 | 作用 |
| --- | --- |
| `MAGPIE_ADMIN_CONFIG_DIR` / `MAGPIE_CONFIG_DIR` | 强制插件使用另一份配置目录。**magpie 不读这两个变量**，只在明确知道 magpie 也指向那里时使用。 |
| `MAGPIE_ADDR` | 网关地址，例如 `127.0.0.1:3425`、`http://127.0.0.1:3425`；省略协议时自动补 `http://`。 |
| `MAGPIE_BIN` | magpie CLI 的路径；不设时从 `PATH` 和常见安装位置查找。 |
| `MAGPIE_ADMIN_ORIGINS` | 额外允许的浏览器来源，逗号分隔；只用于开发调试。 |
| `PORT` | `bun run serve` 的端口，默认 `3478`。 |

### 技术栈和目录

界面是 React 19 + Ant Design 6 + TypeScript，状态用 zustand，打包用 vite。主题跟随 magpie 自己的设置（浅色 / 深色 / 跟随系统），而不是只看 macOS 的外观：跳转时用 URL hash 带上当前深浅，之后通过 magpie 的 page bridge 继续接收主题切换和 `--magpie-*` 颜色 token；在浏览器里单独打开时回落到系统的 `prefers-color-scheme`。同时关掉了 Ant Design 的所有动效（`wave` 和 `token.motion`），因为插件页在 magpie 的沙箱 iframe 里，动画只会让人等。

```text
index.mjs          插件宿主入口（import 时起服务）
page/              在 magpie 里跑的那一页，只负责跳转
ui/src/            管理界面源码（App / views / modals / store / api / types）
ui/dist/           vite 构建产物，服务直接托管
ui/vite.config.ts  base "./"、target safari17、dev 代理
lib/server.mjs     本地 HTTP 接口（含 Origin/Host 校验、批量事务回滚）
lib/store.mjs      caller-keys.json 的读写与加锁
lib/cli.mjs        magpie gateway-key 的封装
lib/gateway.mjs    网关只读接口（带短 TTL 缓存）
lib/validate.mjs   与 magpie access 包对齐的校验
lib/templates.mjs  模板
lib/csv.mjs        CSV 生成（公式注入转义）
lib/errors.mjs     标准 HTTP 错误
lib/lock.mjs       跨进程 flock
lib/paths.mjs      magpie 配置目录、网关地址、CLI 路径
```

### 发布

推 `v*` tag 会触发 `.github/workflows/ci.yml`：先跑测试和构建，再通过 npm 的 Trusted Publishing（OIDC）发布，不需要在仓库里存 `NPM_TOKEN`。发布前记得把 `package.json` 的版本号改好，tag 必须和它一致。

---

## 许可证

[Apache-2.0](./LICENSE)。版权与归属声明见 [NOTICE](./NOTICE)。

---

<p align="center">
  <a href="./README.md"><b>简体中文</b></a> ·
  <a href="./README.en.md">English</a>
</p>
