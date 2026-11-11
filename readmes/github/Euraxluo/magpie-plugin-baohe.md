# magpie-plugin-baohe · 宝盒网络哨兵

在 [magpie](https://github.com/yetone/magpie) 窗口里加一个「宝盒网络」页面：一眼看清中通宝盒 lite（zbox-lite）的内网认证/公网/补丁/守护状态，断网时一键无头重连，并对本机宝盒客户端直接生效。

A magpie plugin page: watch and repair the ZTO Baohe (宝盒lite) intranet auth right from magpie — portal status, one-click headless reauth, client patch and daemon control.

![status](https://img.shields.io/badge/magpie-%3E%3D0.1.1340-blue)

## 它对宝盒做什么

| 能力 | 实现 |
| --- | --- |
| 内网认证探测 | 直连认证门户 `10.10.9.2`，识别 `network is connected` / 被重定向 |
| 立即重连 | 触发无头协议 `open ztoimbox://reauth`（宝盒客户端补丁提供的通道），锁屏/夜间也能走 |
| 客户端补丁 | 调用 `baohe-auth patch apply`：解除夜间 00:00~06:00 强制断网、auth-break 自动重连、随宝盒自拉起 |
| 守护管理 | 查看/重启 launchd 服务 `com.zto.baohe-auth`（`baohe-auth watch --interval 0.5`） |
| 宝盒重启 | killall + open -a（两段式确认），重启后补丁才被新进程加载 |
| 日志速览 | `~/Library/Logs/baohe-auth.{log,err.log}` 各最近 40 行 |

## 前置条件

- macOS + 宝盒 lite 装在 `/Applications/宝盒lite.app`
- 已安装 [baohe-auth-cli](https://github.com/Euraxluo)（`~/.local/bin/baohe-auth` + launchd `com.zto.baohe-auth`）。没有它时页面只显示状态、其余动作不可用。

## 安装（magpie 内）

1. 打开 magpie → **Plugins** → **Install from GitHub**，输入：

   ```
   Euraxluo/magpie-plugin-baohe
   ```

2. 或从本地文件夹安装：选择本仓库目录。
3. 侧栏出现「宝盒网络」页面。页面加载后由插件宿主自动拉起本地服务（默认 `127.0.0.1:3491`，可在插件选项 `port` 里改）。

## 安全模型

- 服务只绑 `127.0.0.1`，校验 `Host`（挡 DNS 重绑定）。
- magpie 沙箱页面的 `Origin: null` 放行，其余跨站来源拒绝。
- 每进程随机 token 注入页面，全部 `/api/*`（除 ping）要求 `x-baohe-token` 头 —— 恶意网站的跨站简单 POST 过不了预检。

## 手动运行服务（不进 magpie）

```bash
node serve.mjs   # http://127.0.0.1:3491，浏览器直接打开就是同一个面板
```

## License

MIT
