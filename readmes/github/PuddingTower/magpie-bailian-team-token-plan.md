# magpie-bailian-team-token-plan

**阿里云百炼 Token Plan 团队版（Team / Enterprise Edition）专用 [Magpie](https://usemagpie.ai) 插件**：  
免控制台登录、免手机短信验证码，在 Magpie 中同时完成 **动态全量模型清单拉取**、**Token Plan 团队版模型推理** 与 **实时 Credits 额度监控**。

> **为什么需要这个插件？**
> - Magpie 内置百炼读取器面向个人版控制台网关；团队版/企业版账号会直接报错 `BailianGateway.Team.NotAuthorised`。
> - 网页端访问企业/团队订阅页（`bailian.console.aliyun.com/.../token-plan/enterprise`）每次都要 RAM 账号登录并接收手机短信验证码。
> - 本插件走阿里云百炼官方 OpenAPI `GetSubscriptionStats`（RAM AccessKey `ACS3-HMAC-SHA256` 签名），**零浏览器、零验证码**拉取团队席位总 Credits、剩余 Credits、刷新时间与订阅到期日；同时通过 `/compatible-mode/v1/models` **自动同步你的百炼 Token Plan 实时全量模型清单**（`glm-5.3`、`deepseek-v4.1-flash-1017`、`qwen4-max`、`qwen3.8-max`、`kimi-k2.7-code` 等全部可选），推理链路继续使用你的 `sk-sp-` Token Plan API Key。

## 功能特性

- **动态全量模型清单**：登录后自动请求 `GET /compatible-mode/v1/models` 同步账号可用全部模型（并在离线/异常时自动回退内置全量表 + `magpie.fellBack` 保底），不再漏掉 `glm-5.3`、`deepseek-v4.1-flash-1017` 等模型，支持 `magpie sync` 即时刷新与多选启用。
- **团队版专享额度查询**：展示各档位席位（如 `max 席位 ×1`）的剩余 Credits、已用百分比、周期刷新时间与到期时间。
- **免验证码 / 免管理员控制台授权**：仅需给自己的 RAM 子账号授予只读策略 `AliyunTokenPlanReadOnlyAccess` 并创建 AccessKey。
- **推理与额度一体化**：同一供应商内同时提供 `sk-sp-` 模型调用与 OpenAPI 额度读取，让网关路由能感知团队剩余额度。
- **零第三方依赖**：纯标准 Web Crypto（`crypto.subtle`）+ `fetch` 实现 ACS3-HMAC-SHA256 签名，兼容 Bun 与 Node.js >= 20。

## 前置准备（阿里云 RAM 控制台）

1. 在阿里云 RAM 控制台为你的 RAM 用户授予系统策略：`AliyunTokenPlanReadOnlyAccess`（只读权限，最小权限原则）。
2. 为该 RAM 用户创建一组 `AccessKey ID` / `AccessKey Secret`。
3. 准备好你在百炼 Token Plan 团队版取得的 `sk-sp-...` API Key。

## 安装与配置

### 1. 安装插件

```bash
magpie plugin add github:PuddingTower/magpie-bailian-team-token-plan
```

### 2. 配置 RAM AccessKey（用于免验证码查团队额度）

```bash
magpie plugin options github:PuddingTower/magpie-bailian-team-token-plan '{"accessKeyId":"LTAI...","accessKeySecret":"..."}'
```

> 也可在 Magpie 桌面端插件设置（Plugin options）界面直接填入 `accessKeyId` / `accessKeySecret`，或通过环境变量 `ALIBABA_CLOUD_ACCESS_KEY_ID` / `ALIBABA_CLOUD_ACCESS_KEY_SECRET` 提供。

### 3. 登录 Token Plan API Key（用于拉取模型清单与推理）

```bash
magpie plugin login bailian-token-plan
# 按提示粘贴你的 sk-sp-... Key
```

> **关于供应商 ID**：由于 `bailian-token-plan` 与 Magpie 内置预设重名，Magpie 会自动将插件注册的供应商命名为 `bailian-token-plan-plugin`。若你此前配置过内置 `bailian-token-plan` 且不想同时出现两个百炼条目（其中内置条目仍会报 `Team.NotAuthorised`），可先备份你的 `sk-sp-` Key，再执行 `magpie provider rm bailian-token-plan` 移除内置条目，并将下游 Agent（如 Kilo / OpenCode / Qoder 等）切换至 `bailian-token-plan-plugin/<model>`。

## 验证与刷新模型清单

```bash
# 立即同步账号可用模型清单（例如新增的 qwen4 / glm-5.3 / deepseek-v4.1 等）
magpie sync

# 查看团队版实时剩余额度（免验证码）
magpie quota bailian-token-plan-plugin

# 查看可用模型列表
magpie models | grep bailian-token-plan-plugin
```

输出示例：

```text
bailian-token-plan-plugin · Token Plan Team · renews Dec 13 · RAM AK · 团队订阅 (API key …xxxx)  subscription  max 席位 ×1 5% (236,574 / 250,000 credits 剩余)
```

## 插件 Options 说明

| 字段 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `accessKeyId` | 是（或环境变量） | — | 具备 `AliyunTokenPlanReadOnlyAccess` 权限的 RAM AccessKey ID |
| `accessKeySecret` | 是（或环境变量） | — | 对应的 RAM AccessKey Secret |
| `label` | 否 | `RAM AK · 团队订阅` | Magpie 用量卡片上显示的账户标识 |
| `baseURL` | 否 | `https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1` | 百炼 Token Plan OpenAI 兼容端点 |
| `host` | 否 | `modelstudio.cn-beijing.aliyuncs.com` | 百炼 OpenAPI 接入域名 |

## 本地开发与测试

```bash
npm test
```

## 安全提示

- 请勿将 `AccessKey` 或 `sk-sp-` API Key 提交到 Git 仓库。
- 建议仅向查询用 RAM 子账号授予只读策略 `AliyunTokenPlanReadOnlyAccess`，不要使用主账号或 `AdministratorAccess` 的 AK/SK。

## License

[MIT](LICENSE)
