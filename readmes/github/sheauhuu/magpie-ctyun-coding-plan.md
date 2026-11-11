# 天翼云 Coding Plan

天翼云 Coding Plan 的 [magpie](https://usemagpie.ai/) 供应商插件。可仅使用 API Key 调用模型；需要官方模型发现和 5 小时／周／套餐总量三个额度窗口时，可选择密码登录（保存或不保存密码），有桌面的环境也可选择浏览器单点登录。

供应商显示名称为「天翼云 Coding Plan」，包名为 `magpie-ctyun-coding-plan`。图标采用 [eaichat.ctyun.cn 官网 favicon](https://eaichat.ctyun.cn/chat/favicon.ico) 的原始文件，嵌入插件元数据，显示时无需访问官网。当前 magpie 的“已安装插件”列表标题仍由宿主按包名或目录名生成。

## 安装

需要在运行 magpie 的主机／容器中安装插件。插件由 magpie 的 Bun 宿主运行；Node.js 22+ 用于本地开发和测试。

```sh
git clone https://github.com/sheauhuu/magpie-ctyun-coding-plan.git
cd magpie-ctyun-coding-plan
npm install
magpie plugin add "$PWD"
magpie plugin login ctyun-coding-plan
```

也可在 magpie 的「插件 → 添加插件」中填写本地仓库的绝对路径，然后选择供应商登录。

浏览器登录需要 magpie 所在主机有可操作的图形桌面，优先使用该主机已安装的 Chrome，但使用独立的临时登录上下文。没有 Chrome 时可安装专用 Chromium：

```sh
npm run browser:install
```

通过浏览器访问服务器的 magpie 页面，不会把官网认证窗口打开在客户端电脑上。无桌面的 Linux／Docker 可选择「账号密码登录」，在“是否保存密码”处选择“否”，或仅使用 API Key；这两种用法无需安装 Chrome、Playwright 或系统凭据服务。

本项目尚未发布 npm 包；使用本地目录安装，不要把仓库名称当作已发布的 npm 包名。

## 三种接入方式

### 仅 API Key（不查询额度）

1. 选择「仅 API Key（不查询额度）」。
2. 填写账号名称和 Coding Plan API Key，保存后即可调用模型，无需网页登录、账号密码或套餐 ID。
3. 使用插件内置的模型清单；不访问官网模型列表、额度或单点登录接口，也不访问系统凭据库。额度状态为「仅 API Key（未启用额度查询）」，不报告额度错误或虚构剩余额度。

此模式不测试 Key 是否有效，不消耗套餐发起试用请求；真实调用由天翼云验证 Key。没有套餐用量数据，magpie 无法依据本账号的三个额度窗口进行预先分流，仍可使用模型自动分组和常规请求失败处理。

### 浏览器单点登录（不保存密码，需要图形桌面）

1. 填写账号名称、Coding Plan API Key；只有一个有效套餐时，套餐 ID 留空。
2. 插件打开专用 Chromium 登录窗口，在天翼云官方网站完成登录。可使用官网提供的账号密码、扫码等方式；验证码由用户在官网完成。
3. 登录成功后，窗口自动关闭，插件保存 Cookie 会话，不保存账号密码。
4. 助手 Cookie 失效时，优先通过仍有效的 IAM 单点登录会话恢复；IAM 会话也失效时，提示重新选择浏览器登录。

专用窗口使用临时浏览器上下文，与日常 Chrome 的登录状态独立，不会读取日常浏览器的密码或 Cookie。已有插件会话的正常续期通过 HTTP 完成，不会定时弹出浏览器。

### 账号密码登录

1. 填写账号名称、Coding Plan API Key、天翼云账号；只有一个有效套餐时，套餐 ID 留空。
2. 在输入密码前选择“是否保存密码用于自动重登”：**否，不保存密码** 或 **是，保存到系统凭据库**。
3. 输入密码后，插件通过官方 HTTP 接口完成登录，确认可以读取模型清单，并保存 Cookie／IAM 会话供模型发现和额度查询使用；无需浏览器。

选择“否”时，不读写系统凭据库、不创建密码文件，适用于 headless Linux 和 Docker。密码仅用于本次登录，完成或失败后清空输入引用；IAM 会话也失效后需再次输入密码。若此前同名账号保存过系统密码，旧条目不会被删除，但新的登录会话不再引用它。

选择“是”时，账号密码保存在系统凭据库，magpie 登录数据仅保存引用，不保存密码或密码哈希。会话失效时先尝试 IAM 单点登录恢复，无法恢复时使用保存的密码重登。系统凭据库使用 macOS Keychain、Windows Credential Manager，或 Linux Secret Service；Linux 需要可用且已解锁的凭据服务。凭据库不可用时会明确提示，可重新登录并选择“否”；不会静默降级或将密码写到文件。

当前 magpie 的原生插件表单采用分步选项，“是否保存”使用是／否选择，未增加自定义页面或复选框。已有登录方式索引保持 0 仅 Key、1 浏览器、2 密码；调用登录接口时，`save_password=yes` 才保存密码，`no` 或未传该值均不保存。已有保存密码的会话继续使用原来的系统凭据库引用。

触发图形验证码、短信验证、密码错误或凭据缺失时，自动重登会停止，提示用户重新登录；不会持续尝试错误密码。切换同名账号到浏览器登录后，不再使用保存的密码，并尝试移除旧凭据。如果系统凭据库不可用，浏览器登录仍可完成；可在系统凭据库恢复后用下文命令移除旧密码。

### 先填 Key，以后再登录／关闭额度查询

无需删除账号。在同一供应商中再次发起登录，选择账号密码登录或浏览器登录，填写**完全相同的账号名称和原 API Key**，完成官网认证即可启用模型发现与额度查询。magpie 会更新原账号，保留原账号槽位和其他账号；登录失败则保留原记录。宿主没有向插件登录表单提供已保存 Key 的读取接口，所以补登录时仍需重新填写 Key。若想新增独立账号，请使用不同名称。

已启用额度查询后，也可用相同名称和原 Key 重新选择「仅 API Key」，关闭该账号的网页登录与额度查询。它不会自动删除以前保存在系统凭据库中的密码；需要清除密码时使用下文的凭据移除命令。

## API Key 与网页登录的区别

三种方式都需要 Coding Plan API Key；网页登录只在启用模型发现和额度查询时需要：

| 凭证 | 用途 | 保存位置 |
| --- | --- | --- |
| Coding Plan API Key | 模型推理调用 | magpie 的插件登录存储 |
| Cookie／IAM 会话 | 获取官方模型列表、查询套餐额度 | magpie 的插件登录存储 |
| 账号密码（不保存模式） | 本次官网登录 | 登录完成／失败后不保留 |
| 账号密码（保存模式） | 会话无法恢复时重新登录 | 系统凭据库 |

API Key、Cookie／IAM 会话没有由插件额外加密，应将 magpie 的登录存储及其备份视为敏感文件。请勿提交、同步到公开仓库或作为 Issue 附件上传。密码进入系统凭据库不代表所有登录数据都在钥匙串中；更多说明和漏洞报告方式见 [SECURITY.md](SECURITY.md)。

账号名称用于区分多个账号，重新使用同一名称登录会更新该账号。请确保填写的 API Key 属于所登录的账号。插件不自动创建或重置天翼云密钥。

magpie 会先询问登录参数，包括 API Key，再开始登录。这遵循宿主提供的登录流程。

## 模型和额度

接入后，模型直接出现在 `ctyun-coding-plan/<模型ID>` 下，无需设置自定义模型列表或余额查询地址。例如：

```text
ctyun-coding-plan/deepseek-v4.1-flash
ctyun-coding-plan/glm-5.3
ctyun-coding-plan/MiniMax-M2.5
```

已完成网页登录时，模型清单优先从官网获取；仅 API Key 模式使用内置清单。注册的模型 ID 和显示名称统一去除末尾的 `-oc`，保留原有大小写、版本号和其他变体，例如 `MiniMax-M2.5-oc` 注册为 `MiniMax-M2.5`，`deepseek-v4-pro-0813-oc` 注册为 `deepseek-v4-pro-0813`。GLM-5.3 固定显示为 `GLM-5.3`。发送请求时，插件按内置清单或当前账号的官网发现映射恢复准确的官方 ID；不同账号的映射相互隔离，官网原本不带 `-oc` 的模型不添加后缀。

magpie 按模型 ID 自动分组，显示名称本身不决定分组。若此前勾选了带 `-oc` 的旧 ID，需在供应商模型列表中改选去掉后缀的新 ID；magpie 会保留旧勾选，仅更新插件清单或重启不会迁移它。直接选择了旧 ID 的客户端、保存的路由组成员也需同步更新。官网暂不可用时保留此前的清单；初次未登录时使用 2026-10-30 的官方清单快照，共 9 个模型。模型能力保守声明为文本输入输出和工具调用，不虚构上下文长度或图片能力。

天翼云不公布按 token 计费的单价。为了让 magpie 能估算费用，内置模型按原厂国际站的官方价格（美元／百万 token，2026-10-31 核对）声明 `cost`，见 `src/model-profiles.mjs`。这只是参考价，Coding Plan 实际按套餐额度计费。`deepseek-v4-flash-0731` 已不在 DeepSeek 价格表中，沿用 V4 Flash 首发价；新发现的未知模型不填价格。

思考设置按模型声明：[GLM-5.3](https://docs.z.ai/guides/llm/glm-5.3)／[Flash](https://docs.z.ai/guides/vlm/glm-5.3-flash) 支持 `low/high/max`，不能关闭，默认 `max`；[DeepSeek](https://api-docs.deepseek.com/guides/thinking_mode/) 支持 `none/low/high/max`，默认开启、`high`；[GLM-5.1](https://docs.z.ai/guides/llm/glm-5.1)、[Kimi-K2.5](https://huggingface.co/moonshotai/Kimi-K2.5)、[Qwen3.6-Flash](https://help.aliyun.com/en/model-studio/deep-thinking) 提供 `none/enabled` 开关，默认开启；[MiniMax-M2.5](https://platform.minimax.io/docs/api-reference/text-openai-api) 仅 `enabled`。除已经实测的 GLM-5.3-oc 和 DeepSeek-V4.1-Flash，其余先按原厂官方能力配置，天翼云行为待逐一核验。

`enabled` 是开启开关，不是分级强度。插件将开关转换为各模型原生的 `thinking.type` 或 `enable_thinking`；Qwen 的数值型 `thinking_budget` 保留，不虚构档位到预算的映射。DeepSeek 显式的 `thinking.type` 优先于 `reasoning_effort`。不传强度时保留原厂默认；新发现的未知模型不自动套用已有模型的规则。

插件还会增量修复天翼云 SSE 的空 ID 占位首帧，以及已知工具续片中为空的 `type/id`，解决 SDK 聚合失败。保留正文、推理、工具参数、用量和上游错误，不补造响应 ID 或成功结果。

启用网页登录后，magpie 用量页、`magpie quota` 和原生配额接口会显示三个窗口：

- `5 hours`：近 5 小时。
- `Weekly`：本周。
- `Plan total`：套餐总量。对当前按月套餐而言，是订阅周期总额度，不假设为自然月。

官方返回的是使用比例，没有精确剩余请求次数。插件将 `0.008` 转为 magpie 原生配额需要的 `0.8`（百分比）。刷新时间优先使用明确的套餐到期时间，其余根据官方统计时间和“多少分后刷新”的提示估算，精度受官网提示舍入影响。

额度属于整个账号套餐，多把 Key 共享，不是每个 Key 独享。多个有效套餐时，登录参数中填写官网对应的套餐 ID，避免错误地合并额度。

三个窗口通过 `auth.usage()` 返回，供 magpie 展示并参与配额路由。最终路由行为取决于 magpie 版本和用户的路由配置。网页登录失效会显示额度查询错误，但不会把仍可用的模型 API Key 一并标为失效。

模型和额度读取更新的会话仅缓存在当前宿主内存中，不调用 `client.auth.set`。持久化续期通过 magpie 原生 `auth.refresh` 返回补丁，由宿主在写锁内核对原账号后保存，避免查询结束时恢复已删除账号。宿主重启会丢弃尚未持久化的会话变化，必要时从原会话重新进行单点登录／密码恢复。此行为依赖宿主支持原生续期，已验证 `host-57e4026712e7.js`；其他宿主需另行检查。

推理请求只携带 API Key，Cookie 和网页登录请求头不会转发到推理接口。插件使用固定的官方域名，拒绝将密钥发送到其他地址。

## 开发与验证

```sh
npm test
npm run check
```

可选的真实浏览器集成测试使用隔离的无头 Chrome，网页请求全部拦截为本地测试响应，不连接天翼云或读取日常浏览器资料：

```sh
npm run test:browser
```

单元测试覆盖仅 API Key 模式不访问官网／凭据库、密码登录、单点登录恢复、验证码中断、并发恢复、多个账号隔离、原生额度转换、浏览器窗口清理，以及推理与网页登录凭据的隔离。

账号删除另有实际 magpie Bun 宿主集成回归，使用临时认证文件、两个宿主和假会话，不读取真实账号或连接天翼云：

```sh
bun scripts/host-account-regression.mjs --host /path/to/host-57e4026712e7.js
bun scripts/host-smoke.mjs --host /path/to/host-57e4026712e7.js
```

回归覆盖仅 API Key 接入、失败补登录保留原记录、补浏览器／密码登录后保留账号键及其他账号、浏览器与凭据库均不可用时的不保存密码登录，以及主键／后缀键删除、成功和失败的额度查询、检查与写入间的竞争、模型快照、原生续期完成后账号仍保持删除。删除问题的复现证据和宿主限制见 [ACCOUNT_DELETION.md](ACCOUNT_DELETION.md)。

模型思考参数和流式兼容修复也有离线回归。`scripts/sdk-replay.py` 可用 OpenAI Python SDK 重放既有响应，验证真实 ID 和工具参数聚合，全程使用 MockTransport，不消耗套餐。在独立 Python 虚拟环境安装开发依赖 `openai==2.48.0`、`httpx==0.28.1` 后，运行 `python scripts/sdk-replay.py`。已验证正常文本与工具聚合成功，长度截断及上游错误仍按原样报错。

`docs/` 为本地研究资料目录，已从 Git 跟踪和发布清单中排除；日常使用不依赖该目录。

显式执行官方接口实测：

```sh
cp .env.example .env
# 在本地 .env 中填写测试账号；文件已被 git 忽略。
npm run test:live -- --env .env
```

实测脚本只登录并读取模型和额度；模拟删除助手 Cookie 后验证 IAM 恢复。不写入系统凭据库，不保存 Cookie，不修改 magpie 配置，也不发起模型推理调用。输出仅含模型 ID、额度和测试状态。

### 已验证与限制

- 2026-10-30：使用官方接口实测了账号密码登录、9 个模型的发现、三个额度窗口，以及清除助手 Cookie 后从 IAM 会话恢复。该次登录没有要求验证码。
- 2026-10-31：迁移本机旧 GLM 勾选后，实际 magpie 网关已公布 `GLM-5.3`，自动发现的 `auto/glm-5.3` 同时包含智谱与本插件的 `glm-5.3`。请求转换用模拟网络验证，未为验证路由发起收费推理。
- 助手 Cookie 的客户端有效期约为 7 天；服务端仍可能提前撤销会话。自动恢复解决会话过期后的重新获取，不保证会话永久有效或始终免验证码。
- 已通过 magpie 实际 Bun 插件宿主的加载、供应商注册、三种接入方式、保存密码的是／否选择及密码掩码输入检查；测试使用临时空白登录存储，不修改现有 magpie 配置。
- 已通过真实隔离无头 Chrome 的测试响应登录流程，验证 Cookie 提取、IAM 会话保留和窗口清理。系统凭据库也已用临时测试条目验证写入、读取与删除。实际官网浏览器登录仍需要用户在可见窗口中完成，首次使用时请验证。
- 浏览器登录需要 magpie 所在主机有可操作的图形桌面。纯远程／无桌面环境可使用不保存密码的登录方式；只有选择「保存到系统凭据库」时才依赖凭据服务。外部凭据文件／Docker Secrets 读取方式尚未实现。
- 卸载插件或在 magpie 中删除账号不会自动删除系统凭据库条目。可用下面的命令移除本插件保存的密码：

```sh
npm run credentials:forget -- "账号名称"
```

这是第三方插件，依赖官网当前使用的接口。官方调整认证或响应结构时需要更新插件。请按天翼云套餐的适用范围使用。

## 项目结构

- `index.mjs`：magpie/OpenCode 风格插件入口。
- `src/plugin.mjs`：API Key 接入、两种网页登录方式、账号会话协调、模型及原生配额钩子。
- `src/session.mjs`：官方 IAM/CAS 登录、Cookie 容器、模型和额度解析。
- `src/browser.mjs`：专用浏览器登录与会话提取。
- `src/credentials.mjs`：系统凭据库读写。
- `src/model-profiles.mjs`：按精确模型 ID 配置思考档位及原生参数转换。
- `src/sse.mjs`：流式占位帧和工具续片兼容修复。
- `scripts/live-check.mjs`：显式的官方接口实测。

## License

项目原创代码采用 MIT 许可。官网图标及第三方品牌标识不通过本项目的 MIT 许可重新授权；来源、许可核验状态和权利说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。本项目是第三方适配插件，不代表天翼云官方。
