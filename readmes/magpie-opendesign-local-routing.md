# OpenDesign Local Routing for Magpie

magpie 插件，用于管理多个 OpenDesign 账户，接入更好的路由调度。仅支持 **Magpie（Windows）**。

> **正式版 `1.0.3`。** Windows 自动化检查与隔离宿主测试通过，维护者已确认三种协议的真实请求和正常新增账号可用。故障转移、全部账号不可用及拒绝/中断场景尚未完成真实故障验收；完整覆盖范围与已知限制见 [验收状态](docs/VERIFICATION.md)。
>
> 本项目是非官方社区改造版，不代表 Magpie、OpenDesign 或 magpie-community 背书。

## 功能

- **多账号**：每个账号填写备注名称、Control Key、Workspace ID 和可选的 Runtime Key。没有 Runtime Key 的账号只监控额度，不提供模型，也不参与路由。
- **原生额度窗口**：按 `codingPlan.windows` 的时长识别 5 小时和 7 天窗口，在 Magpie 用量页显示进度与重置时间（返回 `aside: false`，由 Magpie 参与账号排序和故障转移）。
- **请求前额度门禁**：每次推理前实时查询额度。额度耗尽、数据不完整或查询失败时，插件在本地返回 `429`，不向模型端转发，由 Magpie 决定切换到其他账号或后备。
- **凭据本地加密**：Control Key 与 Runtime Key 通过 Windows CurrentUser DPAPI 加密保存；Magpie 的账号记录只含随机引用和非机密信息。
- **三种模型协议**：转发 `/v1/chat/completions`、`/v1/responses`、`/v1/messages`（含 `count_tokens`），并按协议把请求头替换为账号自己的 Runtime Key。
- **与其他供应商隔离**：独立 provider `opendesign-local`，不会改动你已有的 `open-design`、`commandcode` 等供应商或路由组。

## 工作方式

- **添加账号**：先用 Control Key + Workspace ID 读取额度，有 Runtime Key 时再校验模型目录。校验通过后，在完成登录时才用 DPAPI 保存；完成回调开始保存前取消不会写入凭据。写入瞬间取消可能留下孤立密文，详见 [安全说明](docs/SECURITY.md)。
- **额度轮询**：读取 5h / 7d 窗口与可选的套餐摘要。路由账号会额外做一次只读的 `GET /v1/models` 来校验 Runtime Key：所需凭据都有效时通知 Magpie 清除旧的“已退出登录”标记；401/403 标记失效；网络或 5xx 等临时故障保持原状态。
- **模型请求**：先实时读取该账号的额度，再转发到 `amr-link.open-design.ai`。流式响应原样透传，已经开始的流式回复不会被自动重放。

## 环境要求

- Windows 与 Magpie 桌面版（已在 Windows 11 上验证）。插件运行在 Magpie 自带的 Bun 里，已在 Magpie 0.1.3652 + Bun 1.4.4 上验证。
- 每个账号的 Control Key、Workspace ID、Runtime Key **必须属于同一个 OpenDesign 账号/Workspace**。插件无法通过接口证明它们同属一个账号，请不要混填。
- 开发与测试需要 Node.js 22+。

## 安装

1. 从 [v1.0.3 Release](https://github.com/Yuuuuuukit/magpie-opendesign-local-routing/releases/tag/v1.0.3) 下载 `magpie-opendesign-local-routing-1.0.3-desktop.zip` 并解压（也可克隆仓库），放到**由你本人控制的稳定目录**，不要放在多人可写或网盘同步的位置。目录顶层应有 `package.json`、`index.mjs`、`vault.mjs`。
2. Magpie → 插件 → 添加插件 → 本地文件夹，选择该目录。
3. 供应商 → **OpenDesign Local (DPAPI)** → 添加账号，依次填写备注、Control Key、Workspace ID 和可选的 Runtime Key。
4. 在用量页核对 5h / 7d 窗口和重置时间，按 [路由配置](docs/ROUTING.md) 在测试环境验证后，再迁移日常使用。

升级、与旧版共存和排错见 [Windows 安装与升级](docs/INSTALL-WINDOWS.md)。**同一个 Magpie 实例里不要同时启用两个版本的本插件**（provider ID 相同）。

## 安全要点

- Control Key 只发往 `https://amr-api.open-design.ai`，Runtime Key 只发往 `https://amr-link.open-design.ai`；拒绝重定向，不支持自定义目标主机。
- 加密后的凭据保存在 Magpie 配置目录下的 `opendesign-local-routing-vault/`（宿主未提供目录时回退到 `%LOCALAPPDATA%\Magpie\`）；旧版位置只读兼容。
- DPAPI 能防止其他 Windows 用户解密这些文件，但**不能**防御已被控制的当前用户账户，也不能防御被他人改写的插件源码。
- 详细说明、已知限制与漏洞报告方式见 [安全说明](docs/SECURITY.md)。

> **付费风险**：客户端的额度预检只能降低“套餐用尽后走钱包付费”的风险。并发请求和长请求仍可能在服务端跨过额度边界，**不能保证不产生钱包费用**，建议同时在厂商侧设置付费限制。

## 开发与测试

无运行时 npm 依赖。

```powershell
npm run check
npm test
bun test --timeout 30000 ./tests
```

Bun 命令请使用与 Magpie 相同的 Bun（已验证 1.4.4）。Windows 上的测试会调用插件真实的 DPAPI 实现，只使用临时的虚构凭据并清理测试目录；非 Windows 上可以运行离线单元测试，但不能登录真实账号，且绝不会退回明文保存。

可选的系统 DPAPI 自检：

```powershell
powershell.exe -NoProfile -File .\Check-Windows-DPAPI.ps1
```

隔离宿主集成测试的运行方法见 [验收状态](docs/VERIFICATION.md)。

## 文档

- [Windows 安装与升级](docs/INSTALL-WINDOWS.md)
- [路由配置与验收](docs/ROUTING.md)
- [安全说明](docs/SECURITY.md)
- [验收状态](docs/VERIFICATION.md)
- [更新日志](CHANGELOG.md)
- [维护者发布清单](docs/PUBLISH.md)

## 来源、许可与致谢

- 基于 MIT 许可的 [magpie-community OpenDesign 插件](https://github.com/magpie-community/plugins/tree/main/packages/opendesign) 的设计、模型种子与倍率表（带日期的参考快照，账号的在线模型列表优先），详见 [NOTICE](NOTICE.md) 和 [第三方来源记录](docs/THIRD_PARTY_LICENSES.md)。
- 许可证：[MIT](LICENSE)。
- 维护者：yuki（GitHub：[Yuuuuuukit](https://github.com/Yuuuuuukit)）。与 AI 编码助手 OpenAI Codex、Anthropic Claude 协作开发。

[Magpie 插件文档](https://usemagpie.ai/docs/zh/plugins)
