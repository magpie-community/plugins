# GestaWorks / Keel Agent for Magpie

把 **GestaWorks / Keel** 添加到 Magpie 的 **Agent** 页面。安装后会出现一行 **GestaWorks**，带 Magpie 模型下拉框和“接入”开关，与 Claude Code、Codex、Kimi 等 Agent 的使用方式一致。

## 安装

```bash
magpie plugin add /path/to/gestwork-magpie-plugin
```

或从 GitHub 安装：

```bash
magpie plugin add github:DuskLin/gestwork-magpie-plugin
```

安装后打开 **Magpie → Agent**，找到 **GestaWorks**。插件通过旧版 Hong 的 `~/.hong` 数据目录检测安装；新版 Keel 会保留它指向 `~/.keel` 的兼容链接，因此新旧版本都可识别。不需要安装或使用 `keel` CLI。

## 使用

1. 启动 GestaWorks / Keel。
2. 在 Magpie 中添加并启用模型。
3. 打开 **Magpie → Agent → GestaWorks**。
4. 在模型下拉框中选择一个 Magpie 模型，或打开“接入”开关。
5. 插件会在 Keel 中注册 **Magpie** Provider，并把 Keel 的默认模型设为所选模型。

也可以使用 CLI：

```bash
magpie models gestaworks
magpie gestaworks magpie/<provider>/<model>
magpie gestaworks                 # 查看当前模型
magpie gestaworks default         # 断开并恢复
```

## 工作方式

这是一个 **Agent 插件**，由两部分组成：

- `gestaworks.agent.js`：声明 Magpie Agent 行、模型字段和连接信息。Magpie 负责保存连接前的值，并在断开时恢复其连接文件。
- Bun 适配器：监听 Magpie 写入的连接文件，通过 Keel 已有的本机 tRPC API 应用模型选择。

Keel 侧使用：

- `providers.addCustom`：按 Magpie 网关地址幂等新增或更新 Provider。
- `providers.getModels`：读取实时模型目录。
- `providers.getModelConfig` / `providers.setModelConfig`：启用 Provider 并设置默认模型。

插件通过 Keel 的本地 API 注册 Provider 和设置模型，并在获得授权后直接事务更新 Keel 的模型存档，补齐显示名、上下文窗口、输出上限、视觉/推理能力和价格。不会修改 Keel 源码。

模型存档写入前会在同目录创建 `agents.db.magpie-backup-<时间>` 一致性备份。已有注册表条目会合并保留，不会替换其他 Provider 的配置。

**首次同步或模型元数据更新后需要重启 GestaWorks。** Keel 只在启动时读取模型注册表存档；不重启时，运行中进程可能仍显示旧名称和旧上下文。

### 断开恢复

关闭 Agent 行的“接入”开关后：

- Magpie 恢复它管理的连接文件。
- 适配器恢复接入前 Keel 的默认 Provider 和默认模型。
- 已创建的 Magpie Provider 保留在 Keel 中，方便以后重新接入；不会删除其他 Provider 或模型。

如果断开时 Keel 未运行，适配器会在 Keel 可用后继续尝试恢复。

## Keel 地址

默认按 Keel CLI 的顺序自动探测：

| 运行方式 | 地址 |
| --- | --- |
| 本地桌面开发 | `http://127.0.0.1:22343` |
| 开发 / RC | `http://127.0.0.1:22342` |
| 正式桌面版 | `http://127.0.0.1:22340` |
| Headless | `http://127.0.0.1:22341` |

固定地址或调整轮询：

```bash
magpie plugin options gestwork-magpie-plugin '{
  "keelUrl": "http://127.0.0.1:22343",
  "pollMs": 1000,
  "requestTimeoutMs": 4000
}'
```

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `keelUrl` | `""` | 固定 Keel 地址；留空自动探测。仅支持本机 HTTP 地址 |
| `pollMs` | `1000` | 连接文件检查间隔，250–10000 毫秒 |
| `requestTimeoutMs` | `4000` | 普通本地请求超时，500–15000 毫秒 |

## 权限与边界

- 仅连接本机 Magpie 和 Keel 的 loopback HTTP 服务。
- 不收集或上传模型、配置或使用数据。
- 使用 Magpie 为 GestaWorks Agent 生成的 key（本机通常为 `magpie-gestaworks`），让 Usage 能识别该 Agent。
- 不启动或关闭 Keel；接入前请确保 Keel 正在运行。
- Magpie 插件宿主拥有本机进程权限，请只安装可信来源的插件。

## 故障排查

**Agent 行显示 not detected**

确认桌面 App 已至少启动一次，并存在 `~/.hong` 数据目录（新版通常链接到 `~/.keel`）。插件不依赖 Keel CLI。

**模型已选择，但 Keel 没有变化**

确认 Keel 正在运行，并检查插件日志：

```bash
magpie plugin --json
magpie log -n 100
```

如果 Keel 使用自定义端口，设置 `keelUrl`。

**Keel 拒绝本地网关**

部分受限构建的 gateway host policy 不允许自定义 loopback Provider。请使用允许 loopback 的 Keel 构建；插件不会绕过该策略。

## 开发与测试

需要 Bun，无第三方运行时依赖：

```bash
bun run check
bun test
```

在隔离 Magpie 配置中测试：

```bash
sandbox=$(mktemp -d)
env HOME="$sandbox" XDG_CONFIG_HOME="$sandbox/.config" \
  XDG_CACHE_HOME="$sandbox/.cache" MAGPIE_ADDR=127.0.0.1:3499 \
  magpie plugin add /path/to/gestwork-magpie-plugin
```

## 卸载

```bash
magpie plugin remove gestwork-magpie-plugin
```

卸载前请先在 Agent 页断开 GestaWorks。Keel 中已创建的 Magpie Provider 不会自动删除，可在 Keel 的模型设置中手动移除。

## 参考资料

- [Magpie 插件开发文档](https://usemagpie.ai/docs/zh/plugins)
- [Magpie 社区 Agent 插件](https://github.com/magpie-community/plugins)
- [Magpie 应用集成文档](https://usemagpie.ai/docs/zh/integrate)

## License

MIT
