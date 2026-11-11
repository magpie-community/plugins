# OpenCode Go 生图

Magpie 工具插件，包名 `magpie-opencode-go-image`。它把本机 Magpie gateway 上的 OpenCode Go Responses API `image_generation` 包成两个工具，经 Magpie MCP `/mcp/magpie/tools` 给任意 Agent 调用。

界面显示名（`package.json` 的 `magpie.name`）是「OpenCode Go 生图」。插件 id 是目录名或包名 `magpie-opencode-go-image`。

计费走 Magpie / OpenCode Go 的额度。这个插件不申请、不保存 OpenCode Go 的密钥，也没有登录、Provider 或 Middleware。回环地址不带 `Authorization`。只有 gateway 不在本机时，才在插件选项里填 `bearer` 或 `apiKey`。

本机 Magpie 使用默认端口时不用写 options。每次工具调用再决定 gateway 地址。

## 工具

工具键就是 `luna_image` 和 `grok_image`。Magpie 对外的 MCP 名是 `<插件短名>_<工具键>`。从名为 `magpie-opencode-go-image` 的目录安装时，短名就是这个目录名：

| 工具键 | MCP 名 | 模型 | 落盘 |
| --- | --- | --- | --- |
| `luna_image` | `magpie-opencode-go-image_luna_image` | 默认 `opencode-go/gpt-6-luna`，可选 `opencode-go/gpt-5.6-luna` | PNG，约 1254×1254 |
| `grok_image` | `magpie-opencode-go-image_grok_image` | 固定 `opencode-go/grok-4.7` | JPEG，约 1408×1408 |

发给 Magpie 的模型名都带 `opencode-go/` 前缀。`luna_image` 可以收裸 id `gpt-6-luna` 或 `gpt-5.6-luna`，插件会补成 `opencode-go/gpt-6-luna`、`opencode-go/gpt-5.6-luna`。其他 Luna 模型 id 会直接报错。不带前缀的 `grok-4.7` 会被 Magpie 送到 Zen，返回 401，所以 `grok_image` 只发 `opencode-go/grok-4.7`。

## 安装

在本仓库根目录（目录名请保持 `magpie-opencode-go-image`）：

```sh
magpie plugin add /absolute/path/magpie-opencode-go-image
magpie plugin --json
```

`--json` 里不应出现这个插件的 `plugin:` 加载错误。装好后在 Magpie 里打开该插件，或新开一个 Agent 会话，MCP 服务器地址是：

```text
http://127.0.0.1:3425/mcp/magpie/tools
```

本包尚未发布到 npm。不要把密钥写进仓库。

## Gateway 地址

每次调用 `luna_image` 或 `grok_image` 时重新解析 gateway 根地址，然后 `POST {地址}/v1/responses`。顺序是：

1. 插件选项里的 `baseUrl`，非空才算。可以是 `http`/`https` URL，也可以是 `host:port`。末尾的 `/` 或 `/v1` 会去掉。
2. 环境变量 `MAGPIE_ADDR`。同样接受 `host:port` 或完整 URL。每次调用都读当前值。
3. `http://127.0.0.1:3425`。

插件不扫描端口，也不读 Magpie 配置文件。本机默认端口因此不用填 options。`timeoutMs` 默认 `120000`，也不必写进 options。

Magpie 改了监听端口之后，需要重启 Magpie，或重载插件宿主，新的 `MAGPIE_ADDR` 才会进入这个进程。如果 Magpie 在运行中改端口、宿主没有重载，请求仍可能打到旧地址。

选项里写了 `baseUrl` 时，以该值为准，不会跟着 `MAGPIE_ADDR` 变。要改这个覆盖，改选项并重载插件宿主。

## 选项

选项是插件函数的第二个参数，也就是 `plugins.json` 里该条目的 `options`。本机默认免配。只有要覆盖地址、令牌或目录时才写：

```sh
magpie plugin options magpie-opencode-go-image '{"baseUrl":"http://192.168.1.20:3425","bearer":"GATEWAY_KEY"}'
```

