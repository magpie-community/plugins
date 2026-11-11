# st-sensenova-magpie

给 [Magpie](https://usemagpie.ai) 用的 **商汤日日新（SenseNova）Token Plan** 供应商插件。

装上之后，Magpie 的模型选择器里会多出「商汤日日新」：7 个模型（6 个对话 + 1 个生图），账号行里显示控制台的积分额度。

```
$ magpie quota
sensenova  通用积分池 · 5 小时窗口  0% used ↻ 2h  ·  Flash-Lite积分池 · 5 小时窗口  22.8% used ↻ 2h
```

## 特点

- **模型清单内置**，不从接口拉取 —— 启动零请求，选择器里显示「DeepSeek V4.1 Flash」这样的真名，而不是 `deepseek-flash` 这种裸 id。
- **额度上报**到账号行、`magpie quota` 和网关的 `/v1/magpie/quotas`。
- **两套凭据分开**：模型用 API Key，额度用控制台令牌。平台没有能用 API Key 读额度的接口，所以必须分开收集；只填 API Key 也能正常用，只是不显示额度。
- **额度坏了不影响模型**：读额度失败只会在账号行显示一行提示，不会让账号被判为「登录失效」而停用。

## 安装

```bash
magpie plugin add github:xiaolietu/st-sensenova-magpie
magpie plugin login sensenova
```

登录会问三项：

| 提示 | 必填 | 说明 |
| --- | --- | --- |
| 商汤日日新用户名 | 否 | 控制台的**用户名**（不是手机号），只用于读额度 |
| 账号密码 | 否 | 明文存进 `plugin-auth.json`，只用于额度令牌续期时兜底 |
| API Key | **是** | Magpie 自己的 key 输入框，模型请求靠它 |

两项账号信息留空完全不影响模型调用；留空时插件会去读 `snquota` 命令行写在 `~/.sensenova-quota.json` 的凭据。

> 用户名那一项的字段名叫 `email`、装的是用户名 —— 这是 Magpie 的账号命名规则决定的（只认 `metadata.email`），不是笔误。

Windows 的 Git Bash / mintty 里，登录提示会报 `read /dev/stdin: The handle is invalid.`，这是宿主读标准输入的方式所致。改用管道输入（顺序：用户名 → 密码 → API Key，**末尾多给一行**）：

```bash
printf '%s\n%s\n%s\n.\n' "$ACCOUNT" "$PASSWORD" "$SENSENOVA_API_KEY" | magpie plugin login sensenova
```

## 模型

清单写在 `models.mjs` 里，模型取自官方文档的模型总览，数值取自 `GET /v1/models` 的实测快照：

| 模型 | Model ID | 上下文 | 输出上限 | 方向 |
| --- | --- | --- | --- | --- |
| SenseNova 6.8 Flash | `sensenova-6.8-flash` | 262,144 | 65,536 | 文本 + 图片输入 |
| SenseNova 6.8 Flash Lite | `sensenova-6.8-flash-lite` | 262,144 | 65,536 | 文本 + 图片输入 |
| DeepSeek V4 Flash | `deepseek-v4-flash` | 1,048,576 | 65,536 | 文本 |
| DeepSeek V4.1 Flash | `deepseek-flash` | 1,048,576 | 65,536 | 文本 |
| GLM-5.2 | `glm-5.2` | 1,048,576 | 131,072 | 文本 |
| Kimi K3 | `kimi-k3` | 1,048,576 | 65,536 | 文本 |
| SenseNova U1.5 Lite | `sensenova-u1.5-lite` | 262,144 | 65,536 | 文本 → **图片** |

**为什么不实时拉 `/v1/models`。** 它返回的是「平台在售」，不是「你的套餐能用」，而且没有任何字段能区分。实测 `deepseek-v4.1-flash` 在列表里、元数据与 `deepseek-flash` 逐项相同，但请求必定 403 —— 列出来就是让人点一个必然失败的模型。改成写死之后，这个坑从源头没了。

**生图模型**和对话模型一起声明，走 `POST /v1/images/generations`。插件只替换 `authorization` 头、请求原样转发，所以不需要额外代码；Magpie 靠模型上的 `capabilities.output.image` 决定把它发到 images 而不是 chat。

**改清单**：编辑 `models.mjs` 的 `CATALOG`，升版本号，跑 `node --test test/*.test.mjs`。测试钉住了 id 集合与显示名。

## 额度

控制台把积分分成两个池，插件把它们映射成 Magpie 原生的额度窗口：

| 池 | 5 小时窗口 | 周窗口 | 覆盖模型 |
| --- | --- | --- | --- |
| 通用积分池 | 120,000 | 1,200,000 | 「所有 Free 模型」 |
| Flash-Lite 专属积分池 | 120,000 | 1,200,000 | 仅 Flash-Lite 系列 |

（控制台 2026-11-02 的实际数值。文档里专属池仍写 60,000 / 600,000，已过时。）

专属池用完后会自动回落到通用池扣，和平台规则一致。额度是**账户级**的：同一账户下所有 API Key 共享同一个池，加两个 Key 会显示同样的数字。

积分消耗很慢：累计几十次探测请求只让 5 小时窗口掉了 **4.9 积分**（119,995.12 / 120,000）。所以「额度」几乎不会是瓶颈，真被限的时候去看看 `error.code`。

额度只出现在三处：账号行、`magpie quota`、`GET /v1/magpie/quotas`。Magpie 的插件系统不允许新增面板，也进不了用量概览页。

## 配置

`plugins.json` 里这一项的 `options`：

```json
{
  "baseURL": "https://token.sensenova.cn/v1",
  "quotaTtlMs": 60000,
  "scopeModel": "flash-lite",
  "locale": "auto",
  "credentialsFile": "~/.sensenova-quota.json"
}
```

| 配置项 | 默认值 | 含义 |
| --- | --- | --- |
| `baseURL` | `https://token.sensenova.cn/v1` | Token Plan 地址 |
| `quotaTtlMs` | `60000` | 额度读取的缓存时长（毫秒） |
| `scopeModel` | `flash-lite` | 接口没给 `model_ids` 时，用哪个关键词圈定专属池 |
| `locale` | `auto` | `zh` / `en` / `auto`（跟随本机），决定额度窗口与错误信息的语言 |
| `credentialsFile` | `~/.sensenova-quota.json` | 控制台凭据文件位置 |

并发上限在 `package.json` 里声明为 **5**。实测平台按**模型**限制 5 个并发：4 个 → 4/4，5 个 → 5/5（含 `max_tokens=4096`、单请求 27 秒的情形），第 6 个立刻 429；跨模型不共享配额（两个模型各 3 个、共 6 个在飞，全部通过）。账号页的下拉可以手动覆盖这个值。

## 排错

**429 `inference exceeds tpm/rpm limit`。** 四种原因共用这一句，区别在 `error.code`；插件会把它记进日志（同一模型同一码只记一次）：

| `error.code` | 含义 | 会自己恢复吗 |
| --- | --- | --- |
| `Throttling.BurstRate` | 瞬时突发太快 | ✅ 隔几秒 |
| `RateLimitExceeded.EndpointRPMExceeded` | 端点级 RPM，不按账号算 | ❌ 静默 5 分钟仍 429 |
| `ModelAccountRpmRateLimitExceeded` | 模型维度的账户 RPM | ❌ 静默 2 分钟仍 429 |
| `insufficient_quota` | 该模型当前**可分配额度为 0**（与积分余额无关） | ❌ 等它恢复，实测约 20 分钟 |

**这四种都跟「积分够不够」无关。** 实测 429 密集出现的那段时间，控制台通用池仍显示 119,995 / 120,000（100% 可用）。`insufficient_quota` 指的是**该模型这一层**拿不到额度，不是账户积分不足 —— 遇到它不要以为要充值，等它自己恢复，或者换模型。

遇到 429 先看日志里的 code：`BurstRate` 等几秒重试，其余三种换模型比等更划算。

**同一时段的可用性**（2026-11-02 22:47–23:05，每 25 秒打一次点，`max_tokens=1`）：

| 模型 | 成功 | 失败码 |
| --- | --- | --- |
| `deepseek-flash` | **1/20（5%）** | `EndpointRPMExceeded`×17、`EndpointTPMExceeded`×3 |
| `deepseek-v4-flash` | 3/12（25%） | `insufficient_quota`×9 |
| `sensenova-6.8-flash` | **6/6（100%）** | — |

第三方模型在高峰时段基本不可用，且**不是按固定节拍恢复** —— 那次唯一的成功出现在第 77 秒，之后 7 分钟没有任何一次通过。想稳定用就换 SenseNova 自家的模型。

**403 `model is not available in the current token plan`。** 套餐不含这个模型。插件会把这个 id 从该账号的列表里移除（按 Key 记、只在内存），所以只会撞一次。

**账号行显示「操作过于频繁」或「登录被拒绝」。** 是控制台那次密码登录被 IAM 限流了，只影响额度，模型照常。把账号密码两项留空、只保留 API Key，就不会再碰控制台接口。

## 安全与隐私

这个插件是本地第三方客户端，**与商汤无隶属关系**，未经官方审核。

**它存了什么。** API Key 和（可选的）账号密码存在 Magpie 的 `~/.config/magpie/plugin-auth.json`，密码是**明文** —— Magpie 不做额外加密，且该文件装着所有插件的登录态，任何插件都能读。所以除非你确实需要额度显示，账号密码留空。控制台令牌只在内存里，不落盘；只有凭据来自 `~/.sensenova-quota.json` 时，续期后的令牌会写回那个文件。

**它访问哪些主机。** `token.sensenova.cn`（模型请求与生图）、`platform.sensenova.cn`（读额度）、`iam.sensecoreapi.cn`（续期控制台令牌）。没有遥测，不向别处发送任何东西。

**它能看到什么。** 插件位于请求路径上，技术上能看到完整对话与工具结果。代码只读 `authorization` 头并替换它，请求体原样转发，不记日志、不缓存、不落盘 —— 但这是代码的自我约束，不是平台隔离。

**额度接口的风险。** 额度来自控制台前端自己调用的接口，不是公开 API：可能随时改版失效，脚本化访问是否被允许需你自行确认，也可能触发风控。介意的话就别用额度功能，只填 API Key，插件会退化成一个纯模型供应商。

## 开发

```bash
node --test test/*.test.mjs
```

92 个测试，覆盖：静态清单（id 集合、显示名、生图能力位）、字段口径、请求透传（`(url, init)` 与 `Request` 两种形状都保住 body）、模型 403 隐藏与 429 错误码记录、额度映射与缓存、额度失败不连累账号（`signIn: "kept"`、令牌复用、退避）、IAM 失败原因识别、登录提示与本地化。

## 来源与许可

- 上游项目：[aqiu817/magpie-sensenova](https://github.com/aqiu817/magpie-sensenova)
- MIT，原始版权归 aqiu817；本分支修改版权归 xiaolietu
- 图标与商标说明见 [NOTICE.md](NOTICE.md)：`assets/sensenova.png` 是商汤商标，仅用于在 Magpie 的供应商列表里识别 SenseNova
