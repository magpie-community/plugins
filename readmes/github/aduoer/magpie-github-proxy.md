# GitHub 代理（magpie 页面插件）

给 magpie 装一个页面，在里面把 GitHub 的下载全部接上你自己的代理或镜像前缀。装好以后：magpie 侧边栏 →「插件」→ **GitHub 代理**，也可以直接开 <http://127.0.0.1:3478/>。

```bash
magpie plugin add github:aduoer/magpie-github-proxy
# 或者从本地文件夹（改代码时用这个）：
magpie plugin add ./magpie-github-proxy
```

卸载：`magpie plugin rm github:aduoer/magpie-github-proxy`。

![在 magpie 的沙箱与 CSP 下渲染](doc/ui-in-magpie-csp.png)

## 它改的是什么

magpie 自己有一套代理机制（`internal/netproxy`）：它把 `http.DefaultTransport` 的 `Proxy` 换成自己的函数，
顺序是 **设置里的 `proxy` → 环境变量（`HTTPS_PROXY` / `ALL_PROXY`）→ 系统代理**。
所以只要把 `settings.json` 的 `proxy` 写对，magpie 自己发出的所有 HTTP 请求就都在代理下，
包括检查更新、下载更新包、插件市场、插件安装（npm 与 `github:` 两种源）、Skill、MCP，
以及 magpie 拉起的 bun / node / npx 子进程（它会注入 `HTTPS_PROXY`、`NODE_USE_ENV_PROXY=1`）。

`settings.Load()` 是按文件内容记忆化的，文件一变就重读 —— **写 `settings.json` 立即生效，不用重启 magpie**。

这个插件就是给这套机制配一个界面，另外补两个它盖不到的地方（见下）。

## 三条通道

| 通道 | 写到哪 | 管什么 | 什么时候生效 |
| --- | --- | --- | --- |
| ① 代理 | `settings.json` 的 `proxy`（顺带 `proxyCustom`，与 magpie 设置页自己的写法一致） | magpie 自己的全部 HTTP：更新、市场、插件、Skill、MCP、子进程 | 立即 |
| ② 镜像 | `settings.json` 的 `updateMirror`；可选写用户环境变量 `MAGPIE_MIRRORS=on`、`MAGPIE_GITHUB_MIRROR=<前缀>` | 两条路：`updateMirror` 管**应用更新与更新包**；`MAGPIE_*` 管**插件市场、插件安装、Skill、MCP** 的 GitHub 地址（`internal/source` 的 `URLs`） | `updateMirror` 立即；两个变量要**重启 magpie** —— 界面上的「应用并重启 magpie」会一次做完 |
| ③ git | `git config --global http.https://<host>/.proxy`（只给 GitHub 的 6 个域名） | magpie 装 **git 型 Skill** 时直接调 `git`，而 `internal/library/skillgit.go` 的 `gitEnv()` 只加了 `GIT_TERMINAL_PROMPT` / `LC_ALL` / `LANGUAGE`，**不注入代理环境** —— 这是 magpie 自己漏掉的一条路 | 立即 |

②的镜像前缀是**直接拼在 GitHub 原地址前面**（`prefix + raw`，见 `internal/update/mirror.go`），
所以前缀必须以 `/` 结尾；插件会自动补。

### 镜像只是「回退」，不是「优先」

`internal/source/source.go` 的 `URLs()`（127–147 行）是**官方地址在前、镜像追加在后**，`Do()` 只在官方失败
（429 / 5xx / 403 且 rate-limit 为 0 / 连不上）时才按顺序试镜像。除了「国内镜像」开关管的 npm、bun、
jsDelivr、hf-mirror 会被前置，**GitHub 的四个域名没有「镜像优先」的开关**。想做到「一次都不碰官方」只有两条路：
改那 20 行源码自己编译一份 magpie，或者在 `settings.proxy` 上挂一个本地改写代理（MITM，要往系统里装自签 CA）。

### 不用打开页面，它也会把自己修对

`lib/hook.mjs`：宿主每次被 magpie 拉起，延迟 8 秒检查「用户环境里有 `MAGPIE_MIRRORS=on`、**当前这个 magpie 进程**读到了吗」，
没读到就替用户重启一次（变量直接放进新进程，不依赖启动器传环境），30 分钟冷却，不会来回重启；已经生效就什么也不做。
关掉它：`magpie plugin options <插件名> '{"autoApply":false}'`。

## 为什么插件要分「页面 + 本地服务」两层

magpie 的插件页面跑在 `sandbox="allow-scripts"` 的框架里，CSP 是
`connect-src 'none'; frame-src 'none'`，也不能用存储 —— 页面自己发不出任何请求，也改不了 magpie 的配置。
唯一被允许的联网动作是把自身导航到别的地址（官方文档原话）。所以：

