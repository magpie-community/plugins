# opencode-meoo-auth

OpenCode & Magpie provider plugin for **Meoo 秒悟**（`meoo.com`）。npm 包名 `@fish-under-sea/opencode-meoo-auth`。

在 Magpie 的插件界面里，名字是两层：**外层短名 `Meoo`**（「已安装」那一行、插件卡片的标题、供应商卡片），**点进插件详情**看到的是 `npm · @fish-under-sea/opencode-meoo-auth`（npm 发布者 + 完整包名）。这与官方插件（卡片上 `magpie 社区 · @magpie-community/…`）同一套呈现：短名由 `package.json` 的 `magpie.name` 给出（社区列表没收录时生效），详情里的包名由宿主读到的插件 spec 给出。

```json
"magpie": {
  "name": "Meoo",
  "summary": {
    "zh": "用自己的 Meoo 秒悟账号使用 Meoo 网关上的模型——浏览器 PKCE 授权、复用本机登录态或项目服务 AK，模型目录实时同步。",
    "en": "Meoo 秒悟 (meoo.com) in magpie: sign in with your own Meoo account and its gateway's models show up as one provider, with usage-billed tokens."
  }
}
```

`magpie.name` 最多 80 字节、必须单行、不能含控制或双向格式字符，否则整条忽略（回落成包名）；`summary` 按语言给一句，最多 300 字节。