`bearer` 和 `apiKey` 二选一。同时存在时用 `bearer`。

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `baseUrl` | 空 | 非空时固定 gateway 根地址，盖过 `MAGPIE_ADDR` 和 `http://127.0.0.1:3425`。 |
| `bearer` | 空 | 可选。非空时加 `Authorization: Bearer`。 |
| `apiKey` | 空 | 与 `bearer` 相同，未填 `bearer` 时使用。 |
| `outDir` | 空 | 默认保存目录。空则写到 Agent 工作目录下的 `opencode-go-images/`。 |
| `timeoutMs` | `120000` | 单次请求超时，整数毫秒，范围 1000–600000。不写就用默认。 |

单次调用的 `out_dir` 覆盖 `outDir`。绝对路径按原样使用，相对路径相对 Agent 目录（`ctx.directory`）。

## Luna 与 Grok

两边都是 `POST {baseUrl}/v1/responses`，`Content-Type: application/json`，`store: false`。`tools[0].type` 固定是 `image_generation`。调用方如果还传了尺寸或质量，才会多出 `size`、`quality`。Luna 在带参考图且 `edit` 为 true 时才会多出 `action: "edit"`。

Luna（默认 `opencode-go/gpt-6-luna`，或 `opencode-go/gpt-5.6-luna`）额外带：

```json
{ "tool_choice": { "type": "image_generation" } }
```

Grok（`opencode-go/grok-4.7`）的请求体里没有 `tool_choice`。Magpie 对这个模型的 `tool_choice` 返回 **422** `Endpoint is unavailable`。

不调用 `/v1/images/generations`。不请求 GIF。Luna 收到 GIF 请求时会 400，`GIF output is not enabled`。插件若在响应里看到 GIF，会直接报错，不落盘。参考图里的 GIF 同样会在组包前拒绝。

直连 OpenCode Go（绕过 Magpie）用的是另一套地址和 `x-opencode-session`，模型名不带前缀。本插件只走 Magpie。

没有参考图时，`input` 就是 prompt 字符串：

```sh
# Luna
curl -sS http://127.0.0.1:3425/v1/responses \
  -H 'content-type: application/json' \
  -d '{"model":"opencode-go/gpt-6-luna","input":"a red circle on white","tools":[{"type":"image_generation"}],"tool_choice":{"type":"image_generation"},"store":false}'

# Grok：不要加 tool_choice
curl -sS http://127.0.0.1:3425/v1/responses \
  -H 'content-type: application/json' \
  -d '{"model":"opencode-go/grok-4.7","input":"a blue square on white","tools":[{"type":"image_generation"}],"store":false}'
```

这两条会打到正在运行的 Magpie，测试脚本不会调用它们。

有参考图时，`input` 改成一条用户消息。`content` 里先是一条 `input_text`（prompt），再按 `image` 的顺序每张参考图一条 `input_image`。`image_url` 只能是 `https://…` 或 `data:image/png;base64,…` / `data:image/jpeg;base64,…`。本地路径不会出现在请求体里。

`image` 可以是一个字符串，也可以是字符串数组。单个字符串会当成只有一张的数组，旧调用不用改。空数组和省略一样，不带参考图。最多 4 张；超过 4 张会在读文件和请求发出之前报错。

```json
{
  "model": "opencode-go/gpt-6-luna",
  "input": [
    {
      "type": "message",
      "role": "user",
      "content": [
        { "type": "input_text", "text": "make the circle blue" },
        { "type": "input_image", "image_url": "data:image/png;base64,…" },
        { "type": "input_image", "image_url": "https://cdn.example/second.png" }
      ]
    }
  ],
  "tools": [{ "type": "image_generation", "action": "edit", "size": "1024x1024", "quality": "high" }],
  "tool_choice": { "type": "image_generation" },
  "store": false
}
```

上面是 Luna，并且这次调用传了 `edit: true` 和两张参考图，所以带了 `action`，`content` 里有两条 `input_image`。`action` 只在 `edit: true` 且至少有一张参考图时出现。Grok 带参考图时用同一条 `input`，请求体里仍然没有 `tool_choice`，也没有 `action`。Grok 的每张参考图宽和高都要至少 8 px。

## 参数与返回

`luna_image` 和 `grok_image` 共有：

