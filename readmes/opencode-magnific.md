# opencode-magnific

[OpenCode](https://opencode.ai) / [magpie](https://usemagpie.ai) 插件：把 [Magnific API](https://docs.magnific.com) 的生图、生视频做成 agent 可以直接调用的工具。同一个包两边通用：OpenCode 里是原生 tool，magpie 里经 `/mcp/magpie/tools` 提供给每个 agent。

覆盖 Magnific REST API 的 34 个生图端点和 106 个生视频端点（Mystic、Flux、Nano Banana、Seedream、GPT Image、Ideogram、Kling、Veo、Seedance、WAN、Hailuo、PixVerse、Runway、LTX 等）。模型清单 `catalog.json` 由官方 OpenAPI 规范生成，不手写。

## 工具

| 工具 | 作用 |
| --- | --- |
| `magnific_models` | 列出模型（可按 `kind`: image / video、`search` 过滤）；传 `model` 返回该模型的全部参数、取值范围和默认值 |
| `magnific_generate` | 提交一次生成：`model`、`prompt`、`params`（该模型自己的参数）。等待最多 50 秒，完成就下载到本地并返回文件路径，没完成返回任务 id |
| `magnific_task` | 用任务 id 继续等待，完成后下载到本地 |

magpie 里工具名前面还带插件短名（`<插件>_<工具>`），以 `magpie plugin` 列出的为准。

几点行为：

- 各模型参数名不同（`aspect_ratio` 有的是 `16:9`，有的是 `widescreen_16_9`）。参数在本地先按规范校验，写错的参数不会发到 Magnific，也不扣额度，报错里会列出可用参数。
- 图片类参数填公开 URL。规范里注明接受 base64 的参数也可以直接填本地文件路径（上限 25 MB），插件会读取并编码；只收 URL 的参数填本地路径会报错说明。
- Magnific 的结果链接生成 30 分钟后失效，所以任务一完成就下载。默认存到项目目录下的 `magnific-output/`；magpie 里没有项目目录，存到 `~/magnific-output/`。可用 `output_dir` 参数、插件选项 `outputDir` 或环境变量 `MAGNIFIC_OUTPUT_DIR` 改。
- 视频通常超过 50 秒：`magnific_generate` 先返回任务 id，agent 再调 `magnific_task` 直到 `COMPLETED`。单次最多等 50 秒是因为 magpie 的工具调用 55 秒超时。

## magpie 原生模型

在 magpie 里，插件另外注册 20 个原生模型（10 个生图、10 个生视频），出现在模型列表里，走网关的 OpenAI 接口，不需要 agent 会用工具：

| 类型 | 模型 id（前缀 `magnific/`） |
| --- | --- |
| 生图 | `mystic`、`nano-banana-pro`、`nano-banana-2-1`、`gpt-image-2-5`、`seedream-v5-pro`、`flux-2-pro`、`flux-2-klein`、`ideogram-4-5`、`recraft-v4-1`、`z-image` |
| 生视频 | `veo-3-1`、`veo-3-1-fast`、`kling-v3-pro`、`kling-v3-std`、`seedance-2-5-pro`、`seedance-2-fast`、`wan-3-0`、`wan-2-5-480p`、`runway-4-5`、`ltx-2-fast` |

```bash
# 生图：返回 {data:[{b64_json}]}
curl -s "$MAGPIE_GATEWAY/v1/images/generations" -H 'Content-Type: application/json' \
  -d '{"model":"magnific/flux-2-klein","prompt":"a lighthouse at dusk","size":"1792x1024"}'

# 生视频：创建 → 轮询 → 下载
curl -s "$MAGPIE_GATEWAY/v1/videos" -H 'Content-Type: application/json' \
  -d '{"model":"magnific/wan-2-5-480p","prompt":"a paper boat in the rain","seconds":"5"}'
curl -s "$MAGPIE_GATEWAY/v1/videos/$VIDEO_ID"
curl -s "$MAGPIE_GATEWAY/v1/videos/$VIDEO_ID/content" -o out.mp4
```

- `size`（`宽x高` 或 `16:9`）换算成该模型自己最接近的宽高比（或 `width` / `height`）；`seconds` 换算成该模型支持的最接近时长。模型没有对应参数时忽略。
- `extra` 对象原样带上该模型自己的参数（如 `{"resolution":"1080p"}`），同样先校验。
- `n` 最多 4，每张图是一次独立生成，各自扣额度。
- 原生视频模型只做文生视频；带 `input_reference` 等参考图的请求返回 400，图生视频请用 `magnific_generate` 工具。
- 原生模型只列了常用的 20 个，其余端点用工具调用。清单在 `native.mjs` 的 `NATIVE`。
- OpenCode 里不注册这些模型（它的模型列表只用于对话），只提供工具。

## 安装与登录

API key 在 <https://www.magnific.com/user/organization/api-keys> 生成（需要组织管理员账号）。

**magpie**

```bash
magpie plugin add opencode-magnific                 # 或社区包: magpie plugin add @magpie-community/magpie-magnific-api
magpie plugin login magnific                        # 粘贴 API key
magpie plugin                                       # 应看到 magnific (Magnific, 20 models) signed in，以及三个 tools
```

在应用里：插件 → 添加插件 → 填文件夹路径，然后在 Magnific 那一行登录。

**OpenCode**

`opencode.json` 里加上 `"plugin": ["opencode-magnific"]`，然后：

```bash
opencode auth login    # 选 Magnific，粘贴 API key
```

**环境变量**

设置了 `MAGNIFIC_API_KEY` 时优先用它，两边都不用登录。

凭证查找顺序：`MAGNIFIC_API_KEY` → magpie 的 `plugin-auth.json` → OpenCode 的 `auth.json`。magpie 里登录了多个账号时，用工具的 `account` 参数选（如 `magnific#ab12cd`）。key 只放在 `x-magnific-api-key` 请求头里，不进日志和工具输出。

## 认证方式

目前支持 **API key**。Magnific 的 REST API 只接受 API key（[官方说明](https://docs.magnific.com/authentication)）。

Magnific 的 OAuth 登录只用于它的 MCP 服务器 `https://mcp.magnific.com`，本插件不接。想用 OAuth 的话，直接把这个地址作为远程 MCP 服务器加到 OpenCode 或 magpie 的资料库里，由宿主完成 OAuth。

## 开发

```bash
bun install
bun test                 # 目录、凭证、提交/轮询/下载（本地模拟的 Magnific API）
bun run catalog          # 从 Magnific 的 OpenAPI 规范重新生成 catalog.json
```

选项 `apiBase`（或环境变量 `MAGNIFIC_API_BASE`）可以把请求指到别的地址，测试用。

| 文件 | 内容 |
| --- | --- |
| `index.mjs` | 插件入口，只导出 `MagnificPlugin`：`auth` 钩子、三个工具，magpie 下另有 `config` / `provider` 钩子 |
| `native.mjs` | magpie 原生模型：清单、OpenAI Images / Videos 请求到 Magnific 的换算 |
| `args.mjs` | 工具参数：magpie 用 JSON Schema，OpenCode 用同一份定义生成的 zod 字段 |
| `catalog.mjs` / `catalog.json` | 模型清单、查找、参数校验 |
| `magnific.mjs` | 凭证查找、REST 调用、轮询、下载 |
| `scripts/build-catalog.mjs` | 由 OpenAPI 规范生成 `catalog.json` |

## 社区包

同一份代码也在 [magpie-community/plugins](https://github.com/magpie-community/plugins) 的 `packages/magnific-api`，包名 `@magpie-community/magpie-magnific-api`，不带依赖，面向 magpie。OpenCode 请用本包。

## 许可

MIT
