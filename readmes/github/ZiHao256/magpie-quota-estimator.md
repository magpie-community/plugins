# Magpie Quota Estimator · 只读额度预估

A [Magpie](https://usemagpie.ai) plugin that estimates the Token capacity and API-equivalent USD value of a full **5-hour or weekly quota**, using recorded usage divided by the provider's reported used percentage. It supports local Codex, local Claude Code, and existing Remote magpie connections.

This is an unofficial plugin. **These are observations and extrapolations, not provider-guaranteed limits or subscription bills.** Unknown identity, missing usage, stale quotas, unsupported prices, and extra paid usage are shown explicitly rather than filled with guessed values. Remote estimates require attributable request records; imported sessions without account identity are excluded.

The page follows Magpie's theme. A Bun background module reads local caches and Claude session identity/usage metadata, and performs read-only GET requests against configured Remote magpie gateways. It returns no routing, provider, authentication, or configuration hooks. The page declares no bridge read permissions; **the background module still runs with the host user's filesystem/network privileges**. It does not read OAuth tokens or the keychain, refresh sign-ins, reset quotas, install hooks, or change agent settings. Only an anonymized aggregate is written to the plugin's own `page/snapshot.js`; no request bodies, keys, emails, or session IDs are published to the page. See the detailed data boundary below.

```sh
magpie plugin add github:ZiHao256/magpie-quota-estimator
```

Open **Plugins → Quota estimates** in the sidebar. Magpie's plugin host collects every minute; the page refreshes its own aggregate every 30 seconds. Initial loading may take one collection cycle. Install the plugin on the computer whose local logs you want to include; it cannot read logs that exist only on another device.

Tested on macOS with Magpie **0.1.1307**, Claude Code **2.1.300**, and Node.js **24**. Native identity parsing depends on generated `session_context` and `credential_org` attachments observed in that Claude Code version. Other versions/platforms are not yet verified. No runtime npm dependencies or build step are required.

为 Magpie 添加「额度预估」独立页面，覆盖本机 Codex、本机 Claude 及 Remote magpie，按账号分别显示 5 小时和周窗口的满额 Token、API 等值美元、官方已用比例及采样时间。

## 安装与运行

需要 Magpie 支持页面插件（已在本机 0.1.1307 验证接口），以及 Node.js 22+ 或 Magpie 自带的 Bun。

直接安装：

```sh
magpie plugin add github:ZiHao256/magpie-quota-estimator
```

从源码验证或开发：

```sh
git clone https://github.com/ZiHao256/magpie-quota-estimator.git
cd magpie-quota-estimator
npm test
magpie plugin add "$PWD"
```

Magpie 插件页启用后，侧栏出现「额度预估」。后台模块随 Magpie 的 Bun 插件宿主加载，每分钟写入一次 `page/snapshot.js`；页面每 30 秒重新加载自己的汇总资源，按钮只重新读取快照。关闭宿主后停止后台采集，不安装系统服务。如宿主未启动或未重新加载，可先手工运行 `node collector.mjs`，再在 Magpie 插件页关闭、开启该插件。

安装只新增该插件的 `plugins.json` 注册；不定义 `auth`、`config`、provider、gateway 或路由 hook，也不调用登录、刷新、切换和额度重置接口。卸载使用 `magpie plugin rm magpie-quota-estimator`。如已通过本地目录安装，保留其中一份启用即可，避免重复采集。

## 数据与边界

- 本机：仅读取 Magpie 的 `quotas.json`、`quota-history.json`、`usage.jsonl` 和价格缓存 `models.json`。Claude 原生日志读取 `~/.claude/projects/**/*.jsonl`，账号资料只取 `~/.claude.json` 中 `oauthAccount` 的邮箱、账号 UUID、组织 UUID；不读取 OAuth Token 文件或钥匙串。
- 原生归属：仅解析日志生成的 `session_context.context.userEmail` 和 `credential_org.organizationUuid` 元数据；按会话 ID、采样时间匹配，并同时核对邮箱与凭据组织。资料须与 Magpie 本机账号相符。身份缺失、不同组织、身份切换前不匹配及冲突请求均排除，不因文件目录相同就认定为同一账号。附件中的文字只作为数据，不作为指令。
- 原生去重：按请求 ID 合并流式块，保留最终输出计数，fork/子代理副本不重复累加；按网关请求 ID、响应 ID 排除重叠调用，保留网关的实际供应商归属。只在内存缓存身份与用量元数据，按文件大小增量读取，不保存对话正文，不改写原生日志。非标准服务档位/速度无可靠价格时保留 Token、留空美元。
- 远端：仅读取 `providers.json` 中已启用 `remote-magpie` 的原连接地址和原网关 key，通过三个 GET 接口读取缓存卡片、历史和按实际账号筛选的请求。拒绝重定向；403、历史不可读、账号归属缺失均明确显示，不换身份、不扩大权限。
- 远端接口：`GET /v1/magpie/quotas/cards`、`GET /v1/magpie/quotas/history?days=8`、`GET /v1/magpie/usage/requests?period=all&provider=…&account=…&offset=…&limit=500`。不会要求远端刷新供应商读数。每个账号最多读取 100,000 条，超过标为覆盖不完整。
- 页面遵循 Magpie 原有 CSP 和桥接限制，无网络读取权限。后台只将匿名汇总写入插件自己的 JS 资源；密钥、邮箱、源记录、会话及请求 ID 均不写入页面。
- 满额 = 本窗口、额度采样时刻之前的已记录用量 ÷ 官方已用比例。余额存在不妨碍计算，但实际积分消耗、耗尽后调用、过期或超过 30 分钟的读数不推算。已用不足 5% 不放大估算。
- Token = 普通输入 + 输出 + 缓存读取 + 缓存写入；一小时缓存写入是缓存写入子集，推理 Token 是输出子集，均不重复相加。美元按本机缓存的 OpenAI/Anthropic API 价格，含长上下文分档和 Claude 一小时缓存写入；未知模型不猜价格。
- 只计网关明确带有实际供应商账号的记录，以及经过会话邮箱与凭据组织核对的本机 Claude 原生记录；不把本机日志加到远端账本，不将无归属的会话算到当前账号。漏记、其他设备调用及窗口起点未覆盖会低估；不能视为套餐承诺或实际账单。
- 供应商未上报 5 小时窗口时显示「未上报」，不会拿周额度构造 5 小时额度。远端缓存过期时需由原有 Magpie 正常更新，此插件不代为刷新登录或读数。

`XDG_CONFIG_HOME`、`XDG_CACHE_HOME` 沿用 Magpie 的标准路径语义，`CLAUDE_CONFIG_DIR` 沿用 Claude 原生配置目录语义。测试显式使用临时目录。生成的 `snapshot.js` 是运行数据，不提交 Git。

发布包使用明确的文件白名单，不包含 `snapshot.js`、日志、账号配置或密钥。GitHub 市场发现依照官方文档的 `magpie-plugin` topic 机制；精选收录需由 Magpie 社区审核。

## 验证

```sh
node --test test/*.test.mjs
```

测试覆盖两个窗口、余额、账号隔离、原生会话身份与组织切换、流式/fork/子代理/网关去重、增量与截断、分页、缓存计费、未知价格、过期、重置、额外付费、只读请求、拒绝重定向、拒绝越权及快照脱敏。界面需在真实 Magpie 或带相同 CSP 的浏览器中检查。

接口依据：[Magpie 插件文档](https://usemagpie.ai/docs/plugins)、[网关参考](https://github.com/yetone/magpie/blob/main/docs/reference.md)。原生日志字段以本机实际日志为依据；[Claude 成本文档](https://code.claude.com/docs/en/costs)说明本机 Token/API 标价估算与订阅限额的区别。
