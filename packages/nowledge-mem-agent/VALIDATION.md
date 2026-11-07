# 验证记录

日期：2026-11-07（Asia/Hong_Kong）。

## 环境

- macOS；Magpie `0.1.3212`，应用内 CLI。
- Nowledge Mem API / CLI `0.10.115`。
- Node.js `v24.11.1`；插件实际由 Magpie 的 Bun 宿主运行。

## 自动化验证

`npm test`：19 项测试。覆盖官方 Agent `connect` 数据、三项用途接入、模型切换、幂等、原用途及 Remote 模式恢复、手动修改保护、失败后重试、恢复中断、首个 provider 自动激活、旧版空 provider 占位项、后端身份绑定、独立后端认证、进程锁、权限、损坏 JSON 及紧急恢复暂停。

`npm run check` 与 `git diff --check`：语法及空白检查。

## 实际 Magpie 集成

运行 `tests/magpie-smoke.mjs`，使用实际安装的 Magpie CLI 和 Bun 宿主。Magpie 配置注册表、网关端口、provider、插件副本和选择文件均在临时目录；Nowledge API 与上游由本地测试服务器模拟。

验证了：

- `magpie.agent` + `main` 包被识别为 Agent，出现正确名称。
- moejs 成功执行 `agent.js`；实际下发网关地址与 Agent key。
- Bun 宿主把选择同步至 Default、AI Now、Background。
- 切换第二个模型及 `magpie nowledge-mem default` 后完整恢复。
- 选择文件权限收紧为 `0600`。
- 模型请求数为零。

## 实际 Nowledge API 合约

运行 `tests/nowledge-contract.mjs`，在未启用 Remote、没有已配置模型的本机实例上临时创建独立 `magpie:<id>` provider，并在 `finally` 中删除。

验证了 `provider_type: magpie`、实例 id、模型、context window、输出限制、密钥屏蔽及创建／删除请求体。首次创建 provider 会自动成为默认，即使请求带 `no_activate`；`preserve_enabled` 保留关闭的 Remote 模式。测试后用途、原 active provider、provider 表和模式均与测试前一致。临时 provider 的 key 为仅供测试的占位值。

额外核对：默认用途不接受 `provider: null`（HTTP 400）；AI Now 和 Background 可通过空 provider/model 恢复继承。因此最初没有默认 provider 的情况，通过删除插件自己的 provider 恢复。

上述 provider 管理 REST 路由不在该版本服务的 OpenAPI 文档中；请求体依据官方安装包内的客户端代码及实际 API 核对。

## 验证边界

没有发起真实付费模型调用，没有测试实际 AI Now 的多轮工具调用、长上下文压缩或真实上游故障切换。这些由 Nowledge 与 Magpie 的运行时处理。后续 Nowledge 版本、远程反向代理、Windows/Linux 尚未实机验证。退出／停用插件宿主后需要手动恢复的限制见 README。

## 发布包

不包含 API key、用户的 Magpie 配置或 Nowledge 数据；没有 npm 依赖或安装脚本。ZIP 提供完整源码及测试，npm tarball 只包含运行文件、说明、许可证和本验证记录。
