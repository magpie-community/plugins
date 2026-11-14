# Coarena

<img src="https://raw.githubusercontent.com/Mars-Sea/coarena/main/assets/coarena.svg" width="48" height="48" alt="Coarena" />

为 **Magpie、OpenCode 1.x 和 OpenCode 2.x** 接入 Coarena Model API 的独立插件。Provider ID 为 `coarena`，首版使用 OpenAI Chat Completions 兼容协议，基址为 `https://coarena.ai/api/v1`。

**当前状态：P0 代码与离线验证已完成，真实账号和宿主验收尚未完成。** 源码仓库：[Mars-Sea/coarena](https://github.com/Mars-Sea/coarena)，npm 包：[`coarena`](https://www.npmjs.com/package/coarena)。Magpie 收录进度见 [分发记录](https://github.com/Mars-Sea/coarena/blob/main/docs/DISTRIBUTION.md)，验证边界见 [验证报告](https://github.com/Mars-Sea/coarena/blob/main/docs/VALIDATION.md)。

支持宿主保存 API Key、公开动态模型目录、工具与图片能力映射，以及 Magpie 的每日美元额度与请求次数显示。普通请求和流式响应交给宿主的 OpenAI Compatible SDK；插件不自行解析 SSE。Responses、Anthropic 原生协议、提额、评价和历史查询留待后续版本。

Coarena 官方 OpenAPI 说明：**服务端会保存提示词和响应，即使请求指定 `store:false`。** 请按此事实决定发送哪些内容。

## 安装

运行环境为 Node.js 22+ 或兼容的 Bun；插件没有生产依赖。安装宿主后，请先用当前版本的 `--help` 核对命令；以下方式基于宿主文档，尚未在真实 CLI 中执行。可使用 npm 包安装，或从 GitHub 加载源码。

### Magpie

```sh
magpie plugin add coarena
magpie plugin login coarena
magpie quota coarena --json
```

也可使用 `magpie plugin add github:Mars-Sea/coarena` 从 GitHub 安装。

本插件目前**未获 Magpie registry 收录**：维护者将 Coarena 归类为第三方中转服务，当前暂不直接收录此类提供商；[PR #1122 的维护者说明](https://github.com/magpie-community/plugins/pull/1122#issuecomment-6871683565) 明确确认按包名安装仍可使用。

在 [Coarena API 页面](https://coarena.ai/account/api) 创建 Key，在登录交互中选择 `Coarena API key` 并粘贴。Key 由宿主保存，本插件不创建自己的凭据文件。选择 `coarena/<模型ID>` 开始对话；模型 ID 以当前公开目录为准。首次加载时无需 Key 也能发现目录。

实际推理验收可在具备测试账号后运行 `magpie provider test coarena`；这会发送真实请求并消耗额度。安装或编辑后如列表未更新，可重新加载插件；App 中可能需要禁用后重新启用。

### OpenCode 1.x

在 `opencode.json` 使用 v1 的单数 `plugin`：

```json
{ "plugin": ["coarena"] }
```

从源码开发时，官方 v1 文档支持在项目 `.opencode/plugins/` 中加载本地 `.js` / `.ts` 文件。可在独立测试项目创建 `.opencode/plugins/coarena.js`，内容如下，路径替换为仓库位置：

```js
export { CoarenaPlugin } from "file:///absolute/path/to/coarena/opencode.mjs"
```

此包装文件只导出插件函数。重启宿主后按安装版本的 `opencode auth login` 登录并选择 Coarena。不要把 `index.mjs` 作为 v1 入口，它还导出测试辅助对象。

### OpenCode 2.x

2026-11-14 复核的官方 v2 文档使用复数 **`plugins`**，可配置为：

```json
{ "plugins": ["coarena"] }
```

从源码加载时，本地项必须是目录。在独立测试项目的 `opencode.jsonc` 中配置实际仓库路径：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/absolute/path/to/coarena"]
}
```

目录加载通过 `exports["."]` 取得 `opencode2.mjs` 的默认 `{id,setup}` 对象。相对路径以配置文件所在目录为基准。然后通过当前版本的 provider / connection 界面选择 Coarena 并添加 API Key；具体交互以所装宿主为准。v2 桥接提供认证、模型与 SDK 选项，不提供 Magpie 的额度卡片。

v1 的 `plugin` 与 v2 的 `plugins` 不可混用。资料来源及本次与交接文档的差异见 [docs/SOURCES.md](docs/SOURCES.md)。上述配置尚无真实宿主运行证据。

## 图标与卡片语言

Magpie 的插件列表 / 详情页图标通过 `package.json` 的 `magpie.icon` 提供，提供商与额度页面通过 `auth.icon` 提供；两处均使用随包附带的同一份 Coarena 官网 SVG data URI，显示时无需再请求官网。结构检查会核对两处与本地资源一致。图标沿用官网的明暗主题样式。OpenCode 当前没有读取这些 Magpie 图标字段，实际图标展示取决于宿主支持。

额度卡片**默认简体中文**，支持切换为英文。在 Magpie 的 Coarena 提供商编辑页，开启 **“用英文显示额度卡片”** 并保存，再刷新额度即可；关闭后恢复中文。金额、预占、剩余、套餐、请求次数、速率、申请状态和插件错误提示一同切换，服务端错误码和原始安全错误消息保留原文。切换语言复用同一账号的 30 秒额度缓存，无需额外请求 `/limits`。

当前 Magpie 的额度 hook 不提供界面语言，也不接收卡片的多语言字典，因此卡片语言由上述开关决定，**不会自动跟随界面语言**。旧宿主若不支持插件选项，会保持默认中文。登录标签和开关标签使用宿主原生多语言字段，按宿主界面显示中文或英文；额度卡片本身提供简体中文与英文。OpenCode 不提供 Magpie 的额度卡片。

## 模型、缓存与额度

- 模块导入及 config 完全离线，使用带来源日期的 20 模型 bootstrap；已有 `coarena` 配置通过 `??=` 保留。
- 公开 `/models` 请求不附带 Key。成功结果缓存 5 分钟，失败退避 15 秒；失败保留上次成功目录或 bootstrap，并向宿主标记回退。有效空目录会清空模型。退休模型不列出，别名不重复列出。
- v2 在 setup、重新加载插件、账号变化时读取目录；TTL 仅控制这些读取，不是后台刷新定时器。凭据未变化的长期会话可通过重新加载更新。
- 工具和图片能力只接受服务端明确的 `true`。`efforts` 保留为元数据；虽然离线 SDK 测试确认 `reasoningEffort` 可序列化为 `reasoning_effort`，宿主的变体到请求映射仍待验证，因此首版不提供推理强度选项。
- 未知 token 限额在业务模型中保留为 `0`；v2 继承参考桥接的默认值：context 为 128000，output 为 8192。这是客户端默认，不是官方模型承诺。非零价格单位未知时不推算价格；宿主仍可能把缺失价格显示为 0，runtime cache read/write 的 0 也是宿主默认。
- `auth.usage` 只读取 `/limits`。额度成功缓存 30 秒，按完整 Key 的 SHA-256 摘要隔离；到期失败返回明确错误，不把旧额度标作新读取成功。
- 每日额度的 `amount = used_usd + held_usd`，进度 `used` 是 0–100 的百分比，预占不会重复扣减。显示服务端剩余金额；缺少字段显示“未知”（英文为 `unknown`），不视为零。零额度显示无可用额度；超额时保留原始 amount。
- 额度是每日重置的 USD 使用上限，不是永久钱包。有限每日次数单列；RPM、并发和申请状态仅作说明。授权有效期与每日重置时间分开显示。
- 模型目录和额度辅助读取超时为 15 秒，并支持独立取消；该超时不施加到推理流。

## 故障处理

| 现象 | 处理 |
| --- | --- |
| 401 且明确 `invalid_api_key` / revoked / expired | 宿主标记凭据失效，重新输入 Key |
| 401 `conflicting_credentials` 或 `api_keys_disabled` | 检查冲突的鉴权配置或服务状态；保留凭据 |
| 403 scope / account 问题 | 检查 Key 权限和账号状态；保留凭据 |
| 429 额度、频率或并发限制 | 查看错误码、`Retry-After` 和重置时间，等待或到账号页检查；不自动重试推理 |
| 5xx、网络错误、超时、非法响应 | 额度显示读取错误；目录使用回退；保留凭据 |
| 模型列表看起来过旧 | 重新加载插件，结合 5 分钟缓存与 15 秒失败退避判断 |

读取错误保留安全的 HTTP 状态、错误码、请求 ID 和重试提示，过滤 Key / Authorization。目录诊断不输出响应体。请勿将 Key 放进命令参数、issue、日志或截图。

## 开发与验证

仓库开发与测试需要 Bun。获取源码后在本地安装开发依赖；在 Magpie 中开发可用 `magpie plugin add "$PWD"` 加载当前目录。

```sh
git clone https://github.com/Mars-Sea/coarena.git
cd coarena
npm ci
bun test
bun run check
npm run check:node
npm run check:package
npm pack --dry-run
```

GitHub CI 在 Node 22 / 24 上执行离线验证；`prepublishOnly` 在发布前执行测试、Node 检查与实际解包检查。`npm run check:package` 使用临时目录，不访问服务或读取真实 Key。

npm 发布由 GitHub Actions 的 **Publish npm** workflow 负责：稳定版 GitHub Release 触发 OIDC 可信发布并生成 provenance，手动运行只验证和 dry-run。首次可信绑定及实际 CI 发布结果见 [发布流程](docs/RELEASING.md) 与 [分发记录](docs/DISTRIBUTION.md)。

`bunfig.toml` 将默认测试限定在 `tests/`，不运行 `docs/reference` 下的参考插件测试。默认测试不读取真实凭据；网络守卫只允许合成服务的 `127.0.0.1` HTTP，其余请求全部拒绝。SDK `2.0.41` 仅为开发依赖，用于匹配参考桥接；宿主负责实际 SDK 的加载。

`bun run bootstrap` 从已归档的公开 `docs/reference/coarena/models.json` 重建 bootstrap，不访问网络。包清单仅含运行时模块、官网 SVG、bootstrap、README 与许可证，不含参考仓库、测试、缓存或凭据文件。开发 SDK 的已知审计结果、确切测试版本与尚未验证项见 [验证报告](docs/VALIDATION.md)。

真实 `/limits`、两家厂商推理、宿主加载、代理和账号切换仍需用户提供测试环境后验收；当前离线测试不能代替这些结果。

## 资料与许可

- [PRD](PRD.md)、[插件契约](docs/PLUGIN-CONTRACT.md)、[接口映射](docs/API-MAPPING.md)、[实施与实机验收步骤](docs/IMPLEMENTATION-PLAN.md)。
- [来源与版本](docs/SOURCES.md)、[验证报告](docs/VALIDATION.md)、[变更记录](CHANGELOG.md)。

插件实现使用 [MIT](LICENSE)。OpenCode 2 桥接基于 `magpie-community/plugins` 固定提交 `67532718612ec086606e0830b7a848b892aef672` 的完整适配器修改，保留原版权。Coarena 的 API 元数据、公开资料和 `assets/coarena.svg` 品牌图标归原权利方，本仓库不对其另授 MIT 许可。