- `page/index.html` + `page/boot.js`：magpie 里看到的那一页，只做一件事 —— 把框架导航到本地服务；
- `index.mjs`：作为 OpenCode v1 插件被 magpie 的 Bun 宿主加载，加载时在 `127.0.0.1:3478` 起服务；
- `ui/`：真正的界面，跑在自己的 origin 上，没有那些 CSP 限制；
- `lib/`：读配置、写配置、探测、git、注册表环境变量。

## 用法

1. 侧边栏打开「GitHub 代理」。最上面那张「现在生效」就是 magpie **此刻真正在用**的配置：每条通道的设置值、现在走不走、什么时候生效，每 8 秒自己重读一次。
2. 第 1 节填代理地址（`127.0.0.1:7897`、`http://…`、`socks5://127.0.0.1:1080` 都行，裸 `host:port` 按 http 处理），点**应用**。
3. 第 3 节点「用代理写进 git」，让 git 型 Skill 也走代理。
4. 第 4 节点「全部自检」：每个 GitHub 地址分别从「直连」和「经代理」探一次。直连红、经代理绿，就说明代理真的在起作用。
   下面「测一遍前缀」是同一批地址拼上前缀再取一次响应头。
   **前缀那一列没有 `objects.githubusercontent.com`（release 资产域）**：它只给带签名的临时地址（`?X-Amz-Signature=…`），根路径什么都没有，探了也只能看到 404；而且走前缀下载更新包时是前缀自己去取资产再流回来，根本不经过这个域名。它只影响「代理能不能连上」，所以在「全部自检」里看，那里 403/404 也算通，5xx 与超时才算不通。
   下面的「测一遍前缀」是同一批地址**拼上现在的前缀**再取一次响应头，看镜像站这条路通不通。

**代理和镜像可以同时设，也可以只设一个**，它们是两条独立的路：

| | 怎么工作 | 覆盖什么 |
| --- | --- | --- |
| 代理（第 1 节） | 把连接交给代理服务器（`CONNECT api.github.com:443`） | magpie 自己的<b>全部</b> HTTP：更新、更新包、市场、安装、Skill、MCP、子进程 |
| 镜像（第 2 节） | 把 GitHub 原地址拼在前缀后面（`prefix + url`） | `updateMirror` 管更新与更新包；`MAGPIE_MIRRORS` 管 `github.com`、`api.github.com`、`raw.githubusercontent.com`、`codeload.github.com` 四个域名的前缀改写 |

只设镜像就够覆盖 GitHub 相关的东西；代理额外盖住前缀盖不到的：release 资产域（`objects.githubusercontent.com`）、镜像慢或挂掉时的大包、git 克隆。
镜像前缀不能填进第 1 节：magpie 会把它当代理服务器去 `CONNECT`，实测返回 `HTTP/1.1 400 Bad Request`，一个字节都下不来。

想用镜像站（例如 `https://ghfast.top`）：第 2 节填入，点**应用并重启 magpie** —— 它先写 `updateMirror`（更新立刻走镜像），
再写用户环境变量 `MAGPIE_MIRRORS=on` / `MAGPIE_GITHUB_MIRROR=<前缀>`，然后关掉 magpie 再拉起来，插件市场、插件安装、Skill、MCP 一起走镜像。
不想动环境变量就点「应用」，只让应用更新走镜像。

重启是怎么做的：插件让一个 WMI 起的 PowerShell 帮手（不在 magpie 的进程作业里，magpie 关掉它也还活着）先关掉 magpie，
再把 `MAGPIE_MIRRORS`、`MAGPIE_GITHUB_MIRROR`（以及注册表里的 `HTTPS_PROXY` 等）**直接放进它自己的环境**再 `Start-Process` ——
因为注册表里的用户环境变量不会自动进新进程，只有这样才能保证重启后的 magpie 真的读到前缀。
脚本和每步结果写在 `%TEMP%\magpie-github-proxy-restart.log`，界面上也能直接看到最后几行。

## 细节

- 改 `settings.json` 前会留一份 `settings.json.github-proxy.bak`（只在还没有备份时写），写入是 `tmp` + `rename` 的原子替换，magpie 不会读到半个文件。
- 只写自己的两个键（`proxy`、`updateMirror`），别的键原样保留；清空时删键，`proxyCustom` 留着（与 magpie 设置页「切回自定义时把地址填回来」的行为一致）。
- 端口默认 3478（`magpie plugin options` 里可改）；被占用时顺延，并在占用者退出后自动抢回首选端口。
- API 只接受 `Origin` 为本服务或 `null`、且带 `x-magpie-page: github-proxy` 头的请求，绑在 `127.0.0.1`。
- 页面的 CSP 是 `default-src 'self'; connect-src 'self' http://127.0.0.1:*`：后者是给「自己找家」用的，否则浏览器会拦掉跨端口的那次探测。
- 卸载：`magpie plugin rm D:\MY\工具\magpie-github-proxy`；想在 magpie 外单独跑：`node index.mjs`。

