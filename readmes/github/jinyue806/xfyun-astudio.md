# xfyun-astudio

把 **AStudio（科大讯飞 Astron Studio 桌面端）** 的账号额度接入 [magpie](https://usemagpie.ai/) 与 [OpenCode](https://opencode.ai/)：复用桌面端登录态，直连云端模型网关（OpenAI Responses 协议），agent 以 `astudio/<model>` 使用它的模型；支持每日登录积分自动签到与积分余额显示。

## 登录什么

两种方式（登录时二选一）：

1. **读取 AStudio 桌面端登录态（推荐）**——本机装有 AStudio 桌面版并登录过即可，插件自动从它的数据目录读出模型凭据与网页会话（积分/签到用），不用填任何东西。没装/没登录时这一步会给出 [AStudio 官网](https://agent.xfyun.cn/) 链接并自动等待：装好登录后自动完成，不用回来点按钮。本机已有数据但读不出来（会话不是有效 JSON、没有凭据、账号被封禁）会直接说明原因，登录/修好后同样自动完成。数据目录按以下顺序查找：
   - `ASTUDIO_HOME`（或 `SYNARA_HOME`）环境变量指定的目录；
   - Windows 注册表 `HKCU\Software\AStudioStorage` 的 `Production/Canary/DevelopmentDataRoot`；
   - 兜底 `~/.acode/acode/`。
   - 目标文件：`<数据根>/userdata/astron-session.json`（其次 `<数据根>/runtime/acode-home/config.toml`，该方式无网页会话，积分/签到不可用）。
2. **粘贴 modelBearerToken**——从 `astron-session.json` 的 `modelBearerToken`（或 `config.toml` 的 `experimental_bearer_token`）复制粘贴；可选填 uid 与网页会话 `token`（补全积分/签到能力）。

每个 AStudio 账号登录一次即得一个 magpie 账号，可多账号故障切换。凭据保存在 magpie 的 `plugin-auth.json`（权限 600），不上传。

## 模型

供应商 id `astudio`。目录**按账号实时拉取**（`GET /api/v1/model-manager/models`，读取不计费），含思考档位与限免标记。2026-11 实测目录：

| modelId | 名称 | context | 备注 |
| --- | --- | --- | --- |
| `astronclaw-auto` | Auto | 256k | 智能路由 |
| `spark-x2.6` | Spark-X2.6 | 256k | 抢先体验 |
| `spark-x2.6-4b` | Spark-X2.6-Lite | 1M | **限免** |
| `spark-x2.5` | Spark-X2.5 | 256k | |
| `xopglm52` | GLM-5.2 | 1M | |
| `xopdeepseekv4pro0813` | DeepSeek-V4-Pro | 1M | |
| `xopdsv4flash0731in` | DeepSeek-V4-Flash | 1M | |

思考档位（none / high / max，随模型）映射为 magpie 的推理档位；上游字段变化以实时目录为准。

## 每日签到（每日登录积分）

AStudio 有「每日登录积分」：服务端在当天账号会话首次活跃时发放（体验版 100 分/天，标准版 200，高级/畅享 400；活动期 31 天有效），客户端弹窗只做通知、没有领取接口。插件为此提供 magpie 的 `auth.checkin`：每天替账号做一次会话活跃（只读请求，带桌面端 `clientType` 身份头），再观测前后余额差与 `client-popups/pending` 的每日奖励待通知弹窗——涨了记为已领取，见到弹窗记为今日已发放，两者都没有则记为「未观测到新发放」，不谎称已签到。发放由服务端按账号会话判定；插件不能代替桌面端登录，也不保证某天一定有积分到账。签到需要账号带网页会话（桌面端登录态方式默认有）。

## 用量

有网页会话时显示真实数据：会员档（体验版/标准版/高级版/畅享版）、通用积分余额（含最近到期批次与时间）、星火积分余额。所有读取均不计费；模型调用本身才消耗账号额度。401/403/登录异常会把账号标记为需要重新登录。

## 协议与上游

- 模型调用：`POST https://astronstudio-api-volces-prod.xf-yun.com/model-gateway/v1/responses`（OpenAI Responses，`Authorization: Bearer`）——与 AStudio 桌面端写进 acode 内核的 `base_url` / `wire_api` 完全一致。
- 模型目录：`GET https://astronstudio-api-volces-prod.xf-yun.com/api/v1/model-manager/models`。
- 账号面：`https://agent.xfyun.cn/xingchen-studio/`（`points/balance`、`membership/me`、`membership/plan-config`，Cookie 会话鉴权）。

## 风险提示

非官方集成，凭据与协议来自桌面客户端逆向，上游随时可能变更；共享登录态的自动化使用可能违反 AStudio 服务条款，账号风险自担。请勿用于批量/滥用场景。

## 安装与开发

```
magpie plugin add ./xfyun-astudio   # 文件夹就地加载
magpie plugin login astudio                 # 选「读取 AStudio 桌面端登录态」
magpie provider test astudio spark-x2.6-4b  # 限免模型，验收一发
```

测试（零依赖，Node ≥18 或 Bun）：

```
npm test          # = node --test
# 或 bun test
```
