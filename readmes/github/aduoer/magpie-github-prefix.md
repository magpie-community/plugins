# magpie-github-prefix

给 magpie 里所有发往 GitHub 的地址加一个镜像前缀。就这一件事。

![GitHub 镜像页](docs/mirrors.png)

## 安装

```bash
magpie plugin add github:aduoer/magpie-github-prefix
```

装完打开 magpie → 侧边栏「GitHub 镜像」→ 填前缀（例 `gh-proxy.com`）→ 保存 → 按页面上的「重启 magpie」。

留空保存 = 关掉（直连 GitHub）。

## 用语

- 页面上内置了一批主流镜像站：点「测速全部」当场量出哪个快、哪个废，然后点「用这个」换过去
- 也可以在最下面的输入框里加自己的镜像（存在本地清单里，随时删）
- 「当前」标着现在生效的那个；不是绿色 = 还没重启，magpie 读到的是旧值

## 内置镜像站与测速

自带 9 个：`gh-proxy.com`、`gh-proxy.org`、`v4.gh-proxy.org`、`cdn.gh-proxy.org`、`ghfast.top`、`gh.llkk.cc`、`ghps.cc`、`ghproxy.net`、`gh-proxy.net`。

测速不是 ping 首页，而是让镜像**真的去拖一段 GitHub 的 release 附件**
（`jqlang/jq` 的 `jq-windows-amd64.exe`，1.4 MB，带 `range: bytes=0-524287`）：

- 先等响应头，最多 **10 秒**（镜像要先回源，2–4 秒很常见）
- 拿到头后再量 **3 秒** 的下载速度，算出 KB/s
- 头两个字节必须是 `MZ`（Windows exe 的魔数）——不少「镜像」其实回的是一个 `Loading...` 的 HTML 页面，这种会被判**返回的不是那个文件**
- 一次只跑 3 个并发：这条线的总带宽就那么大，全开反而每个都测成 0

结果会记在 `%USERPROFILE%\.config\magpie\github-prefix-mirrors.json` 的 `last` 里，下次打开页面还是那些数字。自定义镜像放在同一个文件的 `custom` 里。

2026-11-01 实测（本机线路，仅作参考）：`gh-proxy.org` 180 KB/s > `v4.gh-proxy.org` 53 KB/s > `cdn.gh-proxy.org` 51 KB/s > `gh-proxy.com` 44 KB/s；`ghfast.top`、`gh.llkk.cc`、`ghps.cc`、`ghproxy.net` 连不上；`gh-proxy.net` 回的是页面不是文件。镜像站时快时慢，隔几天自己再点一次「测速全部」。

## 它到底改了什么

magpie 自己拼 URL：`前缀 + 原地址`。插件只负责把「前缀」写到两个地方：

| 位置 | 键 | 管什么 | 什么时候生效 |
| --- | --- | --- | --- |
| 用户环境变量 | `MAGPIE_MIRRORS=on`<br>`MAGPIE_GITHUB_MIRROR=前缀` | 插件市场、来源下载、GitHub 登录（magpie 进程里发的请求） | **重启 magpie** |
| `settings.json` | `updateMirror` | magpie 自己更新 | 立刻 |

被改写的域名：`github.com`、`api.github.com`、`raw.githubusercontent.com`、`codeload.github.com`。

`updateMirror` 是让 magpie 自己写进去的（`magpie update mirror <前缀>` / `off`），不是插件去改 JSON：
这个键在 magpie 里带 `omitempty`，它用内存里那份设置回写文件时会把「它没读到过的值」丢掉，直接改文件会时灵时不灵（表现就是页面上「应用更新」一栏变回 `—`）。命令行写不进去时才退回改 JSON。

为什么一定要重启：magpie 在**每个请求**去看进程自己的环境变量，而 Windows 改不了已经跑起来的进程的环境。这是系统行为，不是插件偷懒——所以「保存」之后页面上会显示「已保存，重启后生效」，点「重启 magpie」由插件替你重开。

## 前缀怎么写

