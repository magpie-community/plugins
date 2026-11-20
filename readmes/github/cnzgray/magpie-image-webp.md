# magpie-image-webp

A Magpie gateway hook that re-encodes inline images as WebP and caps their width before a request leaves your gateway. [中文说明](README.zh.md)

## Why

Magpie's gateway is stateless HTTP, and agents inline images as base64, so the whole body must arrive before it can be forwarded. A 2560×1600 screenshot re-sent every turn is about 4.1 MB. On a 6 Mbps uplink that pushed time to first token to 8–12 s; the same request after compression reached 2.6–3.1 s.

| Where | Body | Time to first token |
|---|---|---|
| Tencent Cloud gateway (sharp) | 3.93 MB → 293 KB | 9.25 s → 2.6–3.1 s |
| Local Mac (cwebp) | 3.93 MB → 280 KB | 3.7–4.0 s |

Compression runs inside the gateway; clients and providers see ordinary requests. The gains matter most on slow uplinks, on long image histories, and with byte-billed providers.

## What it does

- Handles `data:image/...;base64,...` images in chat and Responses bodies, Anthropic `source.data` (rewriting `media_type` too), and Gemini `inlineData.data` / `inline_data.data` (rewriting `mimeType` / `mime_type`, keeping the spelling the request used).
- Leaves non-inline references alone: Anthropic `url` sources and Gemini `fileData`.
- Keeps the original when the WebP result is not smaller, and skips images below `min`.
- Only touches the agents listed in `agents`; an empty list means every agent.
- Fails open: any error, missing encoder, or timeout forwards the request untouched.
- Applies every replacement only after all jobs succeed, so a rejected hook never leaves a half-rewritten body.
- Caches results in an LRU keyed by the first 16 hex characters of the input's SHA-256 plus `width` and `quality`. Capacity is counted in compressed bytes and bounded by `cacheMB` and 256 entries.
- The bundled WASM decoder reads PNG and JPEG. Other formats pass through unchanged.

Requires Magpie 0.1.1273 or newer for async gateway hooks; page-saved options reach hooks on the next request with Magpie 0.1.1531 or newer.

## Install

Install with Magpie's git spec:

```sh
magpie plugin add cnzgray/magpie-image-webp
```

Pin a release with `#v0.1.0`:

```sh
magpie plugin add cnzgray/magpie-image-webp#v0.1.0
```

The plugin is not published to npm; Magpie installs it from this repository and shows an update when the branch or the pinned ref moves. You can also add the folder or the hooks file from Plugins. The plugin's options live in `plugins.json`; the settings page edits the same object:

```json
{
  "spec": "/absolute/path/to/image-webp",
  "options": {
    "agents": ["dsh", "codex"],
    "width": 1600,
    "quality": 85,
    "max": 4,
    "min": 131072,
    "cacheMB": 64,
    "gatewayTimeoutMs": 5000
  }
}
```

Restart the gateway (or use `--force-recreate`) after installing.

## Options

| Option | Default | Meaning |
|---|---|---|
| `agents` | `["dsh", "codex"]` | Agents to process; an empty list means all |
| `width` | `1600` | Maximum width in pixels; only shrinks |
| `quality` | `85` | WebP quality, 1–100 |
| `max` | `4` | Images processed per request |
| `min` | `131072` | Skip originals smaller than this many bytes |
| `cacheMB` | `64` | Byte budget of the compressed-result LRU; `0` disables it |
| `gatewayTimeoutMs` | `5000` | This hook's budget; Magpie clamps it to 100–30000 ms |

## Settings page

The plugin adds an "Image WebP" page under Plugins with fields for every option: agent chips, maximum width, quality slider, images per request, minimum size, cache budget, and time budget. Saving writes the same options object; changes take effect on the next request.

The page declares no permissions and makes no network requests. `test/page.test.mjs` checks for network calls, undeclared `magpie.read` calls, and that the page defaults match `lib/options.mjs`.

## Encoders

Probed in order; the first one available wins:

1. **sharp** — used when it resolves from the plugin folder. Cross-platform, with EXIF rotation and width probing.
2. **cwebp** — from `PATH` or `IMAGE_WEBP_CWEBP`. Width comes from the built-in PNG/JPEG header parser; an unknown format is encoded without `-resize`.
3. **wasm** — bundled `@jsquash/png`, `@jsquash/jpeg`, `@jsquash/resize`, and `@jsquash/webp`. No system tools; PNG and JPEG decoding, no resize when the width already fits, and `Bun.gc(true)` after each image to keep RSS bounded.
4. **none** — logs a warning and forwards the request untouched.

Set `IMAGE_WEBP_BACKEND=sharp|cwebp|wasm` to skip probing. Install sharp beside the plugin (`bun add sharp`) to use it.

## WASM measurements

Bun 1.4.4, `@jsquash` 1.5.0 / 3.1.1 / 2.1.1, quality 85, Apple Silicon. Single image:

| Sample | WASM cold / warm | sharp | cwebp | Output | WASM peak RSS |
|---|---|---|---|---|---|
| 1600×1000 screenshot sample (58 KB PNG) | 85 / 63 ms | 42 ms | 50 ms | 12.5 KB | 143 MB |
| 2560×1600 noise → 1600 (16.4 MB PNG) | 516 / 461 ms | 278 ms | 280 ms | 2.5 MB | 384 MB |

- WASM instantiation is included in the first image; there is no separate warm-up.
- Four 2560-wide images take 1.84 s in one request, inside the 5 s budget but with about 3 s left.
- Output is about 5% larger than native on the noise sample; the screenshot sample matches exactly.
- Resizing a 1600-wide image still costs 117–125 ms, so the backend skips resize when the width already fits.
- Without intervention RSS grows by about 40 MB per 2560 image or 10 MB per 1600 image; `Bun.gc(true)` after each image keeps it at 296 MB / 118 MB, at about 18 ms per call versus 450 ms of compression.
- A 1600×1000 JPEG takes 298 ms, 2.6 MB → 1.2 MB, with a 177 MB peak.

The WASM backend is the default because it needs no system dependencies; sharp is about 1.7× faster with 2.8× less memory.

## Development

```sh
bun test
```

Tests generate deterministic PNGs and call `onRequest` the way the gateway does. `cases.json` holds the protocol cases and is driven by `test/cases.test.mjs`; `test/wasm.test.mjs` runs the cold path in a separate process with the WASM backend forced.

## Roadmap

- Verify upstream WebP acceptance for yescode, Gemini, and Anthropic native paths, falling back to JPEG per provider if needed.
- Open a PR against `magpie-community/plugins` as `@magpie-community/gateway-image-webp` if the community list wants it.

## License

MIT