## 为什么页面会「Failed to fetch」

页面本身是本地服务上的一个网页，它的脚本只能跟**自己这个 origin**（`http://127.0.0.1:<端口>/`）说话。所以只要那个端口没了，
页面上的任何按钮都会立刻失败：

- magpie 被重启（宿主跟着一起没）；
- 端口被别的进程占着，服务顺延到了 3479，之后 3478 空出来；
- magpie 的 CLI（`plugin add` / `plugin list`）短暂加载了一下宿主又退出。

还有一个更隐蔽、直到 0.3.3 才修的原因：**在 magpie 窗口里，这个页面跑在 `sandbox="allow-scripts"` 的框架里，
它的 origin 是 opaque（`Origin: null`）**，于是带 `x-magpie-page` 头的 JSON `POST` 属于「非简单请求」，
浏览器会先发一次 `OPTIONS` 预检。服务以前对 `/api/*` 只认 `POST`，预检直接 405，于是**直接打开地址好用、
在 magpie 窗口里全红**（`curl -X OPTIONS -H 'Origin: null' … /api/state` 当时确实回 `405 Method Not Allowed`）。
0.3.3 起对所有 `/api/*` 回 `204` + `access-control-allow-{origin,methods,headers}`，并在正常响应里回显来源。

处理办法（两个都在里面）：

1. **旧端口不急着关**：服务补上首选端口时，之前那个端口继续听着（最多留 3 个），已经打开的页面不会一下变白。
2. **页面自己找家**：请求失败时，页面会在 `3478~3497` 里挨个问 `/api/health`（这条只回端口号，允许跨源读），
   谁应就 `location.replace` 跳过去，正是刚才这个场景：页面停在被杀掉的 `3481` 上，点一下按钮就自己跳回了 `3478`。
3. **断线时说的话像人话**：顶上一条黄色横幅「本地服务暂时没应答 —— magpie 可能正在重启，它回来后这一页会自己接上」，
   带一个「立刻重试」；重连回来会弹「已经连回本地服务」。等待期间重试间隔从 1.2 秒退到 4 秒，不会刷屏。
4. **动作失败时说清是重启**：点「应用」时如果正好在重启，提示是「magpie 正在重启，服务回来后这一页会自己接上；
   等几秒再点一次就行」，而不是干巴巴的「Failed to fetch」——表单里已经填的值不会被清掉。

## 已知边界

- 镜像通道对插件 / Skill / MCP 一定要重启 magpie：`MAGPIE_MIRRORS` 是 `internal/source/Enabled()` 每次请求时读的**进程环境**，
  而插件跑在 magpie 的子进程里，改不了父进程的环境。插件能做的是「写变量 + 帮你重启」，一键完成。
- 注册表里的用户环境变量**不会自动进已经存在的进程**，也不会进由别的程序（比如带自启的 dock / 启动器）拉起来的 magpie：
  那种情况下「现在生效」会把这一行标成「变量已写，等重启 magpie」，并给一个就地重启的按钮 —— 重启脚本会把变量直接放进新进程的环境。
- 「应用并重启」会关掉 magpie 再开：正在跑的对话与请求会断一下（界面会先问一次）。
- 只有 Windows 能自动重启；别的系统上写好变量后自己重启。
- git 通道只覆盖 `github.com`、`api.github.com`、`raw.githubusercontent.com`、`codeload.github.com`、`objects.githubusercontent.com`、`gist.githubusercontent.com`；别的 remote 不碰。
- 依赖 magpie `>= 0.1.1340`（本机是 `0.1.2064`）。

## 「此页面已停止工作 / 页面没有响应」是什么

那是 magpie 内核自己的看门狗，不是我们的错误页。`internal/gui/assets/pluginpages.js` 里：

```js
const HELLO_MS = 10e3;
p.timer = setTimeout(() => { if (!p.hello) reject(new Error(t("{name}'s page didn't answer", …))) }, HELLO_MS);
```

页面必须在 10 秒内通过 `_magpie/bridge.js` 发一句 `hello`，否则这一页被判死，**并且这个判定会一直粘着**，直到点卡片上的「重试」。

两个常见的触发点：

- **重装/更新插件之后**：页面 token 变了（`pageToken(spec)` 是 spec 加每次启动密钥的 HMAC），已经打开的旧标签页还指着旧 token，旧地址 404，自然没人说 hello。重启 magpie 或点「重试」就好。
- **宿主还没起来就导航**：本插件的带路页以前会无限等桥回话（0.3.4 之前），于是永远不发 hello。现在带路页 0.9 秒内必定导航，界面自己会重连、会找回家。

正常情况下的实测（用 magpie 自己的 `pagebridge.js`）：hello 在第 **33 毫秒**到达，`options.get` 在第 34 毫秒，框架随即导航到 `http://127.0.0.1:3478/`。