作者：[@Fish-under-sea](https://github.com/Fish-under-sea)、[Chensy（elysia395）](https://github.com/elysia395)。本包由 [FISH-DOCK-Plugins PR #35](https://github.com/Fish-under-sea/FISH-DOCK-Plugins/pull/35) 的 Magpie 供应商插件落成独立 npm 包；代码源头是 [dsh-meoo-connect](https://github.com/2239058652/dsh-meoo-connect)（DeepSeek Harness 的 dsh 插件）：同一套 Meoo 官方「AI 服务」链路（OAuth 登录 → 项目服务 AK → OpenAI 兼容网关），换到 Magpie / OpenCode 的 provider 插件平面上。装好并登录后，Meoo 的模型会出现在 Magpie 的模型选择器里，也作为 OpenCode 的一个 provider。

## 模型与上下文

网关 `/models` 只回裸 id，不带上下文与输出上限，所以规格由包里那张表给出（数字取自各家官方文档，2026-11 核对）：

| 模型 | 传参值 | 上下文 | 最大输出 | 图片 |
| --- | --- | --- | --- | --- |
| Qwen3.8-Flash | `qwen3.8-flash` | 1M | 131072 | ✓ |
| Qwen3.8-Max | `qwen3.8-max` | 1M | 131072 | ✓ |
| Qwen3.7-Max | `qwen3.7-max` | 1M | 131072 | |
| Qwen3.7-Plus | `qwen3.7-plus` | 1M | 131072 | ✓ |
| DeepSeek V4.1 Flash | `deepseek-v4.1-flash-1017` | 1M | 384K | ✓ |
| DeepSeek V4 Pro | `deepseek-v4-pro-0813` | 1M | 384K | |
| DeepSeek V4 Flash | `deepseek-v4-flash-0731` | 1M | 384K | |
| GLM-5.2-Fast | `glm-5.2-fast-preview` | 1M | 128K | |
| GLM-5.2 | `glm-5.2` | 1M | 128K | |
| Qwen VL（视觉理解） | `qwen3-vl-plus` | 262144 | 32768 | ✓ |

两点和别家插件不一样，值得知道：

- **`qwen3-vl-plus` 不在网关 `/models` 里**，但 Meoo 文档给了、网关也接（实测可调）。插件拉目录时会用一次 1-token 的探针试它，接了就补进目录，否则不提——不写死一个调不通的模型。
- **目录里出现表外的新模型**按保守值给（200K 上下文 / 64K 输出、纯文本），不会把 1M 随手许出去；要正式支持就把它加进 `MODEL_SPECS`。

### 为什么 Kimi K3 / GLM-5.3 / MiniMax 没出现

Meoo 文档的「支持模型介绍」把 Kimi K3、Kimi K3.1 Pro、GLM-5.3、GLM-5.3-Flash、MiniMax M3.1 Flash、Qwen3.8-Max-0902 都算作平台模型，但**项目的 OpenAI 兼容网关只收这 9 个文本 id**（2026-11 实测，其余一律 400）：

```
当前仅支持配置模型: qwen3.8-flash、qwen3.8-max、qwen3.7-max、qwen3.7-plus、
deepseek-v4.1-flash-1017、deepseek-v4-pro-0813、deepseek-v4-flash-0731、
glm-5.2-fast-preview、glm-5.2
```

Kimi / GLM-5.3 / MiniMax 在 Meoo 的 **Agent 产品**里（`/open/v1/projects/<id>/agent/runs`，SSE 协议，不是 OpenAI 兼容），想用它们装 [`magpie-plugin-meoo-agent`](https://github.com/RexVane/magpie-plugin-meoo-agent)。两个插件可以并存：`meoo` 与 `meoo-agent` 是两个 provider id，不抢同名 key。

插件仍然会把上面这些候选逐个探一遍（并发 4 条、1 token、结果随目录缓存 10 分钟）：**Meoo 哪天在网关放开哪个，下次拉目录就自动出现**，不用等发版。

### 自己加模型

网关接了但目录没列、插件也不认识的 id，用环境变量塞进去（仍然要过那一探，不接的不进目录）：

```bash
MEOO_EXTRA_MODELS=my-model-a,my-model-b
```

未知 id 一律按 200K / 64K、纯文本处理；想给它正确的上下文，就往 `MODEL_SPECS` 里加一条。

## 余额

浏览器授权登录后，供应商卡片会带一张积分卡（控制面 `/open/v1/cli-compat/account/points`）：

```
Fishundersea · 58,847 积分 · 2026-11-10 到期
已用 2,153 积分
```

按 magpie 的**预付费钱包**窗口给出：窗口只有 `balance` + `unit`、不写 `used`/`limit`，所以卡片显示数字而不是百分比条；`runsOutAt` 是最近一批还没用完的积分的到期日。手填项目服务 AK 的登录读不到积分账户，卡片会说明要用浏览器授权。

## 思考强度

模型默认带三档思考强度，对应会话 UI 里的 **快速 / 适中 / 极致**（`reasoning_effort: low / medium / high`）。网关实测该参数真实生效（low 档思考 tokens 约为 high 档的 60%~70%，`enable_thinking:false` 可完全关闭，但为避免不可控行为未暴露「关闭」档）。不选档位时走上游默认思考。

## 它是怎么做的

不自己做 LLM 适配器、不加会掉流式的中间代理——插件只准备「凭证 + 模型目录」，
真正的转发交给宿主的 `@ai-sdk/openai-compatible` SDK 直连 Meoo 网关：

```
opencode-meoo-auth
  ├─ OAuth(PKCE) 登录 meoo            → access/refresh token 存宿主账号记录
  ├─ /open/v1/cli-compat/...          → 身份、项目列表、项目服务 AK（自动开通云服务）
  ├─ GET {gateway}/models             → 当前可用模型目录（10 分钟缓存）
  └─ loader                            → baseURL + apiKey(项目服务 AK) 交给宿主 SDK
                                          ↓
                        Magpie 的模型选择器 / OpenCode 的 provider 列表
```

## 登录方式（三选一）

| 方式 | 适合谁 | 要人工做什么 |
| --- | --- | --- |
| **浏览器授权**（PKCE，本机 loopback 自动收回调） | 大多数人 | 浏览器里点一次「授权」；身份、项目、云服务 AK 之后全自动 |
| **复用本机登录态** | 已在用 dsh-meoo-connect 或 meoo-proxy 的人 | 无——只读 `$DSH_HOME/meoo/state.json` 或 `~/.meoo-proxy/config.json`，不会写这两个文件 |
| **手填项目服务 AK** | 不想走 OAuth / 账号下多项目想精确指定的人 | 在 meoo.com 打开项目 → 云服务，复制 `meoo_project_service_v1.` 开头的 AK 粘贴；保存前会用网关 `/models` 校验一次 |

自动链路的细节：

- access token 过期前 5 分钟自动单飞续期（并发共享一次刷新请求），续期结果写回宿主的账号记录。
- 项目没开通「云服务」时，授权登录会自动开通一次再取 AK；仍失败会提示在 meoo.com 项目的对话框里让 AI 开启（平台的设计是会话触发自动开通，没有手动按钮）。
- 账号下一个项目都没有时，授权登录会**自动创建一个项目**（默认名「AI 服务」，可在 meoo.com 改名），再继续取 AK。
- 账号下有多个项目且没设默认时，浏览器登录会拒绝并**列出可选项**（项目间计费归属不同，不替你做主）；想精确指定就用「手填 AK」方式。
- 手填了 `meoo_ak_` 开头的用户 Key 会被明确拒绝——那是用户 Key，不是项目服务 AK。

## 安装

### Magpie

Magpie 的插件清单在数据目录的 `plugins.json`。直接用 npm spec（首次加载时按 spec 装，`@latest` 跟着版本走）：

```json
{
  "plugins": [
    { "spec": "@fish-under-sea/opencode-meoo-auth@latest" }
  ]
}
```

也可以把包解开后指向本地目录：

```json
{
  "plugins": [
    { "spec": "C:\\<magpie 数据目录>\\plugins\\opencode-meoo-auth" }
  ]
}
```

改完重启 magpie：模型来源/插件列表里会出现 **Meoo**，点进去显示 `@fish-under-sea/opencode-meoo-auth`，选一种方式登录即可。

### OpenCode

```bash
# 包在 npm 上，OpenCode 按包名加载
# opencode.json 的 plugin 里写 "plugin": ["@fish-under-sea/opencode-meoo-auth@latest"]
opencode auth login   # 选 Meoo
```

也可以把本目录放进 `~/.config/opencode/plugin/`，或在 `opencode.json` 里写本目录的绝对路径。

## 配置（可选）

环境变量（Magpie 的插件进程只透传白名单变量，这两个主要用于 OpenCode/裸跑调试）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `MEOO_MAIN_SITE_URL` | `https://meoo.com` | OAuth/控制面站点（测试环境可换） |
| `MEOO_GATEWAY_BASE_URL` | `https://api.meoo.host/meoo-ai/compatible-mode/v1` | OpenAI 兼容网关 |
| `MEOO_PROXY_HOME` | `~/.meoo-proxy` | meoo-proxy 登录态目录（复用方式） |

## 排错

| 现象 | 处理 |
| --- | --- |
| 授权页 404 / unsupported_response_type | 用插件生成的授权链接，别手拼；redirect_uri 必须是本机 loopback |
| `账号下有多个项目…` | 浏览器登录要求账号有默认项目；或改用「手填 AK」方式指定项目 |
| `项目 xxx 还没开通 Meoo AI 服务` | 云服务/AK 没有手动按钮：在 meoo.com 打开该项目，**对话框里发「帮我开启云服务」**（或让 AI 加个带后端/AI 的功能），平台自动开通并签发 AK 后重试；若带 `QUOTA_EXCEEDED（实例数已达上限）`，先释放不用的全栈项目/实例（Free 可部署 1 个全栈项目），或升级套餐 |
| `AK 被网关拒绝 (401/403)` | 填的是用户 Key 或项目没开云服务；确认是 `meoo_project_service_v1.` 开头 |
| `401（登录态已失效）` | refresh token 失效，重新登录一次 |
| 模型列表是兜底清单 | 网关 `/models` 暂时拉不到（断网/AK 失效），恢复后会自动同步 |

## 状态与凭证

- 凭证（token、AK）只存在宿主的账号记录里：Magpie 的 `plugin-auth.json`、OpenCode 的 `auth.json`。本插件自己不落地任何文件。
- 「复用本机登录态」是严格只读的，不会写 dsh-meoo-connect / meoo-proxy 的文件，也不消耗它们的 refresh token 之外的东西（续期结果只写回 Magpie 自己的记录）。
- 调用消耗 Meoo 账号自身额度，插件不绕过任何计费；与 Meoo 官方无关联，是第三方集成。

## 开发

```bash
node --check index.mjs && node --check opencode.mjs
node --test test/offline.test.mjs   # 23 项：假 fetch + 假 client，含浏览器 PKCE loopback 全流程
```

Windows 沙箱里跑测试要关掉测试隔离（沙箱禁命名管道，`spawn EPERM`）：

```powershell
node --test --test-isolation=none test/offline.test.mjs
```

## 作者与致谢

### 维护

- [Fish-under-sea](https://github.com/Fish-under-sea)：独立 npm 包化、仓库与发版，外层显示名（Meoo）与包名呈现，模型规格表与积分余额卡。

### 上游作者

- [Chensy（elysia395）](https://github.com/elysia395)：本插件的 Magpie 供应商插件形态与实现，见 [FISH-DOCK-Plugins PR #35](https://github.com/Fish-under-sea/FISH-DOCK-Plugins/pull/35)。这个 npm 包就是该 PR 里的插件本体，作者同为上游作者之一。
- [2239058652/dsh-meoo-connect](https://github.com/2239058652/dsh-meoo-connect)：Meoo OAuth(PKCE)、控制面（身份 / 项目 / 云服务 AK）、网关模型目录的原始实现。`index.mjs` 的登录与取 AK 链路由这里移植而来。
- [sangonomiya249/dsh-meoo](https://github.com/sangonomiya249/dsh-meoo)（基线 `cf77e92`）：dsh-meoo-connect 的上游，版权归其作者所有。
- [magpie-community/plugins](https://github.com/magpie-community/plugins)：`opencode2.mjs`（OpenCode 2.x 适配层）整份取自该仓库，按「每个包携带同一份字节」的约定未做修改。
- [yetone/magpie](https://github.com/yetone/magpie)：供应商插件契约（`config` / `provider.models` / `auth`）、`magpie.name` 与预付费钱包窗口的宿主实现；「外层短名 + 详情包名」的呈现由它决定。

### 资料出处

- Meoo 秒悟官方（[meoo.com](https://meoo.com) / [docs.meoo.com](https://docs.meoo.com)）：AI 服务协议、模型清单，以及本包规格表里的上下文与输出上限。本项目是第三方集成，与官方无隶属关系。

### 相关但不同的项目

- [RexVane/magpie-plugin-meoo-agent](https://github.com/RexVane/magpie-plugin-meoo-agent)：走 Meoo 的 Agent 接口（`/open/v1/projects/<id>/agent/runs`），覆盖 Kimi K3、GLM-5.3 等本插件网关调不到的模型。两者 provider id 不同（`meoo` 与 `meoo-agent`），可同时安装。

各上游的许可证与使用范围见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

## License

MIT
