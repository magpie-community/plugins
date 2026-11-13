# magpie-clash-nodes

**在 magpie 原生窗口里选用 Clash / mihomo 梯子节点**：给整个供应商、或同一供应商的每个账号，分别指定不同节点。一个插件、一个页面，不装额外服务。

```powershell
magpie plugin add github:player462/magpie-clash-nodes
```

装好后，magpie 侧栏 **Plugins** 组会多出一个「**梯子节点**」标签页（跟随窗口浅色/深色主题）。

> **插件市场**：仓库已打上 GitHub topic `magpie-plugin`，会出现在 magpie 的 **Plugins → Discover → Unofficial, on GitHub**（按 star 排序，可搜索 `Clash` 或 `player462`）。从市场卡片直接 Install 即从本仓库安装，无需 npm。
> 要被收录进 **Community** 分区（`magpie-community/plugins` 的 `registry.json`），需要以 `@magpie-community/page-clash-nodes` 提交 PR 并由维护者审核；本仓库保持独立发布。

## 功能

页面从上到下就三块：

1. **控制行**：`供应商` 下拉 + `节点` 下拉 + `按账号分配` 开关 + `应用` / `还原`
   - 不勾「按账号分配」：选中的节点作用到**整个供应商**
   - 勾选后：展开该供应商的每个账号，**每个账号一个节点下拉**；顶部节点下拉可先把所有账号统一填一遍，再单独调个别账号
2. **可用节点池**（折叠区，默认收起）：**严格白名单**——勾选哪些 Clash 节点可用，插件就只给这些节点开本地端口；**一个都不勾选就一个节点也不可用**（不会偷偷回退成「全部」）。「使用全部节点」是单独的显式按钮。
   - **多个订阅同时用**：顶部「订阅」一行列出 Clash Party 的所有订阅（带节点数，当前订阅标「当前」），勾选需要的几个，点「应用订阅」后，它们的节点会合并进同一个独立 mihomo 实例——来自不同机场的节点可以同时出现在下拉框里、同时给不同账号使用。首次只启用 Clash 当前订阅；节点名带订阅前缀（如 `一元机场 · 香港01`），重名不会冲突。
   - **Clash 里切换供应商**：只改 Clash 的 `current` 指针，不会删除旧订阅的 `profiles/<id>.yaml`；插件自己直接读这些文件并运行独立 mihomo，所以旧供应商的节点仍然可选、可用。插件有自己的订阅勾选，不随 Clash 当前供应商自动切换；要用新供应商，把它的订阅勾上并点「应用订阅」即可。
   - 每个订阅是一个**独立折叠块**，只展开你要看的那个；节点按地区分组，显示延迟彩丸（绿 <300ms / 黄 <800ms / 橙 <1500ms / 红 ≥1500ms）与端口号
   - **⚡ 测全部延迟**：通过插件自己的实例测所有已启用节点
   - **保存并同步端口**：按勾选重建本地端口实例；清空后保存会停止节点实例并显示「没有可用节点」
   - 节点特别多的订阅（例如 700+ 节点）首次会均衡勾选 120 个，避免一上来开几百个端口；需要更多可手动勾选或点「使用全部节点」
3. **状态行**：每次操作的结果反馈

右上角 **↻ 刷新**：Clash 更新订阅后点一下，插件会重新读取所选订阅的配置文件，新节点立刻出现；下线的节点会标为失效并提示。

写入是 magpie 原生的 `providers.json`（供应商级 `proxy`、账号级 `accountProxies`），magpie **每个请求都会重读**，改完即生效，无需重启。`还原` 恢复这次会话改过的一切。

### 账号分配会记住
- 切到别的供应商再切回来，**已保存的账号节点会原样恢复**，并自动打开「按账号分配」。
- 还没点「应用」的改动也按供应商分别保留，切走再回来不会丢；行尾会标「待应用」。
- 只提交你实际改过的行，没动过的账号绝不被清空。
- 原先选的节点从池子里消失时，那一行会标红并提示「节点已失效」，同时给出「自动匹配可用节点」按钮，点一下再应用即可。

### 其他细节
- 自动过滤 magpie 里「账号名 = 供应商名」的占位登录（例如 ZCode 会写一条 `user: "ZCode"` 的假账号）。
- 每个节点**固定端口**（记录在 `ports.json`），换订阅 / 重建实例都不会让某个账号悄悄走到别的节点。
- 插件启动时自动拉起节点端口实例；实例意外退出会自动重建。节点实例通过 Windows WMI 启动在 magpie 的 job 之外，所以打开/刷新插件页面（会重载插件宿主）不会把 `18001+` 端口一起带走；插件宿主每 15 秒做一次健康检查，实例被杀或崩溃会自动拉起。

