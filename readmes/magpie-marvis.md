# 腾讯 Marvis · magpie 供应商插件

> 非官方插件。Marvis 是腾讯的产品，本插件只是把它自己的模型网关接到 magpie 上，
> 与腾讯无关。边界见下方「已知边界」。

把**腾讯 Marvis**（应用宝 AI 助手）背后的模型接进 [magpie](https://usemagpie.ai) /
OpenCode —— 不用 API key，用你的 **QQ 或微信** 登录。



## 它能给你什么

| | |
|---|---|
| **模型** | DeepSeek V4.1 Flash、DeepSeek V4 Pro、DeepSeek V4 Flash、Hy3、Claude Sonnet 4.6、Claude Opus 4.6、GPT-5.4、HY-Vision 2.0 instruct —— 共 8 个模型 |
| **额度** | 一个号每天 1000 万**计费** token（缓存免费 + 输入输出五折，实际能跑 2000 万～5000 万+） |
| **流式** | ✅ SSE 逐 token |
| **思考** | ✅ `reasoning_content` 可见 |
| **工具调用** | ✅ 完整 function calling |
| **系统提示词** | ✅ 完全可替换（`messages[0]`） |

## 计费 / 额度

Marvis 免费账号 **一个号每天 1000 万计费 token**（`total_tokens`）。

**计费公式**：

```
计费 token = 缓存读取（cache_read）× 0
           + （输入 + 输出）× 0.5
```

- **缓存命中完全免费** —— `prompt_tokens_details.cached_tokens` 那部分 × 0，一个 token 都不扣
- **输入、输出都打五折** —— 实际跑 2 个 token，才扣 1 个计费 token
- 「输入」指**未命中缓存**的输入；命中缓存的部分已经乘 0，不会重复算

⚠ **1000 万是「计费 token」，不是「你能用的 token」** —— 实际可用量远不止这个数。
一次 10,000 token 的对话，按缓存命中算下来只扣 2,000：

| 一次对话 | 实际 token | 计费 token |
|---|---:|---:|
| 缓存命中 | 6,000 | 0 |
| 新输入 | 2,000 | 1,000 |
| 输出 | 2,000 | 1,000 |
| **合计** | **10,000** | **2,000** |

**实际 : 计费 = 5 : 1** —— 1000 万计费额度 **≈ 5000 万实际 token**；
缓存命中越多，实际能跑得越多（全无缓存也还有 2 : 1，即 2000 万）。

卡片上的数字来自 `POST /v3/marvis_get_wallet`，四个字段：

| 字段 | 含义 | 典型值 |
|---|---|---|
| `total_tokens` | 总额度（**计费** token） | `10,000,000` |
| `used_tokens` | 已用（**计费** token） | `6,432,691` |
| `avail_tokens` | 可用（上游直接给；拿不到时按 `total - used` 兜底） | `3,567,309` |
| `frozen_tokens` | 冻结中（并发请求预扣，结算后释放） | `0` |

⚠ **卡片刻度条上的百分比看的是 `used_tokens / total_tokens`**（magpie 的 `usage.used`
语义就是「用了多少」），所以数字越大表示**用得越多**。想核对真实剩余，看卡片文本里的
`X 可用 / 共 Y` 更准。

额度耗尽后上游回 **403**，magpie 会按路由策略切到别的账号 —— 不是封号，
换个账号或等额度刷新即可。

## 装

```bash
magpie plugin add MYCF711/magpie-marvis
```

装完在 magpie 设置里 **供应商 → 添加 → 腾讯 Marvis**，选登录方式：

- **QQ 登录** / **微信登录**：自动打开一个隔离浏览器窗口，授权完窗口自己关掉，不用复制任何东西
- **从本机 Marvis 导入**：装了 Marvis 客户端并且登录过的话，一条命令读出来

## 设备指纹（不需要任何二进制）

请求头 `Ual-Access-MarvisExt` 里要带一个 **uskey**（设备指纹）和一个 `qimei36`。
这两个值由插件在本地生成，**不需要安装 Marvis 客户端，也不需要任何 DLL**。

早期版本曾经打包过 4 个 Windows 二进制来调用官方 SDK 现签，现在不再需要：
没有 `native/` 目录时插件会本地生成同样格式的值，功能完全一致。

> `native/` 仍然是**可选**的：如果你把 4 个文件放进插件目录，插件会优先用它们。
> 这 4 个文件是平台相关的二进制，不随本仓库分发。

## 一个 uskey 只能用两次

上游对 uskey 有配额：**同一个 uskey 第 3 次请求起 403**（等 75 秒仍 403，是配额不是频率）。
所以插件**每次请求都现签一个**（`getUskey()` 是本地调用，毫秒级，不联网）。

## 已知边界

- **非官方**：Marvis 随时可能改协议。改了就提 issue。
- **登录态 30 天**：`refresh` 会**成对轮换** token，旧的立刻失效。插件已经串行化了刷新
  （同账号同时只允许一次），但如果你在 Marvis 客户端里也登录同一个号，两边会互相打掉。
- **跨平台**：不需要任何 Windows 二进制，「从本机 Marvis 导入」这条登录路仅在 Windows 可用。
- **`/v1/chat/completions` 不需要 UAL 签名**：那是 `/v3/*` 业务接口的事。把签名头加到模型
  网关上会从 `403 风控` 变成 `401 登录态过期`。

## 开发

```bash
node scripts/check.mjs      # 合规检查（退出码非 0 就是不合规）
node --test                 # 语义测试
node tests/e2e-live.mjs     # 真实网关端到端（需要有效登录态）
```

## 许可

MIT。详见 [LICENSE](./LICENSE)，归属说明见 [NOTICE.md](./NOTICE.md)。
