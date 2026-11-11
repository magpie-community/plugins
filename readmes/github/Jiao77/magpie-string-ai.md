# magpie-string-ai

[String AI](https://www.string.ink/) 的 [Magpie](https://usemagpie.ai/) 供应商插件。登录账号后自动读取全部可用 API Key，加载各密钥可用的模型，并在请求时选择对应密钥。余额和分组额度显示在一张供应商卡片中。

## 安装和登录

```bash
magpie plugin add github:Jiao77/magpie-string-ai
magpie plugin login string-ai
```

选择“登录 String AI（远程 Docker 兼容）”。在 Magpie 登录窗口中填写 String AI 邮箱、密码和可选的两步验证码。登录信息由插件直接请求 String AI，成功后自动导入全部 API Key。这个流程不启动浏览器回调页，也不需要填写回调地址，远程 Docker 和本机使用同一套流程。

密码只用于向 `https://www.string.ink` 提交本次登录请求。插件通过 Magpie 保存登录 Token，并自动刷新。API Key 从账号接口读取，不另存模型密钥缓存文件。

使用 Google、GitHub 或微信登录的账号，需要先在 String AI 账号设置中设置密码。此入口使用邮箱和密码登录。

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

测试覆盖本地 HTTP 登录、两步验证、分页同步、模型与密钥关联、账号隔离、密钥移除、Token 刷新和错误提示。测试中的 String AI 服务响应使用接口契约数据；实际账号登录需要在浏览器完成。

## 许可

[MIT](LICENSE)
