# magpie-quota-proxy

极简、零依赖的 **Magpie 插件**，用于解决 **「使用 Magpie 管理多账号池时，Orca 等外部客户端无法展示账号池额度、只能看到单个登录账号额度」** 的问题。

它在 `127.0.0.1` 上提供一个极窄范围的本地 HTTP/HTTPS 代理，把 **Orca**（含桌面端与移动端同步）等支持代理或 PAC 的客户端发往官方额度查询接口的请求，透明替换为 **Magpie 多账号池汇总额度** 或你在控制页中 **指定账号的额度**；其余对话、补全与其他所有网站流量一律原样透传。

- **零改源码**：不修改 Magpie 本体，也不修改 Orca 或任何客户端本体，纯本地薄代理层。
- **安全默认全关**：首次安装或重置配置后，全部拦截规则均为关闭状态，默认不解密、不签发任何叶子证书；只在你手动开启对应厂商开关后才拦截其官方额度接口。
- **账号池 / 指定账号自由切换**：在控制页自由勾选参与汇总的 Magpie 账号——既可展示整个多账号池的真实剩余额度，也可只勾选某几个或单个指定账号展示。
- **原生串联原有代理（HTTP / HTTPS / SOCKS5）**：绝不改动系统代理或 `/etc/hosts`；默认直连（兼容路由器透明代理与 Clash TUN），若客户端只能填一个代理地址，可把原有代理直接填进首页「上游代理」串联透传，不丢失原有网络配置。
- **零第三方依赖与高安全隔离**：纯 ES Modules + Node/Bun 内置 API + 系统 `openssl`；仅监听 `127.0.0.1`，拒绝环回目标防 SSRF/自环，命中额度接口时立即丢弃客户端原始 `Authorization` / `Cookie`，绝不记录 Token 或请求体。

---

## 解决什么问题？

当你用 **Magpie** 托管了多个订阅账号（例如多个 Claude Pro、Codex、Gemini / Antigravity 或 Grok 账号）并通过 Magpie 网关做多账号分流时：

- **痛点**：**Orca**、状态栏额度工具、CLI 等客户端自带的额度条仍直接请求厂商官方的单号查询接口，因此只能显示某一个单号的剩余额度，**看不到 Magpie 账号池的真实总剩余额度，也无法切换展示你在 Magpie 里指定的账号额度**。
- **接入本插件后**：将客户端代理指向本插件（`http://127.0.0.1:3479` 或 `/proxy.pac`），客户端原生额度条即可直接显示 Magpie 账号池汇总额度或你指定的账号额度（如 Orca 左下角原生额度条与 Orca 手机端都会自动同步生效），同时对话流量与其他域名访问完全不受影响。

---

## 安装方式

### 在 Magpie 中安装（推荐）

打开 Magpie → **Plugins（插件）** 添加，或执行：

```sh
magpie plugin add github:uiuing/magpie-quota-proxy
```

启用后，Magpie 左侧栏会出现 **「额度代理」**（Quota Proxy）控制页，并随 Magpie 自动启停（默认监听 `http://127.0.0.1:3479`）。

### 独立命令行运行（可选）

```sh
bun serve.mjs
# 或
node serve.mjs
```

支持环境变量：`PORT`、`MAGPIE_ADDR` / `MAGPIE_URL`、`MAGPIE_API_KEY`、`UPSTREAM_PROXY`、`NO_PROXY`、`REFRESH_MODE`（`kept` / `live`）、`MAGPIE_QUOTA_PROXY_DIR`。

---

## 快速接入（以 Orca 等客户端为例）

1. **信任本机私有 CA**
   - 打开 Magpie 左侧栏 **「额度代理」** → 展开「本机 CA」，复制对应系统的一键信任命令执行后点「检测」，通过后 CA 卡片会自动收起。
2. **开启需要的厂商并选择账号**
   - 所有规则默认关闭，按需打开 Claude / Codex / Gemini CLI / Antigravity / Grok 开关。
   - 展开厂商卡片下的「账号」列表，勾选要展示的账号（全选即展示 **Magpie 账号池汇总额度**，单选/多选即展示 **指定账号额度**），卡片上的进度条与客户端实际收到的额度数据 100% 一致。
