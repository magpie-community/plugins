# QuWork for Magpie

社区供应商 `quwork`。插件会打开专用 Chrome/Edge 窗口，在 QuWork 官网完成登录；也会读取官网登录态中的账号 token，并尝试取得模型凭据。插件内置 10 个模型条目，实际可用模型由 QuWork 和账号权益决定。

## 安装与使用

在 Magpie 的「插件 → 添加插件」选择本地插件目录，或在社区仓库根目录运行 `magpie plugin add ./packages/quwork`。

1. 在「供应商 → QuWork → 登录」选择「官网浏览器登录（自动读取登录态）」。
2. 在弹出的专用浏览器窗口里打开 QuWork 官网，点「注册 / 登录」，选择短信验证码或微信登录。手机号和验证码只在官网页面填写。
3. 登录成功后，Magpie 会读取官网 localStorage 中的 `quwork_web_token`，并尝试从登录响应中取得 `llm_token`。如果上游没有返回模型凭据，登录菜单里仍可填写 QuWork 授权用于第三方接入的 `sk-` 模型密钥。

## 积分余额

模型密钥用于模型调用，个人账号积分请在 QuWork 官方入口查看。已有有效旧版积分凭据的账号仍可在 Magpie 的「额度（Quota）」页查看总余额、限时积分和永久积分，具体字段以上游返回为准。也可运行 `magpie quota quwork`。

官网登录读取的是 QuWork 官网自己写入的登录态；积分查询和模型调用仍受 QuWork 使用规则约束。官方协议第 2.3.2 条规定未明示授权的权利需另获书面许可，第 8.2 条允许对违规行为暂停或终止服务。[Clawork 软件许可及服务协议](https://llm.rrzu.com/claw-agreement)

## 开发验证

在插件目录运行 `node --test index.test.mjs`。测试覆盖官网入口、模型密钥校验和旧版余额兼容，使用模拟凭据。社区仓库从根目录运行 `bun scripts/check.mjs quwork`。社区代码采用 MIT 许可。
