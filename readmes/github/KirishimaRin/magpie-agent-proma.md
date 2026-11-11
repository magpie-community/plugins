# Magpie for Proma

让 **Proma 使用 Magpie 中已配置的供应商、订阅模型和路由组**，并为缺少能力识别的模型匹配 Proma 原有的思考强度菜单。

插件读取每位用户自己的 Magpie 模型目录，模型变化后持续同步。无需修改 Proma 安装文件。

## 功能

- **同步模型**：在 Proma 内选择 Magpie 的供应商模型，保留模型显示名称和启用状态。
- **支持路由组**：每个路由组独立显示，实际请求仍交由 Magpie 执行路由。
- **补齐思考菜单**：优先使用 Magpie 的能力信息，models.dev 作补充，自动匹配已有菜单模板。
- **支持私有模型**：允许手动声明模型档位和指定兼容模板。
- **便于恢复**：修改配置前自动备份，提供诊断、清理和备份恢复工具。

## 使用要求

| 项目 | 要求 |
| --- | --- |
| 系统 | Windows x64 |
| Magpie | 已配置可用模型；已测试 0.1.1290、0.1.1293 |
| Proma | 已测试 0.19.58；其他版本默认暂停同步并提示 |
| 首次初始化 | 在 Proma 中至少保存过一个渠道，用于验证本机凭据加密格式 |
| 运行环境 | 正常使用由 Magpie 提供 Bun；开发测试使用 Node.js 22+ |

## 安装

在 **插件 → 发现 → 非官方插件 · GitHub → Agent** 中搜索 `proma`，选择作者 KirishimaRin 的 `magpie-agent-proma`。v0.5.1 修正了发现列表的 Agent 分类；列表尚未刷新时，也可使用下面的地址安装。

在 **Magpie → 插件 → 添加插件** 中输入：

```text
github:KirishimaRin/magpie-agent-proma#main
```

也可以通过命令行安装：

```powershell
magpie plugin add github:KirishimaRin/magpie-agent-proma#main
```

如使用 ZIP：从 [Releases](https://github.com/KirishimaRin/magpie-agent-proma/releases) 下载并解压到固定目录，在插件页添加包含 package.json 的文件夹，或双击其中的 install.cmd。同一台电脑选择一种安装方式即可。

## 开始使用

1. 在 Magpie 插件页启用本插件。
2. 在 **Magpie → Agent** 找到 **Proma**，开启接入。
3. 从系统托盘完全退出 Proma，等待同步完成，再打开 Proma。
4. 在模型选择器中选择 **Magpie · 供应商 · 协议或模型名**；路由组显示为 **Magpie · 路由组 · 组名**。
5. 使用 Google 或 OpenAI Responses 渠道的 Agent 会话时，选择 **Pi** 运行时。

接入状态、模型目录和能力文件变化后立即触发同步，另以每 5 秒检查作为补偿。渠道先使用 Agent 信息与本机缓存写入，联网刷新能力目录在后台进行。等待同步完成后再启动 Proma；Proma 运行期间会等待退出再更新配置，因此新增或调整模型后需要重新打开。模型或渠道迁移后，旧会话请重新选择模型。

## 思考强度如何工作

Proma 的菜单识别依赖模型 ID。插件对缺少菜单的模型使用兼容模板，再将请求转回真实的供应商与模型 ID。例如，Step 的 low/medium/high 可以使用 Gemini 的菜单模板，实际调用仍然是 Step。路由组的请求同样保持原组 ID。

能力信息按以下顺序使用：**用户手动覆盖 → Magpie 模型目录 → Agent 提供的档位 → models.dev**。Magpie 能力目录约每 5 分钟刷新，models.dev 约每 24 小时刷新；获取失败时保留已有缓存。

只有供应商支持模板中的全部档位时才启用该模板。暂未匹配的档位组合、模板之外的额外档位，可通过能力报告查看。兼容模板也可能影响 Proma 根据模型名推断的上下文、输出上限和视觉能力，详情见[兼容说明](docs/COMPATIBILITY.md)。

## 常见问题

### Proma 没出现模型，或者目录没有更新

先确认 Magpie 的 Proma Agent 已开启接入，再从托盘退出 Proma。升级插件后重启 Magpie，等待同步，再打开 Proma。双击插件目录中的 doctor.cmd 查看状态。

### 提示找不到 Proma，或者版本尚未验证

便携安装可在 Magpie 的插件选项中指定实际可执行文件路径：

```json
{
  "promaExecutable": "D:/Apps/Proma/Proma.exe"
}
```

路径请替换为自己的安装位置。其他版本的测试开关、端口与配置路径设置见[配置指南](docs/CONFIGURATION.md)。

### 某个模型还是没有思考菜单

该模型可能没有提供可调档位信息，或档位组合尚未匹配模板。可查阅[私有模型能力覆盖示例](docs/COMPATIBILITY.md#手动覆盖私有模型)，并运行详细报告：

```powershell
node capability-report.cjs
```

该命令需要 Node.js 22+；报告会列出本机模型名称与 ID，分享前请检查内容。

### Proma 返回质量检测或供应商错误

查看 Magpie 对应的检测控制台或供应商状态。本插件保留 Magpie 返回的错误信息，可按错误提示重新检测、处理账号状态或切换模型。

## 更新

在 Magpie 插件页应用更新，或执行：

```powershell
magpie plugin update
```

更新后重启 Magpie，从托盘退出 Proma，等待同步再打开。GitHub 分支安装会检查新提交并提示更新。

## 关闭、卸载与恢复

- **关闭接入**：在 Agent 页关闭 Proma 接入，保持插件启用；从托盘完全退出 Proma，等待专用渠道被移除后再打开。运行中的 Proma 会继续显示已有渠道，诊断将明确显示待清理状态和数量。
- **卸载插件**：先按上述步骤清理渠道，再在 Magpie 插件页删除插件；也可退出 Proma 后运行插件目录中的 uninstall.cmd。
- **恢复配置**：关闭 Agent 接入、退出 Proma，把所需的 channels.json.magpie-backup-* 文件拖到 restore.cmd 上。恢复前会先备份当前配置。

直接删除插件会停止同步组件；如有遗留渠道，可重新安装后清理，或在 Proma 中手动删除 Magpie 专用渠道。更多操作见[配置与恢复指南](docs/CONFIGURATION.md)。

## 隐私与反馈

供应商 API Key 由 Magpie 管理。插件通过经过认证的本机接口转发请求，并读取 Proma 的本机加密材料来保存接入 Key。查询 models.dev 时仅下载公开目录，不发送用户的模型列表或对话。完整说明见[隐私文档](PRIVACY.md)。

遇到问题请在 [Issues](https://github.com/KirishimaRin/magpie-agent-proma/issues) 提供版本、复现步骤及 doctor.cmd 的脱敏诊断输出。配置文件、桥接文件、Local State 和备份请留在本机。

## 开发与许可

[兼容性与能力规则](docs/COMPATIBILITY.md) · [插件规范核对](docs/PLUGIN-COMPLIANCE.md) · [开发、测试与发布](docs/RELEASING.md) · [更新记录](CHANGELOG.md)

本项目基于 [MIT License](LICENSE) 发布。

相关项目：[Magpie](https://github.com/yetone/magpie) · [Proma](https://github.com/proma-ai/Proma) · [models.dev](https://models.dev) · [Magpie 插件开发文档](https://usemagpie.ai/docs/zh/plugins)
