# Request images / 请求图片

A Magpie gateway hook that keeps images from the latest request-input batch,
removes older images, and losslessly optimizes retained embedded images on
**Windows x64**. Its local page shows before/after JSON sizes and per-image
outcomes. This is a community plugin, not an official Magpie core feature.

## Install

Requires Magpie **0.1.1273 or newer** (Bun gateway hooks).

```sh
magpie plugin add @magpie-community/gateway-current-turn-images
```

Before this PR is merged/published, try the complete folder in an isolated
Magpie home instead:

```sh
magpie plugin add ./packages/current-turn-images
```

Open **Plugins > Request images** to see the local statistics. Disable the
plugin with its normal Installed switch to stop both filtering and compression.
Install the complete package: the legacy synchronous `.middleware.js` file
performs filtering only, not compression or journaling.

## Request boundary, not user-task boundary

For a task whose model calls see user image A, tool screenshot B, screenshot C,
then a text-only tool reply, the four outgoing requests keep **A, B, C, none**.
All images in the current batch remain; identical screenshots and identical
request retries are not deduplicated by content.

The boundary is inferred from the explicit transcript: inputs after the latest
assistant/model output (with a later human submission starting a new batch).
It is not a session-level request counter. Without a recognized boundary,
adjacent user inputs may remain one batch. The filter handles Chat Completions,
Responses, Anthropic Messages and Gemini contents, including recognized nested
tool-result payloads. It does not parse JSON strings inside text or tool
arguments, fetch server-side history, or resolve opaque file references.

Other text, request settings, tool definitions, IDs and tool-call pairing remain
unchanged. Empty image-only history and nested removed screenshots receive
text placeholders where needed. Existing image cache markers are carried onto
their placeholders. Unknown request shapes pass through.

**Tradeoff:** a later model call cannot inspect a removed old screenshot. Do
not enable this policy for workflows that must repeatedly compare past images.
Turn the plugin off for those workflows; this is deliberately more aggressive
than `history-trim` or Fovea's recent-history window.

## Lossless optimization and fallback

Filtering happens first; images about to be removed consume no codec CPU.

| Format | Optimization |
|---|---|
| PNG / APNG | oxipng recompression; preserves color layout, transparent RGB, original metadata and animation controls |
| JPEG | jpegtran entropy optimization without DCT requantization; preserves sampling, progressive mode and APP/EXIF/ICC/comments |
| GIF | gifsicle optimization, checked by gifdiff and structural/animation/metadata checks |
| WebP | lossless + exact encoding; preserves transparent RGB and metadata; animation is optimized frame by frame |

Replace an image only if both its file bytes and its JSON field shrink.
Unsupported, corrupt, already-optimized, oversized, timed-out, unavailable-tool
or failed-validation inputs remain unchanged with a reason in the metrics.
There is no resizing, lossy conversion or metadata stripping.

Remote URLs, `file_id` and other references stay references: **no automatic
downloads**. SVG/BMP/TIFF/HEIC and unrecognized dedicated output structures
(such as `computer_screenshot` and `image_generation_call`) are not advertised
as optimized. Image byte savings are **not** image-token or billing savings.

Bundled native tools are **Windows x64 only**, pinned and checked by SHA-256,
with no install scripts or runtime downloads. On other platforms filtering and
metrics remain available, but native optimization falls back to the original
image (`tool_unavailable`). Those platforms have not been runtime-verified.
See [THIRD-PARTY.md](THIRD-PARTY.md) for licenses and corresponding sources.

## Options

The package declares these defaults; edit them in **Installed > Options**:

```json
{
  "gatewayTimeoutMs": 10000,
  "imageCompression": {
    "enabled": true,
    "maxInputBytes": 8388608,
    "maxRawBytes": 67108864,
    "maxMilliseconds": 2500,
    "toolMilliseconds": 1000
  }
}
```

`enabled: false` stops compression, not historical-image filtering.
`maxInputBytes` limits an embedded file, `maxRawBytes` bounds decoded images
and animations, and the millisecond budgets bound codecs and the whole batch.
Each hook host permits at most two concurrent native tasks. Compressed metadata
has a separate 1 MiB expansion limit. Native tools use no shell, open no visible
windows, do not inherit agent credentials, and remove their temporary files.

