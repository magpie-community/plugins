# magpie-relay-auto

magpie 通用供应商插件：接入任意 OpenAI 兼容中转站，自动补全模型的上下文窗口。

中转站的模型名往往带前缀（`[free]gpt-6-astra`、`[ant]claude-opus-4-6`），和 models.dev 上的标准名对不上，
导致 magpie 查不到上下文窗口，显示 `unknown`。这个插件负责把名字还原成标准名再去匹配。

## 功能

- 拉取中转站的 `/v1/models`，列出全部模型，而不是只显示手动挑的那几个。
- 剥掉前缀（`[free]`、`[ant]`、`[次]` 等）和后缀（`-thinking`、`-latest`、`-2026-09` 等），
  再到 models.dev 匹配标准模型，自动填上 `limit: { context, output }`、推理支持、价格。
- 带免费前缀的模型标记为 `free: true`，不占额度。
- 匹配不到的模型照常列出，只是没有窗口信息，可以再手动 `magpie model context` 补。
- 自带「中转规则」设置页，前缀、后缀、别名映射、免费标记都能在界面里改，不用碰配置文件。

## 安装

```bash
magpie plugin add magpie-relay-auto
```

也可以从本地文件夹安装：

```bash
magpie plugin add ./magpie-relay-auto
```

插件没有默认目标，装上后先配置自己的中转站（`id` 和 `api` 必填，`name` 可选）：

```bash
magpie plugin options magpie-relay-auto '{"id":"myrelay","name":"我的中转","api":"https://example.com/v1"}'
magpie provider test myrelay
```

改完 options 后把插件 off/on 一次让配置生效：

```bash
magpie plugin off magpie-relay-auto
magpie plugin on magpie-relay-auto
```

## 遇到新格式不用改代码

所有匹配规则都在 options 里，按需覆盖，没写的项用默认值：

```json
{
  "id": "myrelay",
  "api": "https://example.com/v1",
  "prefixes": ["free", "vip", "试用"],
  "suffixes": ["thinking", "latest", "\\d{4}-\\d{2}"],
  "aliases": { "sonnnet-4-6": "sonnet-4-6", "my-custom-name": "gpt-6-astra" },
  "freeTag": "free"
}
```

| 字段 | 说明 |
| --- | --- |
| `prefixes` | 要剥掉的 `[xxx]` 前缀列表，遇到新前缀加一个词即可 |
| `suffixes` | 要剥掉的后缀，正则片段，如 `-thinking`、`-2026-09` |
| `aliases` | 中转站模型名到 models.dev 标准名的精确映射，用于拼写不同或完全改名的模型 |
| `freeTag` | 哪个前缀算免费额度，默认 `free` |

这些也能在插件的「中转规则」页面里改：前缀和后缀是胶囊标签，点 ✕ 删除、点 ＋ 添加、
点标签文字原地编辑；别名映射是两列输入框。改完点「保存并生效」，插件会按新规则重新匹配模型。

## 登录信息

本插件不涉及登录，不保存任何密钥。API key 由 magpie 自身的供应商配置管理。

## 许可

MIT
