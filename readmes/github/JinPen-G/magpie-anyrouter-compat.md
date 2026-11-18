# magpie-anyrouter-compat

Magpie 的 AnyRouter 兼容插件，统一修正 Responses API 的工具定义和历史工具检索格式，减少 `invalid tool type` 及相关 400 错误。

## 安装

在 Magpie 插件页通过仓库地址安装，或执行以下命令。

```powershell
magpie plugin add github:JinPen-G/magpie-anyrouter-compat
```

插件显示名为「AnyRouter 兼容」。仓库的 `magpie-plugin` topic 和 `package.json` 中的 `magpie.middleware` 提供 Magpie 插件发现及加载入口。[仓库](https://github.com/JinPen-G/magpie-anyrouter-compat)

Magpie 的「发现」页从社区索引读取 GitHub 插件。仓库进入索引后，可选择「所有来源」或「GitHub 上的非官方插件」，搜索 `AnyRouter`。新仓库进入索引及本机缓存刷新的时间取决于社区同步作业，插件页也支持通过仓库地址直接安装。[Magpie 发现索引实现](https://github.com/yetone/magpie/blob/v0.1.3960/internal/plugin/catalog.go)

## 处理范围

通过 Magpie `onProvider` 发送到 `anyrouter` 的 Responses 请求自动应用兼容规则，覆盖各对话及路由组中实际选中的 AnyRouter 供应商。

- 补齐工具 namespace 的空描述。
- 清理已随请求携带完整定义的工具上的 `defer_loading` 字段。
- 将历史 `tool_search_call`、`tool_search_output` 转换为普通函数调用和结果，保留 `call_id` 配对。
- 将检索得到的工具放入 `additional_tools`，在同组并行工具结果完整后加载。
- 按显式配置的 `reasoningReplayIds` 回放已核定旧推理记录的可读摘要。

对话原始记录由客户端保留。供应商、模型、请求参数和工具执行由 Magpie 与客户端原流程管理。转换默认保留普通消息、函数调用、自定义工具、推理记录及压缩检查点。

## 加密历史恢复

Magpie 0.1.3960 的网关在收到明确的 `invalid_encrypted_content` 后，可按原恢复流程重试历史加密项，并记录已经被供应商拒绝的历史内容。通用工具格式处理与该恢复流程配合使用。[Magpie 实现](https://github.com/yetone/magpie/blob/v0.1.3960/internal/gateway/gateway.go#L4491)

`reasoningReplayIds` 接受已确认需要回放摘要的历史 reasoning item ID，默认值为 `[]`。配置后，指定项在出站时按已有 `summary` 文本回放，适用于定点历史恢复。实际 ID 保存在本机插件选项中。

```json
{
  "reasoningReplayIds": ["rs_example"]
}
```

## 验证

使用 Node.js 20 或更新版本运行定向检查。

```powershell
npm run check
npm test
```

测试覆盖跨对话适用范围、供应商隔离、嵌套工具定义、并行调用配对、工具加载顺序、重复处理和显式摘要回放。

运行时日志使用 `anyrouter-compat` 前缀，包含变更计数。Magpie 0.1.3960 的 `onProvider` 入口及运行限制是本次宿主验证的依据。[Magpie 中间件说明](https://github.com/yetone/magpie/blob/v0.1.3960/docs/subsystems/gateway-middleware.md)

## 许可证

采用 MIT 许可证，允许使用、修改、分发和商业使用。分发时保留版权声明及许可证全文。[MIT 许可证](LICENSE)
