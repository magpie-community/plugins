# magpie-newapi

给 [magpie](https://usemagpie.ai) 用的 [New API](https://github.com/QuantumNous/new-api)（以及同源的 One API）供应商插件。

把中转站的 **Base URL + API Key** 加成一个 magpie 账号，多个账号会自动汇成同一个模型池，由 magpie 做负载与故障切换；每个账号还能用可选的**系统访问令牌**读出钱包余额与订阅余量，显示在账号行、`magpie quota` 和网关的 `GET /v1/magpie/quotas` 里。

## 功能

- **一个账号 = 一个完整实例**：`Base URL + API Key`，可选再填一个**系统访问令牌**只用于查余额。
- **多账号、同一模型池**：同一个 provider 下登录多次，每个账号用自己的 `baseURL + apiKey`，它们一起提供同一批模型，magpie 在它们之间路由；401 标记重登，限流/5xx 转到下一个。
- **余额 / 订阅余量**：填了系统访问令牌就显示；不填就只做模型。
- **可选按站点分组**：选项里列出站点，每个站点变成独立 provider。

## 图标

插件图标是 `assets/logo.png`（180×180 PNG），以 `data:image/png;base64,…` 内嵌在 `package.json` 的 `magpie.icon` 里。magpie 的 `magpie.icon` 只接受 `https://` 地址或 `data:image/…` URI，不读本地路径，所以内嵌既保持“本地保存、不依赖网络”，又能被 magpie 读到。

换图标：

```bash
cp 新图标.png ~/Code/magpie-newapi/assets/logo.png
cd ~/Code/magpie-newapi
python3 - <<'EOF'
import base64, json
uri = "data:image/png;base64," + base64.b64encode(open("assets/logo.png","rb").read()).decode()
d = json.load(open("package.json")); d["magpie"]["icon"] = uri
json.dump(d, open("package.json","w"), indent=2, ensure_ascii=False); open("package.json","a").write("\n")
EOF
```

之后在应用里把插件关掉再打开即可生效。

## 安装

```bash
# 从 npm（发布后）
magpie plugin add @jingyi0605/magpie-newapi

# 从 GitHub
magpie plugin add github:jingyi0605/magpie-newapi

# 从本地文件夹（开发时，就地加载）
magpie plugin add ~/Code/magpie-newapi
```

在 magpie 应用里：打开「插件」→「添加插件」，填文件夹路径或包名。

## 添加账号（一次填完一个实例）

只有一种登录方式 **New API API key**，按这个顺序问：

| # | 问题 | 填什么 |
| --- | --- | --- |
| 1 | New API address | 站点地址，如 `https://api.example.com`（带不带 `/v1` 都行） |
| 2 | API key | 这个实例的中转站 **`sk-…`** |
| 3 | System access token | **可选**。填了才显示余额/订阅；留空只做模型 |
| 4 | User id | 仅当第 3 项填了、且用的是**旧版访问令牌**时才出现 |

所以一个账号 = `baseURL` + `API Key`（+ 可选访问令牌）。要加第二个实例，在同一个 New API 下再点「添加另一个 New API 账号」，填另一组即可（同一站点的另一把 Key，或另一个站点）。

**登录时就会校验**：API Key 会先请求 `/v1/models`，访问令牌会先请求 `/api/user/self`；任何一个不对都会当场报错，不会存下一个坏账号。

命令行等价（每行一个答案，顺序同上）：

```bash
# 只有模型
printf 'https://站点\nsk-你的key\n\n\n' | magpie plugin login newapi

# 带余额（第 3 行填访问令牌，第 4 行填 user id 或留空）
printf 'https://站点\nsk-你的key\nnap_你的令牌\n\n' | magpie plugin login newapi
```

> 为什么用 oauth 方式而不是 api 方式：magpie 的 api 方式会把 Key 输入框**排在所有提问之后**，无法做到「地址→Key→令牌→userid」；oauth 方式没有 Key 输入框，插件在 `authorize` 的自动回调里拿到全部答案并校验，最后把 API Key 交回给 magpie 保存。

## 余额和订阅怎么算

- 余额：`GET /api/user/self` 的 `quota` ÷ `/api/status` 的 `quota_per_unit`，按站点货币符号显示。
- 订阅：`GET /api/subscription/self`，每个仍在有效期内的订阅是一个窗口，显示「已用 / 总额」、百分比、下次重置时间；套餐名从 `/api/subscription/plans` 取。
- 站点把货币符号设成 `¤` 这种占位符时，显示成 `$`。
- **余额制站点只显示「余额」**，不画额度条：钱包没有上限，做成窗口会被 magpie 画成「剩余 100%」，那是假的。只有站点真的有订阅额度（`amount_total`）时才生成窗口。

## 一条记录还是多条记录？命名与模型组合

magpie 里「供应商」列表的每一行 = 一个 provider id。**每个 provider 的显示名和它提供的模型子集，都在 magpie 自己的供应商设置里单独保存**（`providers.json` 的 `name` / `models` / `pickedFrom`），所以你可以：

- 在供应商设置里**改这一行的名称**；
- 用「仅所选 / 全选 / 全不选」**勾选它对外提供哪些模型**（这就是「不同的模型组合」）；
- 用弹窗里的「复制」复制一份，再改成另一组模型。

插件负责的是**提供几条 provider 记录**，有两种模式：

### 模式 A：单条记录（默认，不写 options）

只有一条 `newapi`，所有登录的实例作为账号挂在它下面，模型是所有账号的并集。适合「一个池子」。

### 模式 B：多条记录（写 `sites`）

每个 site 是一条独立记录，可以各自命名、各自限定模型：

```json
{
  "sites": [
    { "id": "claude-pool", "name": "Claude Pool", "models": ["claude-*"] },
    { "id": "codex-pool",  "name": "Codex Pool",  "models": ["gpt-*", "codex-*"] },
    { "id": "gap-claude",  "name": "GAP-Claude",  "url": "https://api.example.com", "models": ["claude-*"] }
  ]
}
```

```bash
magpie plugin options magpie-newapi '{"sites":[...]}'
magpie plugin options magpie-newapi off      # 清掉，回到单条记录
```

每个 site 的字段：

| 字段 | 含义 |
| --- | --- |
| `id` | provider id（小写字母/数字/`-`/`_`，≤40）。也是 agent 里 `<id>/<model>` 的前缀 |
| `name` | 这一行显示的名字，可写中文；不写就用 `id` |
| `url` | 站点地址。**可省略**——省略时这个 provider 只定义「名称 + 模型组合」，每个账号登录时自己填地址 |
| `models` | 只暴露匹配的模型。支持精确 id、`claude-*` 前缀、`/正则/` |
| `exclude` | 排除匹配的模型（优先级高于 `models`） |

所以想要「同一个站点，Claude 一行、Codex 一行」，就是两条 `sites`（可以同一个 `url`，也可以都不写 `url` 让账号自己带地址）。

显示名由插件提供：默认 provider 叫 **New API**，站点模式用 `sites[].name`（可写中文）。所以「newapi 实例的名称」可以在 `sites` 里改；单条记录模式下想改名，加一个 `sites` 条目即可（哪怕只写一个）。

> magpie 在加载插件时就固定了 provider 列表，插件无法在运行时新增记录，所以「多条记录」必须用 `sites` 声明。站点模式下登录不再询问地址（除非该 site 没写 `url`）。

## 模型与协议

协议由**插件**决定（magpie 不替插件选）：每个模型对象都带 `api.npm` / `api.url`，magpie 照着发。

优先级：

1. **中转站自己的提示**：`GET /v1/models` 里每个模型的 `supported_endpoint_types`（`openai` / `openai-response` / `anthropic` / `gemini` …）。
2. 没有提示时按模型名猜。

| 端点 | AI SDK 包 | 路径 |
| --- | --- | --- |
| `anthropic` | `@ai-sdk/anthropic` | `/v1/messages` |
| `openai-response` | `@ai-sdk/openai` | `/v1/responses` |
| `openai` | `@ai-sdk/openai-compatible` | `/v1/chat/completions` |

只支持非对话端点（`embeddings`、`image-generation`、`jina-rerank`、`openai-video` …）的模型会被过滤掉，不出现在模型列表里。

例子：某站点把 `gpt-6-sol` 标成只支持 `openai`，插件就走 `/v1/chat/completions`（而不是按名字猜的 `/v1/responses`）；`claude-*` 标了 `anthropic` 就走 `/v1/messages`。

**models.dev 只用于补全元数据**：上下文/输出长度、是否推理、推理档位、思考字段（`interleaved`）。每天最多取一次，缓存在本地；取不到就按名字判断，不影响模型可用性。协议不依赖 models.dev。

## 凭据存在哪

- Key、访问令牌、密码都只存在 magpie 的 `plugin-auth.json`（权限 600），和 magpie 自己保存登录信息的方式一致。
- 密码模式下，登录得到的临时令牌（约 15 分钟）会缓存在账号 metadata 里，过期后自动重新登录。
- 插件不会把任何内容写到别处；`models.dev` 的缓存写在 `~/.cache/magpie-newapi/`。

## 测试

```bash
npm test        # 内置 mock New API 的单元测试
```

沙箱里试：

```bash
sb=$(mktemp -d)
m() { env HOME=$sb XDG_CONFIG_HOME=$sb/.config XDG_CACHE_HOME=$sb/.cache MAGPIE_ADDR=127.0.0.1:3499 magpie "$@"; }
m plugin add ~/Code/magpie-newapi </dev/null
m plugin login newapi
m plugin
m quota
m provider test newapi <model>
```

## 已知限制

- 余额/订阅只能通过**系统访问令牌**读取（个人设置 → 安全设置生成）；中转站 Key 本身不能读控制台接口。
- 站点如果只给“图片/嵌入”等非对话模型，那些模型会被过滤掉，不显示。
- 旧版访问令牌查余额需要填 `User id`；新版 `nap_…` 令牌不需要。

## License

MIT
