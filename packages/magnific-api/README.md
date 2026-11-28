# magnific-api

[Magnific](https://www.magnific.com)'s image and video generation with your API key, in
[magpie](https://usemagpie.ai): native image and video models on the gateway, and tools
every agent can call. It talks to Magnific's REST API (`https://api.magnific.com`,
[docs](https://docs.magnific.com)) and has no dependencies.

**Provider id:** `magnific`

```sh
magpie plugin add @magpie-community/magpie-magnific-api
magpie plugin login magnific      # paste the API key
```

For OpenCode, install [`opencode-magnific`](https://github.com/hubo1989/opencode-magnific)
instead: the same code, with OpenCode's plugin package as a dependency so the tools get
the zod arguments OpenCode wants. OpenCode gets the tools only, no models.

## Sign-in

A Magnific API key, created on the
[API Keys](https://www.magnific.com/user/organization/api-keys) page (the organization's
administrator account). It is stored as `{ "type": "api", "key": "…" }` in magpie's
`plugin-auth.json` and sent only as the `x-magnific-api-key` header; it is never logged
or returned by a tool. The tools also take `MAGNIFIC_API_KEY` from the environment,
before any sign-in.

Magnific's REST API takes API keys only. Its OAuth sign-in belongs to its MCP server
(`https://mcp.magnific.com`), which this plugin does not use.

## Native models

Twenty models are listed as magpie's image and video models, on the gateway's OpenAI
Images and Videos APIs:

| Kind | Models (`magnific/…`) |
| --- | --- |
| Image | `mystic`, `nano-banana-pro`, `nano-banana-2-1`, `gpt-image-2-5`, `seedream-v5-pro`, `flux-2-pro`, `flux-2-klein`, `ideogram-4-5`, `recraft-v4-1`, `z-image` |
| Video | `veo-3-1`, `veo-3-1-fast`, `kling-v3-pro`, `kling-v3-std`, `seedance-2-5-pro`, `seedance-2-fast`, `wan-3-0`, `wan-2-5-480p`, `runway-4-5`, `ltx-2-fast` |

```sh
curl -s "$MAGPIE_GATEWAY/v1/images/generations" -H 'Content-Type: application/json' \
  -d '{"model":"magnific/flux-2-klein","prompt":"a lighthouse at dusk","size":"1792x1024"}'

curl -s "$MAGPIE_GATEWAY/v1/videos" -H 'Content-Type: application/json' \
  -d '{"model":"magnific/wan-2-5-480p","prompt":"a paper boat in the rain","seconds":"5"}'
curl -s "$MAGPIE_GATEWAY/v1/videos/$VIDEO_ID"
curl -s "$MAGPIE_GATEWAY/v1/videos/$VIDEO_ID/content" -o out.mp4
```

- `size` (`WIDTHxHEIGHT` or `16:9`) becomes the model's own closest aspect ratio, or its
  `width` and `height`; `seconds` becomes its closest duration (Veo 3.1 has 4, 6 and 8).
  A model without such a parameter ignores them.
- `extra` carries the model's own parameters as they are, e.g. `{"resolution":"1080p"}`.
- `n` is at most 4; each image is a generation of its own and is billed as one.
- Images come back as `b64_json`. Magnific's result links expire 30 minutes after
  generation, so a video's content is to be fetched within that time.
- The native video models are text to video. A request with `input_reference`,
  `last_frame` or `reference_images` is answered 400; use the `magnific_generate` tool
  for image to video.

## Tools

The tools reach every image and video generation endpoint of the API: 34 image and 106
video models (Mystic, Flux, Nano Banana, Seedream, GPT Image, Ideogram, Kling, Veo,
Seedance, WAN, Hailuo, PixVerse, Runway, LTX and more).

| Tool | What it does |
| --- | --- |
| `magnific_models` | Lists the models, by `kind` (image or video) and `search` words; with `model`, that model's parameters, allowed values and defaults |
| `magnific_generate` | Starts a generation with `model`, `prompt` and the model's own `params`, waits up to 50 seconds, saves the result and answers the file paths, or a task id when it is still running |
| `magnific_task` | Waits for a task by its id and saves the result when it is done |

- Parameter names differ from model to model. Arguments are checked against Magnific's
  spec before anything is sent: a wrong one costs no credits, and the error lists the
  model's parameters.
- An image parameter takes a public URL. One the spec says accepts base64 also takes a
  local file path (up to 25 MB), which is read and encoded.
- Results are saved as soon as a task completes, to `~/magnific-output` under magpie
  (`output_dir`, the plugin option `outputDir` or `MAGNIFIC_OUTPUT_DIR` choose another
  folder).
- A magpie tool call may run 55 seconds, so one call waits 50 at most; a video usually
  takes a `magnific_generate` and then `magnific_task` until its status is `COMPLETED`.

## The catalog

`catalog.json` is generated from Magnific's
[OpenAPI spec](https://storage.googleapis.com/fc-freepik-pro-rev1-eu-api-specs/magnific-api-v1-openapi.yaml)
and is not edited by hand:

```sh
bun scripts/build-catalog.mjs     # in packages/magnific-api
```

## Tests

```sh
bun test packages/magnific-api
```

They run against a local stand-in for the API: no key, no credits. The same client and
routes were also run against the real API through magpie 0.1.4754: image and video
through the tools, an image with a local reference file, `/v1/images/generations`, and
`/v1/videos` create, poll and download.
