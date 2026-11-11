# Magpie for DS-Bot

让 **DS-Bot 使用 Magpie 中已配置的供应商模型和路由组**，同步模型能力与思考强度选项。

插件读取每位用户自己的 Magpie 模型目录，模型变化后持续同步。无需修改 DS-Bot 安装文件。

## 功能

- **同步模型**：在 DS-Bot 内选择 Magpie 的模型，保留模型显示名称。
- **支持路由组**：同步可见路由组，实际请求仍交由 Magpie 执行路由。
- **同步模型能力**：同步上下文、输出预算、图片输入和思考档位。
- **自动选择协议**：识别 Chat、Responses、Anthropic 接口，支持手动覆盖。
- **便于恢复**：保留原有供应商与 Bot 设置，提供诊断、断开清理和升级兼容入口。

## 使用要求

| 项目 | 要求 |
| --- | --- |
| 系统 | Windows |
| Magpie | 已配置可用模型；已测试 0.1.1307 |
| DS-Bot | 已测试独立桌面版 v0.2.0，内置 DeepSeek Harness 0.2.1-rc.2 |
| 首次初始化 | 在 DS-Bot 中完成数据位置设置 |
| 运行环境 | 正常使用由 Magpie 提供 Bun；开发测试和手动诊断使用 Node.js 22+ |

## 安装

在 **插件 → 发现 → 非官方插件 · GitHub → Agent** 中搜索 `dsbot`，选择作者 KirishimaRin 的 `magpie-agent-dsbot`。列表尚未刷新时，也可使用下面的地址安装。

在 **Magpie → 插件 → 添加插件** 中输入：

```text
github:KirishimaRin/magpie-agent-dsbot#main
```

也可以通过命令行安装：

```powershell
magpie plugin add github:KirishimaRin/magpie-agent-dsbot#main
```

## 开始使用

1. 在 Magpie 插件页启用本插件。
2. 在 **Magpie → Agent** 找到 **DS-Bot**，开启接入。
3. 等待约 3 秒，让插件同步模型配置。
4. 在 DS-Bot 的 Bot 设置中选择同步的 Magpie 模型。
5. 首次接入后如模型列表没有刷新，退出并重新打开 DS-Bot。

插件每 3 秒检查接入状态与模型目录，每分钟刷新一次网关模型元数据。每个 Bot 在自己的设置里选择模型；已有的选择保持原样，需手动切换到要使用的 Magpie 模型。模型换协议后，请重新选择对应接口下的模型。

## 模型能力与协议如何工作

插件使用 Magpie 提供的上下文、输出上限、图片输入和思考档位，交给 DS-Bot 内置适配器使用。实际请求沿 **DS-Bot → Magpie 网关 → 模型供应商或路由组** 转发。

协议按 **用户手动覆盖 → 网关模型元数据与本机 Magpie 配置 → Chat 默认回退** 确定。普通模型匹配原生接口；路由组的全部有效成员使用 Responses 时归入 Responses，其余归入 Chat。识别依据与回退原因可通过诊断查看。

模型按 Chat、Responses、Anthropic 分组。输出预算取供应商输出上限与上下文四分之一中的较小值，为历史消息和压缩留出空间。详细规则和覆盖示例见[配置指南](docs/CONFIGURATION.md#协议与兼容选项)。

## 常见问题

### DS-Bot 没出现模型，或者目录没有更新

先确认插件已启用，Magpie 的 DS-Bot Agent 已开启接入，并且有对该插件可见的模型。升级插件后重启 Magpie，等待同步，再重新打开 DS-Bot。在插件目录执行 `npm run check` 查看状态；首次运行这些命令先执行 `npm ci` 安装依赖。

### 找不到 DS-Bot 数据目录

先打开一次 DS-Bot，完成数据位置设置。便携安装可在 Magpie 的插件选项中指定实际数据目录：

```json
{
  "dataDir": "D:/Apps/DS-Bot/data"
}
```

路径请替换为自己的数据位置。其他配置路径与环境变量见[配置指南](docs/CONFIGURATION.md)。

### 某个模型的接口或思考档位与预期不同

模型可能缺少协议元数据或可调档位信息。执行详细诊断：

```powershell
npm run explain
```

报告会列出协议识别依据、回退原因和模型信息。需要手动指定协议时，可查阅[覆盖示例](docs/CONFIGURATION.md#协议与兼容选项)。这些命令需要 Node.js 22+；报告可能包含本机路径与模型名称，分享前请检查内容。

### DS-Bot 返回供应商错误

查看 Magpie 对应的检测控制台或供应商状态，按错误提示处理账号状态、重新检测或切换模型。模型请求的供应商认证与路由由 Magpie 管理。

## 更新

在 Magpie 插件页应用更新，或执行：

```powershell
magpie plugin update
```

更新后重启 Magpie，等待同步再打开 DS-Bot。GitHub 分支安装会检查新提交并提示更新。

## 关闭、卸载与恢复

- **关闭接入**：在 Agent 页关闭 DS-Bot 接入，保持插件启用，等待插件管理的供应商和凭据被清理。仍使用 Magpie 模型的 Bot 需切换到其他供应商。
- **卸载插件**：先按上述步骤清理接入，再在 Magpie 插件页删除插件。
- **恢复清理**：如果已停用插件但仍有遗留配置，先关闭 Agent 接入，再在插件目录执行 `npm run restore`。

升级或模型换协议时，插件保留名称带“旧接口，建议切换”的兼容入口。先选择新接口下的模型，再执行 `npm run prune` 清除旧入口。更多操作见[配置与恢复指南](docs/CONFIGURATION.md)。

## 隐私与反馈

供应商 API Key 由 Magpie 管理。插件使用 Magpie 网关转发模型请求，读取模型协议元数据，并在本机保存 DS-Bot 专用接入凭据。元数据查询仅向配置的网关获取模型列表。

遇到问题请在 [Issues](https://github.com/KirishimaRin/magpie-agent-dsbot/issues) 提供版本、复现步骤及检查后的 `npm run check` 或 `npm run explain` 输出。配置文件、桥接文件、凭据和备份请留在本机。

## 开发与许可

[配置与兼容规则](docs/CONFIGURATION.md) · [开发与验证](docs/DEVELOPMENT.md) · [验收记录](VALIDATION.md) · [发布流程](docs/PUBLISHING.md)

插件自有代码采用 [MIT License](LICENSE)。DS-Bot 图标保留上游 Apache-2.0 许可；Magpie 协议规则移植保留上游 MIT 声明。各部分来源与许可证见[第三方声明](THIRD_PARTY_NOTICES.md)。

**该插件是由 KirishimaRin 开发的第三方适配插件。** DS-Bot 图标用于标识接入对象，版权归 Fei2411 及 DS-Bot 贡献者所有，按 Apache-2.0 使用。本插件与 DS-Bot 作者及 DeepSeek 官方无隶属或背书关系。[完整图标声明](docs/ICON-ATTRIBUTION.md)

相关项目：[Magpie](https://github.com/yetone/magpie) · [DS-Bot](https://github.com/Fei2411/DS-Bot) · [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) · [Magpie 插件开发文档](https://usemagpie.ai/docs/zh/plugins)