- `gh-proxy.com` → 自动补成 `https://gh-proxy.com/`，也自动补尾斜杠（magpie 是直接拼字符串，少个斜杠就拼成 `https://gh-proxy.comhttps://github.com/...`）
- 只接受 `http(s)://主机/` 这种纯前缀，路径越长（`https://x/y/`）会当成前缀的一部分直拼
- 关掉：清空输入框保存

## 页面显示「此页面已停止工作 / 没有响应」

magpie 有个看门狗：页面 10 秒内必须有一次 `hello` 回到它那里，否则就把 iframe 换成「重试」卡片。
带路页 `page/boot.js` 因此是「先等 hello，再导航」（最多等 6 秒，8 秒硬走），没有 bridge 时自己按同样格式发一次 hello。

看到这张卡片说明这次没来得及——最常见的原因是插件刚被重载（`magpie plugin off/on`、升级插件），
magpie 给页面的是带版本号的地址，旧的那份已经 404 了。**点「重试」就好，不用重装。**
装好之后正常用不会再出现。

万一「重试」也救不回来（magpie 内存里那份旧地址一直 404，它只会照着那一份重试），
就双击插件目录里的 **`restart-magpie.cmd`**：它按注册表里的前缀关掉 magpie、重新打开，
再 `magpie plugin on` 把插件重新登记一遍（页面地址也就换了新版本）。之后回到「GitHub 镜像」页点一次「重试」。

## 实现

- `index.mjs`：一个 Node 内置 `http` 服务，固定端口 **3487**（固定，因为带路页 `page/boot.js` 里写死了同一个数字；端口被占就每 2 秒重试，不会漂移）
- 接口：`GET /api/state`、`GET /api/mirrors`、`POST /api/speedtest {prefix?}`（不传就测全部）、`POST /api/mirrors/add {prefix}`、`POST /api/mirrors/remove {prefix}`、`POST /api/apply {prefix}`、`POST /api/restart`
- 「现在用的是哪个前缀」不存插件自己的文件：唯一真源就是上面那两个系统位置，省掉「插件说自己开着、其实 magpie 没读到」这种不同步。插件只额外存一份**镜像清单的备注**（自定义项 + 上次测速结果）在 `github-prefix-mirrors.json`
- 重启：生成一个 `restart.ps1`（UTF-8 带 BOM，PowerShell 5.1 读中文才不会乱），用 WMI `Win32_Process Create` 拉起——父进程是 WmiPrvSE，不在 magpie 的作业对象里，所以 magpie 被杀掉后它还能把 magpie 再开起来；它先从宿主进程往上找到真正的 `magpie-windows-amd64.exe`（并记住是不是带 `tray` 启动的），再 `taskkill /T /F` + 重新 `Start-Process` + `magpie plugin on`（页面地址换新版本）
- 重启日志：`%TEMP%\magpie-github-prefix-restart.log`
- 页面为什么能调本地接口：magpie 把插件页放在 `sandbox="allow-scripts"`（没有 `allow-same-origin`）的 iframe 里，页面 origin 是不透明的 `null`，所以它到 `127.0.0.1:3487` 的每个请求都算跨域。服务因此对 GET/POST 都回 `access-control-allow-origin: *`，并单独应答 `OPTIONS` 预检。少了这两行，页面会显示 `Failed to fetch`
- 只做 Windows：改的是 `HKCU\Environment`，重启走 PowerShell / WMI。别的系统上插件能起来但没东西可改

## 开发

```bash
node index.mjs                                  # 直接当本地服务跑（默认 3487）
MGP_PORT=3499 node index.mjs                    # 换个端口试跑
node index.mjs --print-restart-script           # 打印那段 PowerShell（不执行），配 MGP_PID / MGP_PREFIX
```

`page/boot.js` 里写死了 3487，换端口试跑时页面进不去，直接开 `http://127.0.0.1:3499/` 看界面就行。

## 卸载

```bash
magpie plugin rm github:aduoer/magpie-github-prefix
```

想连前缀一起恢复直连：先在页面上「关掉」再卸，或者 `magpie update mirror off` + 删掉那两个用户环境变量。

MIT
