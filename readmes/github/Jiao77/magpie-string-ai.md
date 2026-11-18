# magpie-string-ai

[String AI](https://www.string.ink/) 的 [Magpie](https://usemagpie.ai/) 供应商插件。登录账号后自动读取全部可用 API Key，加载各密钥可用的模型，并在请求时选择对应密钥。余额和分组额度显示在一张供应商卡片中。

## 安装和登录

```bash
magpie plugin add github:Jiao77/magpie-string-ai
magpie plugin login string-ai
```

选择“浏览器登录 String AI（支持人机验证和远程 Docker）”：

1. 在打开的 String AI 官网完成登录、人机验证和账号要求的两步验证。已有网页登录状态时可直接完成授权。
2. 浏览器跳转到 `http://127.0.0.1:18465/auth/callback?code=…&state=…` 后，复制地址栏里的完整地址。
3. 返回 Magpie，把该地址粘贴到登录窗口的回填输入框并提交，然后保存供应商设置。

回调页面显示“无法访问此网站”是正常的：插件通过回填地址完成授权，不监听本地端口。本机和远程 Docker 使用相同步骤，无需增加 Docker 端口映射、反向代理或填写服务器回调地址。CLI 用户将地址粘贴到终端的授权码提示中即可。

插件使用 String AI 官方 Launcher 的公开 PKCE 授权流程（客户端 ID：`stringai-launcher`），通过 `/api/v1/launcher/auth/start` 和 `/api/v1/launcher/auth/exchange` 获取账号登录凭据。密码、验证码和 Turnstile 验证均由官网处理。插件不调用 Launcher 的托管密钥创建、轮换或撤销接口。

回填地址包含一次性授权码，只粘贴到本次 Magpie 登录窗口。插件检查回调地址、`state` 和有效期，使用本次登录保存在内存中的 PKCE verifier 交换凭据。Magpie 保存并自动刷新登录 Token；插件读取账号下已有的普通 API Key，不另存模型密钥缓存文件。

## 自动同步

- 分页读取账号下的密钥，保留站点返回的分组 ID、名称和平台信息。
- 导入处于启用状态且未过期的普通 API Key，跳过停用和站点隐藏的托管密钥。
- 通过每个 Key 的模型接口确定可用模型，请求使用实际提供该模型的 Key。
- 同一模型由多个 Key 提供时，按密钥列表顺序使用第一个可用 Key。
- 在 Magpie 重新获取模型时同步新增和删除的密钥；余额刷新时读取当前账号余额和密钥额度。
- 账号下没有可用 Key 时显示明确提示。插件不创建、修改或删除站点上的密钥。

已有的手动 API Key 登录继续可用，也可以在登录方式中选择“手动填写 API Key”。

## 验证

```bash
npm test
```

测试覆盖 PKCE、回调回填、state 校验、授权过期、分页同步、模型与密钥关联、账号隔离、密钥移除、Token 刷新和错误提示。测试中的 String AI 服务响应使用接口契约数据；真实账号授权通过官网完成。

## 许可

[MIT](LICENSE)
