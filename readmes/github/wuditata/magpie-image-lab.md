# magpie-image-lab

在 [magpie](https://usemagpie.ai) 窗口里加一个轻量的「生图」页面：写提示词、贴参考图，用 magpie 里已经配好的生图模型出图，记录留在本机。

装好后侧栏 **插件** 分组里出现 **生图**（窗口是英文时叫 Image lab），在应用里和 `magpie web` 里都有。

## 安装

从 GitHub 装：

```sh
magpie plugin add github:wuditata/magpie-image-lab
```

发布到 npm 后也可以按包名装：

```sh
magpie plugin add magpie-image-lab
```

想在本地改这个插件时，进入插件文件夹直接加载：

```sh
magpie plugin add .
```

给 GitHub 仓库加上 `magpie-plugin` topic 后，它也会出现在 **插件 › 发现 › 非官方插件 · GitHub**。改完在应用里把插件关掉再打开，宿主会重新加载。

## 它做什么

- **用 magpie 自己的模型。** 模型列表来自网关（`/v1/models`，带 `X-Magpie-Drawers`），就是 magpie「设置 › 模型 › 生图」里那些能画图的模型，切换即时生效；选择器仿那个设置弹窗：顶部筛选、按供应商分组、当前的钉在最上面。请求全部经网关发出，用量统计、路由组和故障切换与 Agent 一致。
- **提示词 + 参考图。** 参考图可以上传、拖进来或直接按 Ctrl+V 粘贴；最多 8 张。带参考图时按编辑/合成来画（参考图以 `data:` URL 放进 `images`）。
- **参数。** 质量（自动/低/中/高）、尺寸（W×H，可开 16 倍数对齐）、分辨率（1k/2k/4k/自动，只用来算宽高）、常用宽高比、透明背景、生成张数（1–10）。
- **生成记录。** 左边是历史，每张出图连同提示词、模型和参数都记在本地；点开看大图、切换多张、把副本存到下载文件夹（沙盒里浏览器不允许直接下载）、删除，或用「复用参数」把提示词、参考图和设置放回输入区。
- **和窗口一个样子。** 主题与配色取自 magpie 自己的设计令牌，深浅色切换即时跟随。

## 页面与权限

`package.json` 里只声明了页面，没有申请任何读取：

```json
{
  "magpie": {
    "page": { "title": "Image lab", "file": "page/index.html", "icon": "page/icon.svg" },
    "permissions": []
  }
}
```

所以：

- 侧栏标签和图标来自 `page/index.html`、`page/icon.svg`；图标是 16px 的线稿，没有底色和彩色填充，和 magpie 自带的侧栏图标一致。
- 页面跑在 `sandbox="allow-scripts"` 的框架里，没有网络（`connect-src 'none'`），不能读 magpie 的 `/api`，也不能使用内联脚本；`page/` 里只有 `index.html`、`boot.js` 和图标，脚本全部是文件。
- 它不调用 `magpie.read(...)`；`permissions` 因此是空的。生图需要的网关访问由下面的本地服务完成，不经过页面权限。

## 它怎么工作

magpie 的插件页面跑在沙盒框架里：没有网络，不能调 magpie 的 `/api`，唯一能做的联网动作是把自身导航到别处。生图要调网关、要把图存下来，所以这个插件是两层的：

1. `page/index.html` 是 magpie 托管的带路页：读窗口主题和插件选项，然后 `location.replace` 到本地服务。
2. `index.mjs` 作为 OpenCode v1 插件被 magpie 的 Bun 宿主加载，加载时启动本地服务（默认 `127.0.0.1:3486`）。入口只导出 `default { id, server }`，辅助代码都在 `lib/`，不会被当成插件重复调用。
3. `lib/server.mjs` 提供界面与 `/api/*`，`lib/gateway.mjs` 把请求发给 magpie 网关，`lab/` 是界面本身。

服务默认只监听回环地址，并拒绝非同源请求（只接受 opaque 的 `Origin: null` 与自身 origin），别的网页无法借它消耗额度。界面自己的静态文件是公开的（只是代码），`/api/*` 要认人。

数据都在 magpie 配置目录下：

```
~/.config/magpie/image-lab/
├── settings.json   上次用的模型与参数
├── records.json    生成记录（最多 300 条）
├── images/         出图
└── refs/           参考图副本
```

旧版把数据放在 `image-studio/` 下；第一次启动新版时会把这个目录改名为 `image-lab/`，记录和出图都还在。

## 数据与隐私

- **不注册供应商、不需要登录、不保存任何凭据。** 它复用 magpie 已经配好的生图模型；网关要 key 时（`magpie web`、局域网共享）由本地服务从 magpie 自己的 `caller-keys.json` 取一把，只放在发往本机网关的请求头里，不返回给页面，也不写进记录。
- **提示词和参考图只会发给你在 magpie 里配置的网关**（默认本机 `127.0.0.1:3425`），再由它路由到你选择的供应商；插件没有别的上报或遥测。
- **记录留在本机。** 提示词、出图、参考图副本都在上面的目录里；删除记录会一并删图，最多保留 300 条。
- **日志只有启动时的一行监听地址。** 不记录提示词、参考图、出图内容或 key。
- **局域网里要多一道登录。** 只有开着局域网共享且 `magpie web` 有登录 key 时服务才监听 `0.0.0.0`，`/api/*` 要求 magpie web 的登录 cookie、`?k=` 或带路页带来的页面令牌。
- 文档和示例里没有真实提示词、图片、key、账号或本机路径；生成记录和出图不会进仓库。

前提是 magpie 里至少有一个能生图的模型：**设置 › 模型 › 生图** 里选一个，或添加一个生图供应商（OpenAI 的 `gpt-image`、Google 的 `gemini-*-image`、OpenRouter 的生图模型等）。

## 选项

```json
{ "port": 3486, "saveDir": "" }
```

- `port`：本地服务与带路页用的端口，默认 3486。带路页没有网络、无法探活，只会打开这个端口，所以它必须空着；被别的程序占用时换一个。
- `saveDir`：「保存副本」写到哪，默认这台电脑的下载文件夹。

改法：`magpie plugin options image-lab '{"port":3486,"saveDir":"~/Pictures"}'`，或在应用里 **插件 › 已安装** 那一行的 Options。

## 在局域网里用（`magpie web --lan`）

从别的电脑/手机打开 `http://<这台电脑的地址>:3430/?k=<magpie web 的 key>`，登录后进「生图」即可：页面会把自己导航到同一台电脑上的 `http://<同样的地址>:3486/`。

几点说明：

- 服务只在「局域网共享开着（`--lan` 或设置里的局域网）+ `magpie web` 有登录 key」时才监听 `0.0.0.0`，否则只监听回环地址。
- 别的电脑来的数据请求要认人：带上 magpie web 的登录 cookie，或者由带路页把 magpie 这一轮签的页面令牌（`?t=…&p=…`）交给服务，服务会向本机 magpie 复核一次。界面自己的静态文件是公开的（只是代码），`/api/*` 不是。
- 「保存副本」「打开文件夹」执行在这台跑 magpie 的电脑上，不在你手里那台。
- 端口要在防火墙上放行（和 3430 一样）。

## 已知限制

- 张数由插件自己拆成多次请求（有的中转会忽略 `n`），最多同时跑 4 路；个别张失败时保留成功的，并说明有几张没出来。
- 参考图以 base64 内联发送，单张随请求体走，最大请求体约 64MB。
- 尺寸最终由模型的接口决定：有的供应商会按自己的规则重新取整或给出相近的宽高。
- 带路页没法探活（页面的 CSP 连 fetch 都禁），只能按端口直接跳；如果 3486 恰好被别的程序占着，用 `port` 换一个。
- 局域网里第一次打开要先登录 magpie web：用 `magpie web` 启动时印出来的带 `?k=` 的链接打开一次，或者在那张登录页里粘 key。只开 `?view=plugin-image-lab` 而没有登录，会停在登录页。

## 开发与约定

沙箱里跑，别碰到你正在用的 magpie、Agent 和登录信息：

```sh
sb=$(mktemp -d)
m() { env HOME="$sb" XDG_CONFIG_HOME="$sb/.config" XDG_CACHE_HOME="$sb/.cache" MAGPIE_ADDR=127.0.0.1:3499 magpie "$@"; }
m plugin add . </dev/null
m plugin --json
```

然后在应用里打开页面，检查模型列表、生成、记录、保存副本和局域网登录。没有单元测试；改动按实际页面验证。

代码约定：

- 入口只导出 `default { id, server }`；辅助函数留在 `lib/`，不要从入口导出，否则宿主会把它们当成多个插件调用。
- `page/` 必须自包含：只引用页面文件夹里的文件和 magpie 的 `_magpie/bridge.js`，脚本用 `<script src>`，不使用内联脚本。
- 页面不申请 magpie 的读取；唯一的外部动作是导航到本地服务。
- 本地服务默认只监听回环地址，校验 Origin 与局域网凭据；不记录提示词、参考图、出图内容或 key。
- 侧栏图标保持无彩色填充的线稿，尺寸 16px，和 magpie 自带图标一致。

## 加进 magpie-community/plugins

如果之后要提交到社区仓库，把整个文件夹放进 `packages/image-lab/`，包名改成 `@magpie-community/page-image-lab`，再往 `registry.json` 里加一项：

```json
{ "package": "@magpie-community/page-image-lab", "name": "Image Lab", "kind": "page", "community": true,
  "summary": { "en": "A lightweight image lab in magpie's window: a prompt, reference images pasted or dropped, magpie's own image models, and a history kept on this computer.", "zh": "在 magpie 窗口里加一个轻量的「生图」页面：写提示词、贴参考图，用 magpie 已配好的生图模型出图，记录留在本机。" } }
```

注意 `scripts/check.mjs` 会把带 `main` 的包当成 OpenCode 插件检查，而这个包的 `main` 只用来起本地服务（导出的是 `{server}`，没有 `auth`）；提交前把它的跳过条件放宽一声：

```js
// 一个页面 + 自带本地服务（package.json 的 magpie.server）：不进 OpenCode 的形状检查
if (pkg.magpie?.page && pkg.magpie?.server) continue
```

Magpie 发现 GitHub 插件的条件是仓库打了 `magpie-plugin` topic，`package.json` 在仓库根目录；`package.json` 的 keywords 里已经带有同名标签。

---

## English

A lightweight image lab in magpie's window: generate images with the models magpie already has, no second account or key.

**Install.** `magpie plugin add github:wuditata/magpie-image-lab`, or `magpie plugin add magpie-image-lab` once it is on npm. For local work, add the folder itself (`magpie plugin add .` from the plugin folder) and toggle the plugin off and on to reload. A GitHub repository tagged `magpie-plugin` is listed under **Plugins › Discover › GitHub**.

**What it does.**

- **The models magpie has.** The list comes from the gateway (`/v1/models` with `X-Magpie-Drawers`), so it is exactly magpie's own image models; the picker mirrors the one in Settings: a filter box, grouped by provider, current pick pinned on top. Usage, routing groups and failover behave as they do for an agent.
- **Prompt and reference images.** Upload, drop or paste (Ctrl+V) up to 8 images; they go to the vendor as OpenAI's `images` (data: URLs), which is also how an edit is asked for.
- **Parameters.** Quality, size (W×H, 16-pixel alignment), resolution (1k/2k/4k, used to compute the size), common aspect ratios, transparent background, and 1–10 images per run.
- **History.** Past runs stay on this computer with their prompt, model and parameters; open one for the full image, switch between the batch, save a copy into the Downloads folder, delete, or put its parameters back into the form.

**How it works.** A plugin page runs sandboxed with no network, so the plugin is in two parts: `page/index.html` and `page/boot.js` are a guide page that navigates to a local service started by `index.mjs` (an OpenCode v1 plugin loaded by magpie's Bun host). `lib/` serves the UI and proxies `/api/*` to magpie's gateway; `lab/` is the UI. The service listens on the loopback interface by default and refuses requests from other origins.

**Permissions and privacy.** The package asks for no page reads (`magpie.permissions` is empty); it only navigates to the local service. There is no sign-in, no telemetry, and no second copy of your credentials: the service uses magpie's own configuration and caller key only for requests to the local gateway. Prompts and reference images go only to the gateway you configured (and the provider it routes to). Records, images and reference copies stay in `~/.config/magpie/image-lab/` (at most 300 records), and deleting a record deletes its files. The old `image-studio/` directory is renamed once on first start. Logs contain the listening address, not prompts, images or keys. Docs and examples contain no real prompts, images, keys, accounts or local paths; records and generated images are not part of the repository.

**Options.** `{ "port": 3486, "saveDir": "" }`. The guide page has no network and cannot probe, so the configured port must be free; `saveDir` is where “save a copy” writes (the Downloads folder by default). Set them with `magpie plugin options image-lab '{...}'` or from the plugin's Options row.

**Known limits.** The plugin splits a batch into several requests (some relays ignore `n`), at most four in parallel; failed frames are reported while successful ones are kept. Reference images are inlined as base64 (about 64 MB request limit). The vendor's API may round the requested size. The guide page cannot probe a port; change `port` if 3486 is taken by another program. Over LAN, sign in to magpie web first.

**Development.** Use a throwaway HOME as in the Chinese section, then verify model listing, generation, history, saving and the LAN sign-in in the real page. Keep helpers out of the entry file; keep `page/` self-contained with external scripts; keep the service on loopback by default with origin and LAN checks; never log prompts, images or keys; keep the sidebar icon a neutral 16px line drawing.