Optional `dataDir` changes the local daily JSONL directory. Defaults are
`%LOCALAPPDATA%/magpie/current-turn-images` on Windows and
`${XDG_DATA_HOME:-~/.local/share}/magpie/current-turn-images` elsewhere.

Optional `cacheAnchors` explicitly opts selected model names into cache-marker
insertion, e.g. `{"anthropic": ["your-provider/your-model"], "responses": []}`.
No provider/model list is enabled by default. Existing cache settings are not
overridden. Removing history or changing image bytes can still break upstream
prefix caching: **a high cache-hit rate is not guaranteed**.

## Local data and page

The hook writes numeric sizes, image locations/statuses, timestamps, agent and
model names. It does **not** journal prompts, replies, image bytes/URLs or
credentials. The page makes no network calls and requires no Magpie reads.
Model/agent names can still be sensitive; protect the local metrics directory.

Daily JSONL files persist until manually removed while the plugin is stopped;
there is no automatic retention policy. The page snapshot contains the latest
500 records from the last processed UTC day and is written into
`page/snapshot.js` in the installed package (the package directory must be
writable). It is not an all-history total. Writes are serialized within one
hook host, not a cross-process database; do not share one package/data directory
between independent Magpie instances. A metrics-write failure is reported
without undoing the request transformation. Published snapshots are empty.

## Tests

Run on a disposable copy: hook tests update its page snapshot, not your normal
installed plugin. Tests use synthetic transcripts, generated fixtures and
temporary metrics directories; no sign-in or model request is needed.

```sh
cd packages/current-turn-images
npm test
```

The `test/*_test.go` files are optional Magpie engine/gateway integration tests;
their headers explain which internal package to copy them into and the
`MAGPIE_IMAGE_PLUGIN_DIR` / `MAGPIE_IMAGE_TEST_BUN` variables. Native codec cases
run only on Windows x64 and skip elsewhere. The repository's Bun runner can
also run `bun test ./packages/current-turn-images/test`.

## 中文说明

这是社区维护的“请求图片”插件：按**最新一次模型请求的输入批次**保留图片，
不是按整轮用户任务保留。用户图 A → 工具截图 B → 截图 C → 纯文字工具结果，
四次请求分别保留 A、B、C、无图；同一批次的多图全部保留，重试不按图片哈希去重。
支持 Chat、Responses、Anthropic、Gemini 的标准图片块和已识别工具结果。

边界从显式对话历史推断，没有跨请求计数器；没有可识别边界时，相邻用户输入可能
属于同一批次。不会解析文本中的 JSON、获取服务端隐藏历史或下载图片引用。
需要跨请求重新查看旧图、比较历史截图的任务，请关闭插件。

先删旧图，再无损优化当前内嵌图片；只在文件和 JSON 字段都更小时替换。
PNG/APNG、JPEG、GIF、WebP 不缩放、不降低画质、不清除元数据。
损坏、超时、校验失败、格式不支持或已经足够小的图片原样保留，并记录原因。
远程 URL 和 file_id 不下载。原生优化目前仅提供并验证 **Windows x64**；
其他平台保留过滤与统计，压缩工具不可用时回退原图。

统计页显示请求处理前后体积、删图/保留数量和压缩明细，不保存正文、图片或密钥；
模型和 agent 名称仍可能敏感。JSONL 为本地持久文件，没有自动清理周期，页面为最后
处理的 UTC 日期最近 500 条快照，不是全历史总量。需要可写插件目录，仅保证单宿主
写入串行。公开包不包含本机路径、真实日志或个人缓存模型名单。

包内压缩工具固定版本并校验 SHA-256，无运行时下载，许可证和 GIF 对应源码随包提供。
默认压缩启用；`imageCompression.enabled: false` 只关闭压缩，关闭整个插件才停止删图。
可选 `cacheAnchors` 默认不启用。减少图片字节不等于降低图像 token 或费用，
删图与改写图片可能影响上游前缀缓存，不能保证高命中率。

## License

Plugin JavaScript, page and tests: MIT. Separate native tools retain their
upstream licenses; the GIF executables are GPL-2.0-or-later, not MIT.
