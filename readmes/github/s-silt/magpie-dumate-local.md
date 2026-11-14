# Magpie 百度搭子插件

用自己的百度搭子（DuMate）账号在 Magpie 里调用模型。支持普通和流式聊天，以及只读积分查询。

## 安装与登录

在 Magpie 的「插件 → 发现 → 非官方 → GitHub」中查找 **magpie-dumate-local**，也可以直接运行：

```sh
magpie plugin add github:s-silt/magpie-dumate-local
magpie plugin login dumate-local
```

在[百度智能云](https://login.bce.baidu.com/?from=oa_dumate&redirect=https%3A%2F%2Fconsole.bce.baidu.com%2F)登录后，从开发者工具的 Network 面板复制发往 `console.bce.baidu.com` 的 `Cookie` 请求头值（含 `bce-sessionid`），粘贴到 Magpie 的遮盖输入框。Magpie 将会话保存在本机的 `plugin-auth.json`，请勿分享 Cookie。

在供应商设置里勾选要用的模型：

- `dumate-local/model-text`（百度搭子自动路由）
- `dumate-local/deepseek-v41-flash`

模型调用消耗账号积分，`magpie quota refresh dumate-local` 可查询余额。退出使用 `magpie plugin logout dumate-local`。

## 服务器连通性

2026-11-14 实测：一台美国 VPS 能登录百度控制台、查积分，但到模型网关 `dumate-svc.baidu.com:443` 的 TCP 连接超时。香港 VPS 能连通该网关。若在美国 VPS 上遇到同样情况，可在香港 VPS 部署 Magpie，或为 DuMate 供应商单独配置可达的香港出口。

MIT。接口和模型元数据参考 [R227BOUT/magpie-dumate](https://github.com/R227BOUT/magpie-dumate)，原许可证随附。
