# magpie-image-edit

给 agent 画图、改图的 magpie 插件：文生图和图生图（图生图）都做成 MCP 工具，**图片以 base64 交回去**。

**不需要配置文件。** 插件不说话要 key，也不给你一个 `config.json` 让你填——它直接用 magpie 自己的网关、自己的 caller key、以及你在 **设置 › 模型 › 生图** 里挑好的模型。你已经在 magpie 里配好了账号，这里就什么都不用再配。

## 装

```sh
magpie plugin add github:justforlxz/magpie-image-edit
# 或者本地：
magpie plugin add ~/Documents/magpie-image-edit
```

装完 `magpie plugin list` 能看到它，magpie 的 MCP 里就多出三个工具。

前提：设置里得有一个能画图的模型（设置 › 模型 › 生图 里选一个，或者加一个生图供应商）。没有的话工具会直接告诉你去了哪里选，而不是发一个空请求。

## 三个工具

| 工具 | 干什么 | 必填 |
|---|---|---|
| `generate_image` | 一句话画图 | `prompt` |
| `edit_image` | 拿一张或几张图改（图生图） | `prompt`、`images` |
| `image_result` | 取还没画完的那张图 | `jobId` |

`images` 里可以放**纯 base64**、`data:image/png;base64,...`、http 地址，或者本机文件路径——最后一种最适合「把刚才那张图接着改」。

回来长这样（`b64` 是完整图片，这里截断了）：

```json
{
  "status": "done",
  "model": "vendor/draw-2",
  "count": 1,
  "images": [{ "index": 0, "mimeType": "image/png", "bytes": 1438221, "b64": "iVBORw0KGgoAAAA…" }],
  "totalBytes": 1438221,
  "note": "b64 是图片本身的 base64；需要再改这张图，把它原样放进 edit_image 的 images。"
}
```

## 为什么是 base64 而不是文件路径

给 agent 一个路径，它常常读不到——不在同一个容器、沙箱或远端机器上。所以这里把字节直接塞进答复。代价是答复很大：一张 1024×1024 的 PNG 大约 1–2 MB base64。要省 token，就少要几张图，或者让模型只挑一张接着改。

## 画得慢怎么办

宿主给一次工具调用 55 秒，画图经常不止。所以：

1. 插件自己最多等 `waitSeconds`（默认 40，上限 50）；
2. 还没画完就先回 `{"status":"running","jobId":"img_…"}`；
3. 调用方过一会儿拿 `image_result` 要——**同一张图只画一次**，不会重复扣钱；
4. 十分钟还没好才算超时。

## 想换成别的网关或 key

一般不用管。真要覆盖：

| 环境变量 | 作用 |
|---|---|
| `MAGPIE_IMAGE_EDIT_GATEWAY` | 网关地址，默认 `http://127.0.0.1:3425` |
| `MAGPIE_API_KEY` / `MAGPIE_GATEWAY_KEY` | caller key，默认取 magpie 自己存的第一把 |
| `MAGPIE_IMAGE_EDIT_LOG=debug` | 把每个请求打到 stderr |

模型的挑选顺序：调用方在参数里点的 `model` → **设置 › 模型 › 生图** 里挑的 → 网关列出的第一个生图模型。网关按 OpenAI 的 `/v1/images/generations` 说话（参考图以 data URL 放进 `images`），所以任何兼容这个形状的网关都能接。

## 开发

```sh
npm test                              # node --test test/，假 fetch，不连网不花钱
MAGPIE_DIR=~/src/magpie npm run e2e   # 可选：让真的 magpie 插件宿主加载一遍（要 bun + 源码树）
```

- `lib/gateway.js`：找网关、找 key、挑模型
- `lib/ops.js`：三个工具的实现
- `lib/jobs.js`：慢图的登记表
- `index.js`：导出给宿主的那一层

MIT。
