# QuWork for Magpie

社区供应商 `quwork`。账号登录在 QuWork 官网完成，Magpie 可使用 QuWork 授权用于第三方接入的模型密钥。插件内置 10 个模型条目，实际可用模型由 QuWork 和账号权益决定。

## 安装与使用

在 Magpie 的「插件 → 添加插件」选择本地插件目录，或在社区仓库根目录运行 `magpie plugin add ./packages/quwork`。

1. 在侧栏「QuWork 接入」点「打开 QuWork 官网」，或在浏览器打开 [QuWork 官网](https://quwork.cn/)。
2. 在官网点「注册 / 登录」，选择短信验证码或微信登录。手机号和验证码请在官网页面填写。
3. 获得 QuWork 授权用于第三方接入的模型密钥后，在「供应商 → QuWork → 登录」填写。官网账号与 Magpie 的自动关联需要 QuWork 提供第三方授权接口，目前尚未查到该接口。

## 积分余额

模型密钥用于模型调用，个人账号积分请在 QuWork 官方入口查看。已有有效旧版积分凭据的账号仍可在 Magpie 的「额度（Quota）」页查看总余额、限时积分和永久积分，具体字段以上游返回为准。也可运行 `magpie quota quwork`。

旧版积分查询使用非公开接口，受 QuWork 使用规则约束。官方协议第 2.3.2 条规定未明示授权的权利需另获书面许可，第 8.2 条允许对违规行为暂停或终止服务。[Clawork 软件许可及服务协议](https://llm.rrzu.com/claw-agreement)

## 开发验证

在插件目录运行 `node --test index.test.mjs`。测试覆盖官网入口、模型密钥校验和旧版余额兼容，使用模拟凭据。社区仓库从根目录运行 `bun scripts/check.mjs quwork`。社区代码采用 MIT 许可。
