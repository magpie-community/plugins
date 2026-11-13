# magpie-comate-auth

一个面向 [Magpie](https://usemagpie.ai) 的文心快码（Baidu Comate）供应商插件。它把 Comate 账号、会员积分和 15 个模型接入 Magpie，供 Claude Code、Codex、OpenCode 等客户端统一选用。

本项目基于 [ikashana/magpie-comate-auth](https://github.com/ikashana/magpie-comate-auth)，由 qaz139688 维护修复版本。原项目采用 MIT License。

## 功能

- **15 个 Comate 模型**：DeepSeek V4 / V4.1、GLM-5 系列、Kimi K2.6、MiniMax M3、ERNIE 5.5 等。
- **一键设备授权**：在百度页面确认一次即可取得 License，不需要复制 Cookie。
- **实时积分卡**：使用 `comate.baidu.com` 网页登录态读取席位积分、增购积分和赠送积分。
- **官方上下文同步**：每天从 Comate 官方模型目录同步 `maxContextWindow`，并以 24 小时缓存避免频繁请求。
- **图片输入**：支持官方声明支持图片的模型。
- **无额外运行依赖**：模型请求直接调用 Comate HTTP API，不需要安装 Zulu CLI。

## 安装

```bash
magpie plugin add github:qaz139688/magpie-comate-auth
```

安装后在 Magpie 的“文心快码 Comate”账号卡选择登录方式。

## 登录

1. **官网设备授权**：推荐方式。插件打开 Comate 登录页后，登录并确认授权这台设备，约 3 分钟内自动完成。
2. **浏览器 Cookie**：如果还要在账号卡显示实时积分，使用网页登录方式并提交 `comate.baidu.com` 请求头中的 Cookie。
3. **复用 Magpie 登录态**：尝试读取 Magpie 中已有的 Comate 或 DuMate 凭据。DuMate 凭据不保证适用于 Comate。

登录凭据只保存在本机 Magpie 的数据目录中，不会提交到本仓库。请勿分享 `plugin-auth.json`、Cookie、License 或其他账号凭据。

## 模型上下文

插件内置官方值的离线兜底，并自动请求：

```text
POST https://comate.baidu.com/api/v2/api/models/available
```

当前上下文上限包括：

| 上下文 | 模型 |
| --- | --- |
| 1,024,000 | DeepSeek V4 Flash、DeepSeek V4 Pro |
| 1,000,000 | DeepSeek V4.1 Flash、ERNIE 5.5 Flash Preview、GLM-5.2、GLM-5.3、GLM-5.3-Flash |
| 512,000 | MiniMax M3 |
| 256,000 | GLM-5.1、Kimi-K2.6 |
| 200,000 | GLM-4.7、GLM-5-Turbo、GLM-5v-Turbo、MiniMax M2.5、MiniMax-M2.7 |

同步缓存保存在 Magpie 数据目录的 `comate-model-contexts.json`。接口失败时使用最近一次缓存；没有缓存时使用内置兜底值。

## 开发与验证

```bash
npm test
magpie plugin add <本地目录>
magpie provider test comate
```

## 致谢与许可

- 原始项目：[ikashana/magpie-comate-auth](https://github.com/ikashana/magpie-comate-auth)
- 上游接口与设备授权流程参考百度官方 Zulu 客户端。
- 本项目采用 [MIT License](./LICENSE)。
