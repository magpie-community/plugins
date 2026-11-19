# 代理池（magpie 插件）

把 Clash 的节点变成一个可轮换的**出口 IP 池**，给 magpie 的模型插件用。
**无内核、无下载、无第三方依赖**——只借用你现有的 Clash Verge listener。

## 装好即用，不需要命令行

```bash
magpie plugin add github:FHKKMD637/magpie-proxy-pool
```

- magpie 加载插件时会**自动启动**本地服务（127.0.0.1:3492），不需要你手动 `serve`。
- 入口：导航栏 **插件 → 代理池**（看不到就刷新一下 magpie 窗口）。
- 首次启动会自动从 Clash 发现出口；有没测过的节点会自动后台测一轮。
- 所有操作都在页面里：**重新发现 / 全部测速 / 添加 / 启停 / 删除**。

## 页面

| 操作 | 作用 |
|---|---|
| 重新发现 | 从 `Merge.yaml` 读 `listener.users`（Clash 改完节点后点） |
| 全部测速 | 每个出口访问 `api.ipify.org`，记录真实出口 IP / 延迟 / 可用 |
| 添加 | 加一个自定义 `http(s)://` / `socks5://` 代理 |
| 每行 | 勾选启停、删除 |

ss/vmess 节点不支持直接添加（需要 Clash 落地）：改 Clash 的 `Merge.yaml` listener users，Reload 后点「重新发现」。

## 它复用的是什么

你 Clash Verge 的 `Merge.yaml` 里带 `users` 的 listener，例如：

```yaml
listeners:
  - name: zcode-node-auth
    type: mixed
    port: 7892
    listen: 127.0.0.1
    users:
      - username: "香港13家宽"
        password: "set-your-secret"
```

mihomo 的 `IN-USER` 规则把每个 username 绑到一个节点，于是：

```
http://香港13家宽:set-your-secret@127.0.0.1:7892   →  一个独立出口 IP
```

「代理池」把这些汇总、测速、增删启停，产出 `~/.config/magpie/proxy-pool.json` 给模型插件按请求轮换。

## 数据

`~/.config/magpie/proxy-pool.json`（权限 0600，含代理密码）：

```json
{
  "listen": "127.0.0.1:7892",
  "nodes": [
    { "name": "香港13家宽", "proxy": "http://香港13家宽:set-your-secret@127.0.0.1:7892",
      "enabled": true, "alive": true, "ip": "141.11.146.69", "latencyMs": 465 }
  ]
}
```

## 模型插件怎么用

`magpie-yakit-free`（或任何模型插件）读这个文件，每个请求轮换一个 `proxy`，遇到 429/403 自动换下一个。
它不关心出口是 Clash username 还是自定义代理。

## 调试（可选，不是使用前提）

```bash
cd ~/.config/magpie/plugins/node_modules/magpie-proxy-pool
bun cli.mjs list     # 看池子
bun cli.mjs test     # 测速
```

## 边界

- 只做「出口池 + 轮换」，不改 magpie 的 `accountProxies`、不碰账号/密钥。
- 池子是共享免费额度的放大器，服务端仍有全局 RPM/TPM、单 IP 风控，别把并发拉太猛。