## 依赖与说明

- **Clash Party / mihomo 正在运行**（通过其 Windows 命名管道外部控制器通信；Clash Verge 等 TCP 控制器也支持，`MIHOMO_HOST/PORT/SECRET` 环境变量可指定）。
- 多订阅读取 Clash Party 的 `profile.yaml` 与 `profiles/<id>.yaml`，兼容两种订阅格式：块式 `- name: …` 和流式 `- { name: '…', type: … }`；不同机场的列表缩进（2/4 空格）会在合并时统一，生成后先用 `mihomo -t` 校验再启动，避免配置错误导致端口静默全断。机场的流量/到期广告节点会被过滤。
- 勾选节点保存后，会启动一个**独立的 mihomo 实例**，把每个池内节点绑到 `127.0.0.1:18001+` 的一个本地 HTTP 端口——**不动**你正在用的 7890 / 系统代理 / TUN / 订阅。实例若意外退出，下次任何分配操作会自动重建（状态做活性检测，不谎报）。
- 每个节点固定端口（`ports.json`），换订阅 / 重建实例都不会让某个账号悄悄走到别的节点；旧版本的裸节点名会自动迁移到新命名。
- 账号列表读取 magpie 的 `logins.json` + `providers.json`；也可用配套 CLI 刷新缓存（可选）。
- 所有状态存在 `~/.config/magpie/clash-nodes/`，卸载插件即弃。

## 会不会干扰系统代理？

**不会。** 插件与系统代理完全隔离：

- 系统代理（Windows `Internet Settings` 的 `ProxyEnable` / `ProxyServer`）由 Clash Party 自己设置，插件从不读写这些键，代码里没有任何注册表 / `netsh` / WinHTTP 调用。
- 插件启动的独立 mihomo 实例：`mixed-port`、`port`、`socks-port`、`redir-port`、`tproxy-port` 全为 `0`，`tun.enable=false`，`dns.enable=false`，`allow-lan=false`，只监听 `127.0.0.1:18001+` 的 `listeners`。它不接管流量、不建虚拟网卡、不改路由或 DNS。
- 与 Clash Party 主进程**不同工作目录、不同配置、不同端口、不同进程**；停止插件实例只按自己记录的 pid 杀自己的进程，不会动 Clash Party。
- 唯一影响是 **magpie 自己的请求**：写 `providers.json` 的 `proxy` / `accountProxies`，让指定供应商/账号走 18001+ 端口。其他软件、浏览器、系统流量仍走 Clash 的 7890。
- 附带的 CLI 有 `clash-nodes select "节点名"`，那是**主动**切换 Clash 当前节点（会改变系统代理出口），插件页面本身不调用它。
- 若 18001+ 被其他软件占用，实例会启动失败并报错，不会去改系统代理或抢占 7890。

## 工作原理（为什么页面长这样）

magpie 插件页跑在 `sandbox="allow-scripts"` + `connect-src 'none'` 的 iframe 里：没有 fetch、没有内联脚本。页面与插件的唯一通道是 `magpie.options.set()`（触发 Bun 插件 host 重载）：

```
页面 options.set({cmd, cmdId}) → host 执行命令 → 重写 page/state.js → 页面动态加载 state.js 读回
```

`index.html` 由 `build.mjs` 生成：bridge 与 app 以 `data:` URL 内嵌（magpie web 的 CSP hash 与内联文本不匹配，`data:` 是其明确允许的通道；桌面端则走原生相对路径脚本，`data:` 仅在 `window.magpie` 缺失时兜底）。

## 开发

```powershell
# 改 page/app.js 或 page/template.html 后：
node build.mjs
magpie plugin off github:player462/magpie-clash-nodes ; magpie plugin on github:player462/magpie-clash-nodes
```

> 提交前把 `page/state.js` 重置为占位符：插件运行时会把它改写成当前账号/节点状态，那是本机隐私数据，不能进仓库。

`lib/` 是零依赖 Node/Bun 代码（mihomo 命名管道控制器、每节点监听实例、providers.json 读写）。

## 致谢与许可

- `page/bridge.js` 取自 [yetone/magpie](https://github.com/yetone/magpie)（MIT），是 magpie 为插件页提供的官方桥接。
- 本插件 [MIT](LICENSE) © player462。magpie 是 [yetone](https://github.com/yetone) 的作品。
