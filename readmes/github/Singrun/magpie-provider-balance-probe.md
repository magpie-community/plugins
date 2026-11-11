# Magpie Provider Balance Probe

[![CI](https://github.com/Singrun/magpie-provider-balance-probe/actions/workflows/ci.yml/badge.svg)](https://github.com/Singrun/magpie-provider-balance-probe/actions/workflows/ci.yml)
[![GitHub release](https://img.shields.io/github/v/release/Singrun/magpie-provider-balance-probe?include_prereleases)](https://github.com/Singrun/magpie-provider-balance-probe/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

Magpie 插件，用来识别受支持的第三方 API 中转平台余额接口，并将识别结果写入 Magpie 原生 Provider 余额配置。余额仍由 Magpie 自己读取和展示。

本项目目前为 **0.0.1 预发布版本**。探测规则仅覆盖下文列出的接口和响应结构；不同版本或经过修改的平台实例可能无法识别。

## 能力范围

- 探测 Sub2API、New-API / One-API 和 LiteLLM 的已知余额接口。
- 为识别成功的 Provider 补全或修复 `BalanceURL`、`BalancePath` 和 `BalanceMethod`。
- 检查已配置余额接口是否可用；失效时尝试识别并修复。
- 仅在调用插件工具或独立 CLI 时运行，不启动后台任务或服务。

插件只负责探测和配置修复。探针确认接口结构后写入 Magpie 原生余额字段，之后由 Magpie 原生余额功能读取和展示余额。

## 安装

在 Magpie 的 **Plugins → Discover → Unofficial, on GitHub** 查找本插件，或从公开 GitHub 仓库安装：

```bash
magpie plugin add github:Singrun/magpie-provider-balance-probe
magpie plugin on github:Singrun/magpie-provider-balance-probe
magpie plugin
```

GitHub 发现列表由 Magpie 定期刷新，新仓库或新 topic 出现可能有延迟。也可以在 Magpie 插件管理界面添加仓库地址。

## 使用

启用后，插件注册 `auto_configure_provider_balances` 工具。普通调用会检查尚未配置余额接口或现有接口不健康的受支持 Provider，只对识别成功且需要修复的配置执行写入。

工具支持一个可选参数：

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `force` | `false` | 重新探测使用 Magpie 默认 API Key 认证的 Provider。带自定义 `BalanceToken` 或 `headers` 的 Provider 会跳过自动探测。 |

工具返回识别平台、配置状态和失败原因，不返回余额数值。未知接口不会按猜测结果写入配置。

## 支持的探测接口

| 平台 | 候选接口 | 识别条件 |
| --- | --- | --- |
| Sub2API | `/usage` | 响应包含平台特征字段，且 `remaining` 可解析为有限数值 |
| New-API / One-API | `/api/usage/token` | 响应包含可用额度数值，并符合平台配额结构 |
| LiteLLM Proxy | `/key/info` | 响应包含有限数值 `max_budget` 和 `spend` |

探针会优先保留 Provider URL 中的自定义路径前缀，再按规则尝试候选接口。接口路径或响应结构与上述条件不符时，Provider 会报告未识别并保持原配置。

带自定义余额认证的 Provider 会被跳过。这些认证方式可能需要专用头、令牌或签名，通用探针无法可靠推断，用户可继续使用自己配置的余额字段。

## 独立 CLI

仓库包含一个用于诊断和本机维护的 CLI，需安装 [Bun](https://bun.sh/)：

```bash
bun cli.js --dry-run  # 探测并预览拟议变更，不写入文件
bun cli.js            # 应用识别到的余额配置
bun cli.js --force    # 重新探测默认认证的 Provider
```

CLI 读取当前用户 Magpie 配置目录中的 `providers.json`。建议先运行 `--dry-run` 检查结果，再应用变更。

## 文件安全与隐私

- 探测请求会向 Provider 的余额端点发送该 Provider 的 API Key；请确保你信任该 API 地址。
- 请求设置超时和响应体大小上限，并拒绝自动跟随重定向。
- 插件不会向本项目服务器发送配置、API Key 或探测结果；项目不包含遥测代码。
- 写回前创建 `0600` 备份，使用锁和按 Provider 冲突检查，并通过临时文件原子替换配置。
- 写入只修改 Magpie 的余额配置字段；不会注销账号、删除 Provider 或替换 API Key。
- 锁只协调本工具的并发进程。Magpie GUI 不使用同一把锁，因此无法排除 GUI 恰好在最终检查后保存造成的竞态。

## 故障排查

**Provider 未被识别**：确认该平台实例使用受支持的 API 版本和响应结构。可先运行 `bun cli.js --dry-run` 查看识别结果；不要把包含真实密钥的完整请求或配置提交到 issue。

**已有余额配置但仍不正常**：工具会检查接口状态和 `BalancePath` 解析结果。对于默认 API Key 认证的 Provider，可使用 `force` 参数或运行 `bun cli.js --force` 重新探测。

**自定义认证 Provider 被跳过**：这是有意行为。探针不会覆盖带有 `BalanceToken` 或自定义请求头的余额配置。

## 开发与测试

需要安装 Bun 和 Node.js：

```bash
bun install
bun test
node --check index.js
node --check cli.js
node --check src/cache.js
node --check src/configurator.js
node --check src/detector.js
```

测试使用模拟 HTTP 响应和临时文件验证解析、认证保护、冲突处理及原子写入。它们验证插件代码行为，不替代对实际第三方平台账户和 Magpie 版本的端到端测试。

## 反馈与贡献

提交 issue 时请提供 Magpie 版本、平台类型、脱敏后的响应结构和插件返回的错误信息。请勿发布 API Key、Token、Cookie 或原始 `providers.json`。

Pull request 应包含可复现的问题说明、范围明确的修改和相应测试。新增平台探测支持时，请提供去除凭据和个人数据后的代表性响应样例。

- [报告问题](https://github.com/Singrun/magpie-provider-balance-probe/issues)
- [Magpie 插件规范](https://usemagpie.ai/docs/zh/plugins)
- [变更记录](CHANGELOG.md)

## 许可证

[MIT](LICENSE)