- `prompt`（必填）：画面描述。`grok_image` 带了 `previous_response_id` 时，这是修改说明。
- `image`（可选）：参考图。一个字符串，或最多 4 个字符串的数组。单个字符串等于只传一张，和以前一样。空数组等于不传。每一项是本地文件路径、`https://` URL，或 `data:image/png;base64,…` / `data:image/jpeg;base64,…`。本地文件按文件头识别，只接受 PNG 和 JPEG，再写成 data URL。GIF 直接拒绝。`http://` 和 WEBP 不接受。超过 4 张会在读文件和请求发出之前报错。数组顺序就是请求里 `input_image` 的顺序。Grok 要求每张参考图的宽和高都至少 8 px。
- `size`（可选）：只接受 `1024x1024`，写入 `tools[0].size`。不传则省略。
- `quality`（可选）：`low` 或 `high`，写入 `tools[0].quality`。两个工具都收这两个值。Magpie 上已确认 Luna 的 `low` / `high`，以及 Grok 的 `high`。不传则省略。
- `out_dir`（可选）：这一张图的目录。

`luna_image` 另外：

- `model`（可选）：默认 `opencode-go/gpt-6-luna`。也可以写 `gpt-5.6-luna` 或 `opencode-go/gpt-5.6-luna`（裸 id 会补上 `opencode-go/`）。`gpt-6-luna` 同样会补成默认 id。除此之外的值会报错，请求不会发出。两种 Luna 模型都带 `tool_choice: { type: "image_generation" }`。
- `edit`（可选，布尔）：为 true 且至少有一张参考图时，`tools[0].action` 为 `"edit"`。默认 false，不写 `action`。没有参考图时（省略 `image`，或空数组）传 `edit: true` 会报错。

`grok_image` 另外：

- `previous_response_id`（可选）：上一次 `grok_image` 返回的 `response_id`，用于多轮改图。可以和 `image` 同时出现，一张或多张都可以；参考图不会顶替它。

## 不支持

这些 Magpie 不接受，插件不会代发：

- `n`，以及任何一次出多张的张数。Luna 会 400，`Unknown parameter`。Grok 可能 200，但响应里没有 `image_generation_call`。调用参数里如果带了 `n`，请求不会发出。
- `luna_image` 的 `previous_response_id`。`store` 始终是 `false`。Magpie 拒绝 `store: true`（`OpenCode doesn't store responses`）。`store: false` 再带 `previous_response_id` 会 400（`Items are not persisted when store is false`）。多轮 id 只给 `grok_image`。
- `512x512`。Luna 会 400，低于最小像素预算。schema 里只有 `1024x1024`。
- GIF，无论是生成结果还是参考图。
- Grok 的 `tool_choice`。
- `/v1/images/generations`。

成功时返回 JSON。`path` 是绝对路径，`note` 是一行摘要（格式、像素、字节数、毫秒）：

```json
{
  "path": "/abs/opencode-go-images/luna-20261105T043200000Z-ab12cd.png",
  "paths": ["/abs/opencode-go-images/luna-20261105T043200000Z-ab12cd.png"],
  "note": "PNG 1254×1254, 180432 bytes, 9841 ms",
  "response_id": "resp_…",
  "model": "opencode-go/gpt-6-luna",
  "mime": "image/png",
  "width": 1254,
  "height": 1254,
  "bytes": 180432,
  "ms": 9841
}
```

Grok 改图时把上一张的 `response_id` 传给下一次 `previous_response_id`。

失败信息会写明原因：非 2xx（含响应摘要）、422（以及这次请求有没有带 `tool_choice`）、超时、响应里没有 PNG/JPEG、以及 GIF。

## 响应解析

从 Responses 的 `output` 里找 `type === "image_generation_call"`。`result` 可以是：

- 裸 base64
- `data:image/png;base64,…` 或 `data:image/jpeg;base64,…`
- 含 `b64_json` / `url` 的对象
- 上面几种的 JSON 字符串，包括套了一层字符串的调用项

图片按文件头保存：PNG、JPEG，以及仍是静图的 WEBP。扩展名跟文件头走，不跟模型名猜测。像素尺寸从 PNG 的 IHDR 和 JPEG 的 SOF 读取。

默认文件在 Agent 目录的 `opencode-go-images/`。`luna-*.png`、`grok-*.jpg`。

## 开发

需要 Node.js 18 或更新。测试只用本地 fixture 和假的 `fetch`，不会连接 Magpie。

```sh
npm test
```

入口 `index.mjs` 只导出一个异步插件函数 `MagpieOpenCodeGoImage`，返回 `{ tool: { luna_image, grok_image } }`。工具的 `args` 是 JSON Schema，没有 zod，也没有 `@opencode-ai/plugin`。解析、请求和落盘在 `src/`。