3. **在客户端填入代理地址**
   - **Orca**：打开 `Settings → Advanced → Network`，将 HTTP Proxy 设为 `http://127.0.0.1:3479`；稍等自动刷新（或重新打开）即可在左下角及 Orca Mobile 看到替换后的 Magpie 额度。
   - **其他支持代理 / PAC 的桌面端、菜单栏工具或 CLI**：设置 HTTP/HTTPS 代理为 `http://127.0.0.1:3479`，或将 PAC 地址设为 `http://127.0.0.1:3479/proxy.pac`（PAC 仅把已开启的额度域名导向本插件，其余全部 `DIRECT`）。
4. **保留原有代理（可选）**
   - 若客户端此前已配置了其他端口代理（例如 `http://127.0.0.1:7890` 或 `socks5://127.0.0.1:7891`），直接将该地址填入控制页首页的 **「上游代理」** 保存，即可实现 `客户端 → 本插件 → 原有代理` 无缝串联。

> **注意**：作为 Magpie 插件运行时，本地代理随 Magpie 启停。如果客户端固定填写了 `http://127.0.0.1:3479`，彻底退出 Magpie 会导致该代理端口关闭、客户端无法联网——建议平时让 Magpie 保持后台常驻（仅关闭窗口不退出），或通过 `serve.mjs` 独立常驻运行（Magpie 离线时会自动透传回真实上游）；若临时不使用 Magpie，清空客户端代理地址即可恢复直连。

---

## 支持的厂商与接口

| 厂商 | 域名 | 精准拦截路径 | 免 CA 直连端点（可选） |
| --- | --- | --- | --- |
| **Claude** | `api.anthropic.com` | `GET /api/oauth/usage` | `GET /direct/claude/api/oauth/usage` |
| **Codex (ChatGPT)** | `chatgpt.com` | `GET /backend-api/wham/usage` | `GET /direct/codex/backend-api/wham/usage` |
| **Gemini CLI** | `cloudcode-pa.googleapis.com`（及 `daily-cloudcode-pa*.googleapis.com`） | `POST .../v1internal:retrieveUserQuota` | `POST /direct/gemini/v1internal:retrieveUserQuota` |
| **Antigravity** | `daily-cloudcode-pa.googleapis.com`（及 `cloudcode-pa.googleapis.com`） | `POST .../v1internal:retrieveUserQuotaSummary` | `POST /direct/antigravity/v1internal:retrieveUserQuotaSummary` |
| **Grok** | `cli-chat-proxy.grok.com` | `GET /v1/billing` | `GET /direct/grok/v1/billing` |

> 同域名下的对话、流式 SSE、登录初始化等其他路径全部原样透传；若某厂商在 Magpie 中暂无可用账号，默认自动透传给真实上游，不影响原有功能。

---

## 核心特性

1. **严谨的多账号池化与防跳变策略**
   - 自动排除 Magpie 中已停用（`on: false`）与未勾选账号、剔除过期缓存窗口；当账号 7d 额度耗尽时自动阻塞同账号 5h 可用额且不污染 5h 重置时间；支持重置波次聚类与最晚 / 最早 / 平均重置时间策略。
   - 透传 Claude 非 `/usage` 响应时，默认剥离单账号 `anthropic-ratelimit-unified-*` 响应头，避免客户端在对话过程中被单号限流头把池化总额度覆盖刷回去造成数字跳变（可在高级设置中开关）。

2. **两种刷新策略（`kept` / `live`）**
   - **缓存模式（`kept`，默认推荐）**：读取 Magpie `/v1/magpie/quotas?kept=1` 并做 2 秒并发去重，响应 `<20ms`、零额外官方限流风险。
   - **实时模式（`live`）**：30 秒冷却 TTL + 8 秒软超时自动回退缓存，永不卡死客户端额度查询。

3. **极简多语言控制页 + 在线热切换端口**
   - 支持简体中文 / 繁體中文 / English 与深浅色主题跟随；支持在高级设置中在线切换监听端口并自动同步 `plugins.json`。
   - 内置纯内存滚动活动记录（固定上限 20 条自动淘汰，不写磁盘，支持一键清空）。

4. **全协议上游串联与凭据保护**
   - 原生零依赖支持 `http://`、`https://`、`socks5://`、`socks5h://`（含 RFC 1928 IPv4/IPv6/域名目标与 RFC 1929 账密认证），配置接口与前端自动脱敏凭据并支持一键清除认证，自动拦截指向自身端口的环回死循环。

---

## 本地测试

```sh
bun test
# 或
node --test --test-timeout=20000
```

## License

MIT
