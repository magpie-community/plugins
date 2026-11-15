# Magpie Plugins（Magpie 网关插件库）

[![Plugin](https://img.shields.io/badge/plugin-airbrush--image-8b5cf6.svg)](https://github.com/otaku-say/magpie-plugins)
[![Tests](https://img.shields.io/badge/tests-19%20passed-brightgreen.svg)](tests/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

给 [Magpie](https://github.com/yetone/magpie) 网关开发的插件集。每个插件都把一个外部服务变成 Magpie 资源库（Library）里的一个 MCP 服务：装上即出现在 **Library → MCP**，开启 MCP router 后自动进入 `/mcp/magpie/hub` 聚合路由，任何接了 hub 的 Agent / 应用都能直接调用。

---

## 快速开始：安装 airbrush-image 插件

在部署 Magpie 网关的机器上执行一条命令（与安装 magpie-memory-hub 同款方式）：

```sh
magpie plugin add github:otaku-say/magpie-plugins
```

然后保存你的 Airbrush API key（app.airbrush.ai → 账户 → API 页面点 **Show** 复制）：

```sh
magpie plugin options airbrush-image '{"apiKey":"你的_AIRBRUSH_KEY"}'
```

装好后：

| 位置 | 说明 |
| :--- | :--- |
| **Plugins → Installed** | 出现 `airbrush-image` 一行，列出工具 `airbrush-image_generate_image`，可复制 `/mcp/magpie/tools` 地址 |
| **Library → MCP** | 自动出现名为 `airbrush-image` 的服务（打「Plugin」标签），按 Agent 单独开关 |
| **MCP router（聚合路由）** | 开启后，hub 的 `tools/list` 里出现 `airbrush-image__generate_image`，任何 Agent 与外部应用可经 `https://<网关地址>/mcp/magpie/hub` 调用 |

> Magpie 从 GitHub 仓库**根目录**安装插件（`github:owner/repo`，`#` 后缀是 git ref 不是子目录，已实测）。因此本仓库**根目录即 `airbrush-image` 插件本身**；以后收录第二个插件时，它需要自己的仓库根（或从本仓库 clone 后按路径 `magpie plugin add ./plugins/<name>` 安装）。仓库的工程结构（README / LICENSE / CONTRIBUTING / scripts / tests / CI）沿用 [otaku-say/cindy-plugins](https://github.com/otaku-say/cindy-plugins) 的规范。

### 验证安装

```sh
magpie plugin list                       # 列出插件与工具
magpie plugin options airbrush-image     # 查看已保存的选项
```

开启 MCP router 后，用网关 key 直接探测工具（`tools/call` 会真实生图、消耗 credit）：

```sh
curl -s https://<网关地址>/mcp/magpie/hub \
  -H "Authorization: Bearer <MAGPIE_API_KEY>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

---

## 当前已收录插件

| 插件 | MCP 服务名 | 工具 | 一句话说明 |
| :--- | :--- | :--- | :--- |
| **`airbrush-image`** | `airbrush-image` | `generate_image` | 用 Airbrush 生图套餐的 API 额度文生图：一次调用一张图，按引擎与尺寸扣 credit |

### airbrush-image

把 [Airbrush](https://airbrush.ai) 的生图 API（`POST https://api.airbrush.ai/v1/images`）封装成一个 MCP 工具。API 文档见 app.airbrush.ai → 账户 → API 页面。

**工具：`generate_image`**

| 参数 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `prompt` | string | ✅ | 画什么，至少 2 个字符 |
| `engine` | enum | — | 10 个引擎之一，默认 `flux` |
| `size` | enum | — | `small` / `large` / `xlarge` / `portrait` / `landscape` / `wide_landscape`，默认 `large`（方形） |
| `negative_prompt` | string | — | 不想出现的内容 |
| `seed` | integer | — | 整数；同 prompt 同 seed 可复现 |
| `guidance` | integer | — | 提示词贴合度，整数，默认 7 |

返回图片 URL、本次消耗与剩余 credit。工具描述里内置了完整的 credit 价格表，模型可以按预算自选引擎与尺寸。

**引擎与 credit 价格表**（尺寸顺序 small / large / xlarge / portrait / landscape / wide_landscape）：

| 引擎 | small | large | xlarge | portrait | landscape | wide_landscape |
| :--- | :-: | :-: | :-: | :-: | :-: | :-: |
| `flux` | 0.5 | 1 | 4 | 1 | 1 | 1 |
| `stable-diffusion-xl-pro` | 0.5 | 1 | 4 | 1 | 1 | 1 |
| 其余 8 个引擎（`midjourney-v6`、`slow-picasso`、`3d-animation-diffusion`、`anything-v6`、`wifu-diffusion`、`analog-diffusion`、`protogen-45`、`realistic-vision-v2`） | 0.5 | 1 | 4 | 2 | 2 | 2 |

**配置（plugins.json 选项）**：

| 选项 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `apiKey` | `""` | Airbrush 密钥。为空时回退读网关环境变量 `AIRBRUSH_API_KEY` |
| `apiUrl` | `https://api.airbrush.ai/v1/images` | API 端点。旧端点 `https://app.airbrush.ai/create-art-api` 字段相同，可指过去 |

**行为说明**：

- 一次调用 = 一张图，同步返回；Magpie 给每次工具调用 **55 秒**上限（超时会以友好话术返回，可换小尺寸重试）。
- credit 在图片生成成功后才扣；`429 Rate limit` 会原样带回「等 N 秒重试」的提示。
- 密钥只随请求发给 Airbrush，不出现在工具返回里；Magpie 请求日志只记工具名不记参数。

---

## 目录结构

```text
magpie-plugins/
├── package.json        # 插件本体（airbrush-image）——Magpie 从仓库根安装
├── index.js            # 插件入口：OpenCode tool hook，交给 Magpie 插件宿主加载
├── airbrush.js         # Airbrush API 客户端与常量表（引擎/尺寸/价格）
├── icon.svg            # 图标源文件（package.json 里内嵌 data URI）
├── scripts/check.mjs   # 按 Magpie 宿主的方式加载插件并做结构检查
├── tests/              # bun test 单测（本地起假 Airbrush 服务，零消耗）
│   ├── airbrush.test.js
│   └── plugin.test.js
└── .github/workflows/test.yml
```

## 开发与测试

```sh
bun test               # 19 个用例：客户端、入口、错误路径、超时（不消耗 credit）
bun scripts/check.mjs  # 按 Magpie 宿主加载方式做结构检查（node 亦可运行）
```

在沙箱里带真 key 冒烟（参照 Magpie 官方文档的沙箱法）：

```sh
sb=$(mktemp -d)
m() { env HOME=$sb XDG_CONFIG_HOME=$sb/.config XDG_CACHE_HOME=$sb/.cache MAGPIE_ADDR=127.0.0.1:3499 magpie "$@"; }
m plugin add github:otaku-say/magpie-plugins
m plugin options airbrush-image '{"apiKey":"你的_KEY"}'
m plugin --json        # 工具与加载错误都在这里
```

发版流程与工程规范见 **[CONTRIBUTING.md](CONTRIBUTING.md)**。

## License

[MIT](LICENSE)
