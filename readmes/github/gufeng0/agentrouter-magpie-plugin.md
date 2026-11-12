# magpie-plugin-agentrouter

给 [magpie](https://github.com/yetone/magpie) 用的 **AgentRouter** 插件：完整模型供应商（Responses API）、请求改写、内容过滤、余额/用量和每日签到。

一个 provider、一个账号同时保存两样凭据：

- **站点用户名/密码**：登录、每日签到和余额；
- **模型 API Key**：登录后从账号的 `/api/token/` 列表**自动读取**，不需要手动输入。
- 它们属于同一个 AgentRouter 账号，所以账户和 Key 是对应的。

**没有 GitHub 授权**，也没有本地 GitHub Cookie 签到工具。

固定使用国内站 `ps.air-outer.com`，不再询问站点。

## 功能

- **模型供应商 `agentrouter`**：`gpt-5.6-sol`、`gpt-6-astra`、`gpt-6.1-sol`；站点只服务 Responses API，magpie 会把 agent 的 Chat / Anthropic 请求翻译成 Responses。
- **请求头**：网关只认自己的客户端标识，默认发 Codex CLI 的 `User-Agent: codex_cli_rs/0.101.0`；可在供应商/账号级覆盖，开关 `send-codex-headers` 可以关掉默认头。
- **Responses 请求改写**：`portable-responses` 把完整的 Responses item 内联重放，去掉只对某个后端有意义的 id/加密状态，保留 `call_id`、工具数据和加密内容；只有引用、没有内联内容的历史仍需要原资源。
- **Azure 资源绑定状态清理**：默认去掉 `previous_response_id`、reasoning/encrypted_content 和 item id，避免多资源负载均衡时报 “different Azure OpenAI resource”。
- **内容过滤**：读取插件目录下的 `content-filter.local.json`，只过滤你自己配置的词，不猜词；保留代码块、工具数据和加密状态。开关 `text-filter`。
- **余额/用量**：`/api/user/self` 的 `quota` 和 `used_quota` 折算成美元；只使用保存的 Cookie/访问令牌，不会为读额度重新登录。没有有效凭据时按 Key 读累计消耗，不编造剩余余额；Cookie 失效后等下次签到刷新。
- **每日签到**：站点没有 `/api/user/checkin`，登录一次就是签到。`checked_in: true` → `claimed`（本次发了当天额度）；`false` → `done`（本次未新增，通常今天已领过）；缺失/非布尔 → `failed`（稍后重试）。

## 安装

```bash
magpie plugin add github:gufeng0/agentrouter-magpie-plugin
```

本地开发时也可以直接装目录：

```bash
magpie plugin add /path/to/AgentRouter
```

> 这个插件使用 provider id `agentrouter`。如果还装着 `opencode-agentrouter-auth`、`agentrouter-magpie` 或其他占用 `agentrouter` 的插件，先移除它们，否则会互相抢同一个 provider：
> ```bash
> magpie plugin rm opencode-agentrouter-auth
> magpie plugin rm 22952497/agentrouter-magpie
> ```

你已有的 `Agent Router custom`（`agent-router`）如果也是同一个站点，会和这个插件重复列出 3 个模型；可以保留、停用或删除其中一个。

## 请求头

登录不再询问请求头，默认就发 Codex 客户端标识。

要改请求头，用 **供应商编辑器 → 高级 → Headers**（保存为供应商配置）。优先级从低到高：

1. 插件的默认头（Codex 客户端标识）；
2. 供应商/模型 Headers；
3. 账号 Headers（高级里可写）；
4. 你在 Headers 里设置的 `User-Agent` 始终最高。

magpie 对插件账号不显示原生的「发送 Agent 自己的 User-Agent」开关（那行只给内置 provider）。插件里的等价开关是 **发送 Codex 客户端 User-Agent**：

- 开：按 Codex CLI 发送 `User-Agent`；
- 关：保留 Agent 自己的 `User-Agent`；
- Headers 里设置的 `User-Agent` 两种情况下都优先。

## 登录（站点账号；模型 Key 自动读取）

```bash
magpie plugin login agentrouter
```

依次询问：

1. **站点用户名或邮箱**
2. **站点密码**

不再询问模型 API Key。登录成功后插件会：

1. 用站点账号登录，拿到会话和用户 ID；
2. 调 `GET /api/token/` 读取这个账号自己的模型 Key；
3. 选一把**启用、完整、未过期、剩余额度最多**的 Key 保存；
4. 站点用户名/密码和 Key 写进同一个账号记录。

如果账号下没有可用的模型 Key，登录会提示先去站点「令牌」页创建一把。模型请求用自动读到的 `key`；签到和余额用 `metadata.username` / `metadata.password`。

> 如果账号是用第三方方式注册、站点没有密码，先到登录页点「忘记密码」用邮箱设一个站点密码。

登录后打开：

**设置 → 额度 → 预热与签到 → 插件 → AgentRouter**

把每日签到开关打开。

## 模型

Base URL 固定为 `https://ps.air-outer.com/v1`，模型名形如：

```text
agentrouter/gpt-5.6-sol
agentrouter/gpt-6-astra
agentrouter/gpt-6.1-sol
```

客户端仍然可以用 Chat Completions 或 Anthropic Messages；magpie 负责翻译成 Responses。

## 内容过滤

复制示例并填自己的词：

```bash
cp content-filter.example.json content-filter.local.json
```

```json
{
  "terms": ["your-private-term"]
}
```

改完重启 magpie（或重新加载插件）生效。`content-filter.local.json` 只放本机，不要提交到仓库。

## “The requested item was created under a different Azure OpenAI resource”

AgentRouter 在多个 Azure OpenAI 资源之间负载均衡。上一轮的：

- `previous_response_id`
- `reasoning` / `encrypted_content`
- item id（`msg_…`、`rs_…`、`fc_…` 等）

都绑在创建它的那个资源上；下一轮被路由到另一个资源时，就会报这个错。

插件的 **去掉 Azure 后端绑定状态**（`drop-azure-state`，默认开启）会在发送前移除这些绑定状态，保留：

- 消息正文；
- `function_call` / `function_call_output` 的 `call_id`；
- 工具名和参数。

代价是隐藏思维链不再跨轮延续，每一轮重新推理；对话内容和工具调用不受影响。

如果请求里只有 `previous_response_id` / `item_reference`，没有完整的内联历史，插件无法无损恢复，需要客户端重发完整历史，或开新会话。

## 配置与凭据

- 插件登录信息在 `~/.config/magpie/plugin-auth.json`（权限 `0600`）：
  - `key`：从账号 `/api/token/` 自动读取的模型 API Key；
  - `metadata.site`：站点；
  - `metadata.username` / `metadata.password`：站点登录，用于签到和读取模型 Key；
  - `metadata.cookie` / `metadata.userId`：登录或签到时站点下发的会话；余额读取只用它，不会为读额度重新登录，失效后等下次签到刷新。
- 内容过滤词表 `content-filter.local.json` 在插件目录，只在本机读取。

## 测试

```bash
node --test *.test.mjs
```

当前 164 个测试通过，覆盖请求改写、内容过滤、Responses 保留、流式边界、余额和签到语义。

## 来源

基于 [ZhaoJun233/agentrouter-magpie-plugin](https://github.com/ZhaoJun233/agentrouter-magpie-plugin)（MIT）和 [22952497/agentrouter-magpie](https://github.com/22952497/agentrouter-magpie)（MIT）的实现整理；移除了 GitHub 授权、GitHub Cookie 本地签到和 Windows ACL 工具，登录改为站点账号（模型 Key 从账号 `/api/token/` 自动读取），签到语义按 `checked_in` 的本次发放标记处理。

MIT License，见 [LICENSE](LICENSE)。

## 许可、归属与声明

- 本项目使用 MIT License，原始版权与许可声明见 [LICENSE](LICENSE)；
- 代码来源于 [ZhaoJun233/agentrouter-magpie-plugin](https://github.com/ZhaoJun233/agentrouter-magpie-plugin) 和 [22952497/agentrouter-magpie](https://github.com/22952497/agentrouter-magpie)，归属说明见 [NOTICE](NOTICE)；
- 本项目与 AgentRouter 官方无关，名称只用于说明接入的服务；
- 插件会按站点要求发送 Codex 客户端请求头并自动登录签到，使用前请自行确认符合站点条款。
