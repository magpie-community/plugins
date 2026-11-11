# DeepWrite for Magpie

将 Magpie 提供给 DeepWrite 的**完整模型列表**逐条同步到 DW 的 **magpie** 分组。每个模型有独立配置与稳定 ID，可在 DW 中自由切换；无需修改 DW 源码。

## 安装、更新与使用

在 Magpie 搜索 **DeepWrite**（非官方插件 · GitHub），或直接添加：

```text
github:swjybky/magpie-agent-deepwrite
```

1. 退出 DeepWrite。
2. 在 Magpie 的 Agent 页开启 **DeepWrite**。这里只需要连接开关，不再选择单个模型。
3. 等待约 2 秒后重开 DW：设置 → 模型中的 **magpie** 分组会列出每个模型，DW 的模型选择器也可以逐个选择。

保持 Magpie 运行。新模型、删除模型和可见范围变化后，Magpie 会重新提交目录，插件同步对应条目。已在 DW 选定的默认模型不会在后台每秒被重置。已有作品或团队绑定其他模型时，在 DW 中改选相应 Magpie 模型。

### 从 v0.1.0 升级

先退出 DW，在 Magpie 关闭 DeepWrite 连接，然后在插件列表更新 **DeepWrite** 到最新版，再开启连接。旧版单条 `Ollama / Magpie · …` 配置会迁移为完整的 **magpie** 模型列表。不要同时安装本地版和 GitHub 版，它们的 Agent ID 相同。

### DW 的加密凭据

**macOS、Windows 首次连接会自动创建 `magpie` 提供商分组和全部模型，不需要手动添加模型或填写密钥。** DW 至少启动过一次即可；Windows 需要 v0.2.2 或更新版本。

插件优先复用已有 Magpie 配置的加密数据。没有时，通过 macOS 系统钥匙串读取 **DW 自己的 Safe Storage 项**，按 Electron 的加密格式生成 `magpie-local-bridge` 占位凭据；钥匙串密码仅用于内存中的加密，不写入文件或日志，不解密已有模型密钥，也不借用其他供应商的密钥。系统可能提示授权访问 DW 钥匙串；访问失败时保留原配置，并将原因写入 `status.json`，每分钟最多重试一次。

Windows 在当前 DW 数据目录读取 `Local State`，通过系统自带 PowerShell 和当前用户的 DPAPI 解封 DW 的存储密钥，在内存中生成 Electron 可读取的 AES-GCM 占位凭据。不改写 `Local State`，不读取或解密其他供应商的模型密钥。Magpie 和 DW 必须使用同一个 Windows 用户运行；无需管理员权限。

Linux 暂时仍需先在 DW 保存一个提供商名为 `magpie` 的模型和非空占位密钥，再退出 DW、开启连接。

占位密钥只用于 DW → 本地桥接。桥接发给 Magpie 的请求使用 Magpie 分配给 DeepWrite 的**专用网关 key**，不会向上游转发 DW 的占位密钥或原有 Magpie 凭据。

## 同步范围与恢复

- 每个 Magpie 模型映射为一个稳定的 DW 模型 ID，统一提供商名为 `magpie`。支持模型名称、上下文、输出上限和思考档位。
- 优先使用模型声明的原生 Responses 端点，否则使用 Chat Completions；Magpie 负责提供商协议转换。
- 插件只管理恢复记录中的模型 ID；原有手动配置及其他供应商模型保留。手动配置与自动导入模型可并存。
- 关闭连接后移除插件导入的模型与对应密文，恢复接入前默认模型；用户后来手动选了其他模型时保留该选择。
- **卸载前先关闭连接。** 关闭、切换连接时先退出 DW，避免 DW 自身保存配置与外部同步竞争。
- DW 当前最多保存 100 个模型。已有模型加上待同步模型超过 100 时，插件明确报错并保留原配置，**不会悄悄截断列表**。请在 Magpie 减少对 DeepWrite 可见的模型后重新连接。

## 运行方式与配置路径

Agent 定义运行于 Magpie 的 moejs 沙盒，桥接运行于它的 Bun 插件宿主。无需单独安装 Bun、Ollama 或 npm 依赖。

桥接只监听 `127.0.0.1` 随机端口，路径含随机令牌；拒绝浏览器 Origin / Fetch Metadata 请求。支持流式 Chat Completions 与 Responses。网关请求必须指向当前目录内的模型；正文和密钥不记日志。

`~/.config/magpie-deepwrite/` 中的文件：

| 文件              | 用途                                                |
| ----------------- | --------------------------------------------------- |
| `connection.json` | Magpie 写入的网关、专用 key、完整模型目录；敏感文件 |
| `journal.json`    | 本插件管理的模型 ID、接入前默认模型、复用的加密凭据 |
| `status.json`     | 连接状态、同步模型数或错误，不含明文凭据            |
| `runtime.lock/`   | 防止 GUI 与 CLI 的多个宿主同时改写 DW               |

DW 数据目录默认查找：macOS 的 `~/Library/Application Support/@deepwrite/desktop`，Windows 的 `%APPDATA%/@deepwrite/desktop`，Linux 的 `$XDG_CONFIG_HOME/@deepwrite/desktop` 或 `~/.config/@deepwrite/desktop`，同时兼容 `DeepWrite` 目录名。自动读取 DW 存储迁移指针。

自定义位置可在启动 Magpie 前设置 `DEEPWRITE_USER_DATA_PATH`，指向包含 `config/models.json` 的目录。要求 DW `models.json` version 3（按 DeepWrite 1.8.0 核对）。

正常关闭连接会清理本插件的配置；Magpie 自身退出或宿主重启时保留模型列表与默认选择，下次运行自动更新桥接地址。强制结束、断电后需要彻底恢复时，先退出 Magpie 和 DW，再在插件目录运行：

```sh
node scripts/disconnect.mjs
```

Agent 开关表示 Magpie 已写入连接信息；实际同步结果及模型数见 `status.json`。自定义 DW 路径时，恢复命令使用同样的环境变量。

## 开发与验证

```sh
npm test
BUN_BIN=/path/to/bun npm test
```

覆盖无 Magpie 配置的首次导入、空模型列表、macOS/Windows 占位凭据加密、系统存储失败脱敏与重试、完整目录增删、默认模型保留、旧版迁移、断开恢复、密文保留、限额与冲突拒绝、路径迁移，以及 Bun 宿主的多模型流式转发、Responses 和终止恢复。Windows CI 还用真实 DPAPI 和 Electron 验证首次导入模型的占位凭据可解密。未提供 `BUN_BIN` 时 Bun 集成测试明确报告跳过；Windows 原生凭据测试还需要 `ELECTRON_BIN` 指向 Electron 可执行文件。真实付费模型写作需在用户环境验收。

[Agent 插件规范](https://usemagpie.ai/docs/zh/plugins#agents) · [插件发布规范](https://usemagpie.ai/docs/zh/plugins#publish) · MIT License
