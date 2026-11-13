<div align="center">
  <img src="avatar.png" width="76" alt="豆包工作头像" />
  <h1>豆包工作 · Magpie 独立插件</h1>
  <p>独立浏览器登录 · 原生多账号 · 动态模型 · 额度查询 · 文本流式对话</p>
</div>

专为 **豆包工作** 制作的轻量提供商插件。账号、模型、调用和额度直接集成到 Magpie；不需要启动旧版账号管家、反代网关、Agent2API 或云服务器。无运行时 npm 依赖。

> 非官方社区适配，使用豆包工作现有登录会话，不是官方 OAuth / API。上游接口和账号可用性可能变化。从 **v0.1.1** 起支持 **Windows / macOS + Chrome 或 Edge**。

## 安装与登录

需要已安装 [Magpie](https://usemagpie.ai/) 及其插件运行环境 Bun；插件不另装后台常驻服务。已在 macOS、Magpie `0.1.3853` 和 Bun 插件宿主上验证加载。

### 从 GitHub 安装

在 Magpie **插件 → 发现** 中，将“来源”设为 **非官方插件 · GitHub**，再搜索 `magpie-doubaowork-auth` 或 `doubaowork`，核对仓库所有者为 `245678000000`。GitHub 与 Magpie 的索引缓存更新后会显示；不属于社区官方认证插件。

也可以在“添加插件”中粘贴 `github:245678000000/magpie-doubaowork-auth`，或执行：

```sh
magpie plugin add github:245678000000/magpie-doubaowork-auth
```

需要固定版本时，可使用已存在的提交 SHA 作为 `#<commit>` 引用；此仓库暂未发布 npm 包。

### Windows 提示找不到浏览器

- 先在 Magpie **插件 → 已安装** 更新此插件，确认版本至少是 **0.1.1**，再重新发起登录。使用本地目录安装的用户需用新版目录替换旧文件并重载插件。
- 自动检测用户与系统安装目录（包括 32 位及 64 位）和 Windows 注册表 App Paths。默认先尝试 Chrome，启动失败再尝试已检测到的 Edge；不读取日常浏览器配置。
- 便携版或自定义路径且未注册到 App Paths，可在 Windows 的用户环境变量设置 `DW_CHROME_BIN` 或 `DW_EDGE_BIN` 为本机浏览器可执行文件的完整路径，例如 `D:\Apps\Chrome\chrome.exe`。退出并重新打开 Magpie，使其读取新环境变量。
- 若提示「已找到浏览器，但独立登录通信未建立」，这与找不到安装位置不同。请更新 Magpie 与浏览器；如果企业策略关闭了 DevTools，请联系管理员。
- WSL 或远程 Linux 上运行的 Magpie 与 Windows 桌面版不同。请使用 Windows 桌面端发起登录。

### 从本地目录安装

将本目录放在一个固定位置，执行：

```sh
magpie plugin add /绝对路径/magpie-doubaowork-auth
```

如果终端尚未配置 `magpie` 命令：

```sh
/Applications/Magpie.app/Contents/MacOS/magpie plugin add /绝对路径/magpie-doubaowork-auth
```

1. 在 Magpie **供应商 → 添加供应商** 中，选择 **豆包工作 · 独立版**。
2. 在新打开的独立 Chrome / Edge 窗口，亲自完成扫码或手机验证。
3. 在独立窗口完成登录及官网提示的人工验证，然后回到进度页点击 **接入 Magpie**。确认之前不保存账号，也不自动关闭窗口；核验后保存账号并加载模型。
4. 添加下一个账号时，再次选择同一提供商。每次使用全新的临时浏览器资料，日常浏览器登录保持原样。

也可以使用原生命令登录：

```sh
magpie plugin login doubaowork-direct
```

Magpie 原生提供账号切换、模型选择及调用入口；本插件的提供商 ID 为 `doubaowork-direct`，与社区其他豆包插件分开。安装不修改默认模型，也不迁移旧网关中的账号。

## 公开发布与发现

GitHub：[245678000000/magpie-doubaowork-auth](https://github.com/245678000000/magpie-doubaowork-auth)。仓库以 `magpie-plugin` 标记，采用 Magpie 的 [GitHub 第三方插件发现机制](https://usemagpie.ai/docs/plugins#publishing-and-listing)。`package.json` 和可直接运行的入口均在仓库根目录，无需预先构建。

仓库仅包含插件源码、测试及说明，不包含作者或其他用户的账号、Cookie、验证码、签到账本或 Magpie 配置。安装后请登录自己的账号。

## 429：区分人工验证与普通限流

从 **v0.1.2** 起，只有上游明确返回 `decision.type=verify` 时才提示人工验证；单独的 HTTP 429 或业务码 `710022004` 不等于验证证据。错误 JSON 的 `error.code` 会区分 `verification_required`、`rate_limited` 和 `session_expired`，并仅保留数字 `upstream_code`，不回显挑战载荷、Cookie 或原始错误体。

- **要求人工验证**：重新发起本插件登录，在新打开的独立窗口完成官网验证，之后到进度页点击“接入 Magpie”。官方桌面客户端能聊天，不代表新建的浏览器会话也已完成验证。
- **普通限流**：暂停重复测试，按官方提示等待，不把它当成登录失效而连续重登。
- **官方正常、插件仍异常**：核对 Magpie 该账号所选代理与官网窗口使用的网络是否符合预期。独立 Chrome / Edge 使用浏览器自己的网络设置，Magpie 的全局或账号代理不会自动配置到浏览器；插件不自动修改代理。

此版本改进诊断和确认流程，不保证服务端验证或限流会自动解除。需要反馈时，只提供版本、错误分类和数字上游码，不要分享 Cookie 或验证码。

## 功能与边界

| 项目             | 说明                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 多账号           | 登录快照交给 Magpie 私有账号库；每次请求读取当前选中账号，按账号获取模型和额度                                            |
| 模型目录         | 读取上游菜单；没有静态伪造模型，临时网络错误保留 Magpie 已缓存的列表                                                      |
| 文本对话         | Chat Completions、SSE 流式 / 非流式、思考文本拆分                                                                         |
| 完整历史         | 每次发送完整角色历史到一个新建的豆包会话，不跨客户端复用历史会话                                                          |
| 客户端工具       | **实验性提示词桥**，不是上游原生 function calling；工具声明写入文本，解析模型按约定返回的工具名与参数。插件本身不执行工具 |
| 图片、音频、文件 | 第一版仅文本；其他内容会明确提示，不静默丢弃附件                                                                          |
| 每日签到         | 默认关闭，双重开关；结果不确定时保留记录，后续只查询，不重复领取                                                          |
| 服务依赖         | 不监听通用 API 端口；仅登录期间启动随机路径的临时 loopback 状态页                                                         |

为避免把未知参数写成官方规格，未下发上下文信息时使用保守默认值：上下文 `32768`、输出 `4096`。这些是插件配置值，不是模型真实容量认证。未编造 token 用量或价格。输出值是客户端模型元数据，并非上游硬性生成长度控制；`max_tokens`、`temperature` 等采样参数尚未映射到豆包请求。

本插件将对话、系统指令与工具声明交给豆包工作处理；请只发送准备交给该服务的内容。豆包端可能留存这些新会话，适用该服务自己的数据政策。

## 插件选项

在豆包工作供应商编辑页的 **插件选项** 中：

- **实验性客户端工具桥**：默认开启。纯文本使用可关闭。带工具时先缓冲并校验完整回答，再交付客户端；文本请求仍逐块流式。
- **允许每日签到**：默认关闭。开启后，还需要在 Magpie 原生每日签到设置中选择该账号。

签到账本按北京时间分日，写入领取前创建跨宿主原子保留记录，适配 Magpie 应用与 CLI 同时运行。出现网络中断、人工验证或未确认状态时，不自动重复提交。保留记录需要人工核对时，先检查豆包官方页面，不要盲目删除账本重试。签到领取尚未进行真实在线验收。

高级启动参数可通过插件 JSON options 设置：`browser: "chrome" | "edge"`、`contextLimit`、`outputLimit`。原生布尔开关由 Magpie 保存并实时读取。

## 会话与隐私

- 每次登录使用临时目录和匿名 CDP 管道，无开放调试端口，不读取日常 Chrome / Edge 资料或桌面 Cookie 数据库。
- 本人确认接入并核验成功、取消、关窗或 10 分钟超时后清理专用浏览器；登录页只展示进度，不展示 Cookie。
- 如果登录 Cookie 缺少工作版设备标识，仅读取本机豆包工作 `Local State` 中的设备 ID，不读取其他资料。
- 登录快照放在 Magpie 的私有 OAuth access 字段中，`dwc1.` 后为 base64url **编码而非加密**。保持 Magpie 配置目录私有，避免分享 `plugin-auth.json`、其备份和本机调试日志。
- 本机已核验 Magpie 账号库权限为 `0600`，本插件临时目录 `0700`、签到账本 `0600`（macOS）。Windows 临时浏览器目录使用当前用户与 SYSTEM 的 ACL。文件权限不替代磁盘加密。
- 会话失效会标记需重新登录；不保存验证码，不绕过人工验证，也不伪造设备 ID。

## 验证

```sh
npm test
npm run check
```

本地回归测试覆盖：账号隔离、模型解析、严格 SSE 结束、分片中文、截断流、工具声明校验、登录成功 / 取消 / 来源校验 / 清理，以及跨宿主签到去重。

Windows CI 使用真实 Chrome / Edge 验证浏览器发现、隔离启动、匿名管道和退出清理，不使用账号。Windows 的扫码与真实账号调用请在本机复验。

2026-11-13 macOS 在线验收：

- 在真实 Magpie 安装成功；独立浏览器登录一个账号成功。
- 原生供应商页显示已登录，加载 **10 个当时可用模型**；不同账号或日期的目录可能不同。
- `magpie provider test doubaowork-direct seed-lite-7b`：**chat 通过，约 3.9 秒**。
- `seed-lite-7b` 实验性提示词工具桥：HTTP 200，返回 `tool_calls`，工具名及参数符合声明；未执行任何工具。
- 尚未将第二个账号接入本插件；多账号结构有离线覆盖，第二个真实账号及签到领取仍待后续验收。
- 该记录不代表所有模型、附件、工具调用或所有客户端均已在线验证。

## 项目结构

```text
index.mjs           Magpie 原生提供商、登录、额度与选项钩子
protocol.mjs        固定官方源、会话格式、动态模型和额度
completion.mjs      对话适配与实验性工具桥
stream.mjs          上游 SSE 解析和严格完成语义
login.mjs           临时登录进度页与认证回调
browser-login.mjs   独立浏览器和匿名管道生命周期
checkin.mjs         opt-in 签到、回查与本地防重复记录
test/               不含真实凭据的本地回归测试
```

## 来源、许可与致谢

协议适配参考 [Agent2Providers](https://github.com/ProvidersPlugin/Agent2Providers) 的豆包工作模块及其 EchoBird 来源，依据 [Magpie 官方插件文档](https://usemagpie.ai/docs/plugins) 对接原生宿主。完整来源及上游提交见 [NOTICE.md](NOTICE.md)。

适配代码以 **AGPL-3.0-only** 交付，完整文本见 [LICENSE](LICENSE)，保留 [EchoBird MIT 声明](licenses/EchoBird-MIT.txt)。用户提供的头像用于识别，豆包与 Magpie 的品牌权益归各自权利人。

**感谢 [LINUX DO](https://linux.do/) 社区的交流与分享。**
