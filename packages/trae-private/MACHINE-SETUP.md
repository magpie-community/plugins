# 安装与检查

```sh
magpie plugin add <插件目录>
magpie plugin login trae-private
```

选择浏览器登录并填写企业 HTTPS 地址。已有本机 traecli 登录时也可选择导入；插件续期会轮换 refresh token，可能使 CLI 的旧凭据失效。

Magpie 在远程服务器时，在本地浏览器完成认证，再将最终的完整 loopback 回调地址粘贴回 Magpie。无需安装服务器浏览器或开放公网回调端口。各机独立认证，不复制账号文件。

检查项目：

1. 登录成功，账号已保存，模型来自该部署目录。
2. 用量显示席位；可选网页会话有效时追加基础／超额／内置模型明细。
3. 流式与非流式请求按上游结果返回；额度耗尽显示 429 并保持登录。
4. 临近到期由 Magpie 续期，保存新 access、refresh 和到期时间。
5. 临时目录故障沿用缓存；宿主重启后需要一次成功获取目录。

离线回归：

```sh
node index.test.mjs
bun test ./index.test.mjs
```

需要 Node；Bun 入口运行同一套隔离测试。账号、网页会话与浏览器数据不随包分发。平台验证结果见 [真实部署记录](docs/real-deployment.md)。
