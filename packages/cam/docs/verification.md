# 实装验证记录

## 2026-11-25 真实客户端复验

- Claude Code：合成图片会话在 Magpie 中识别为 `claude`。实际调用 CAM MCP；随后请求记录省略原图 1 张、成功解析取图 1 张、失败 0。
- Codex CLI：合成图片索引成功，客户端可发现 CAM 工具；但该测试会话的模型请求未暴露 CAM 声明，记录为 `tool-unavailable`。原图保留，模型未调用取图工具，端到端省略仍未验收。MCP 工具发现本身不作为自动省略依据。
- 进一步用临时回环转发观察 Codex CLI 0.172.0 的 HTTP 请求，仅输出结构摘要。工具发现前后的两条请求，在进入 Magpie 前都未明确声明 `cam_view_image`，可见的相关入口是 `additional_tools` 中的 `exec`。该结论仅覆盖本次 HTTP 回放，不代表其他 Codex 运行模式。
- Codex 桌面合成会话：首轮索引到 `IMG-001`，第二轮仍记录 `tool-unavailable`，保留原图。另一次从当前 Codex 会话直接调用 MCP，使用合成会话的句柄成功获得 V2 引用。这个结果验证服务可以执行取图，不能证明测试会话的模型请求暴露了取图工具或能还原该结果。


验证时间：2026-11-25 10:35–10:47（Asia/Shanghai）

## 环境

- Magpie 0.1.4777
- 本地插件路径 `<workspace>/CAM-magpie`
- Bun 1.4.5
- 测试模型请求只发送到 `127.0.0.1` 的临时 Responses 捕获服务，不经过外部模型提供商。

## 配置备份

安装前配置保存在：

`<magpie-backup-dir>/magpie-cam-install-20261125-103523`

包含 Magpie 插件、Library、providers、Codex 配置和旧 CAM 启停状态。停用旧 Codex CAM 前另存了 `codex-config-before-old-cam-disable.toml`。

## 单元与构建

- 40 tests passed / 0 failed / 118 assertions。
- `src/index.ts` 与 `src/hooks.ts` 均通过 Bun 构建。
- 面板脚本通过语法检查。

## 真实 Magpie 网关验证

临时 provider `camcapture` 指向 `127.0.0.1:17991`，模型使用 Magpie 已知支持视觉的 `camcapture/gpt-6.2-sol`。测试会话为独立合成会话，不读取真实用户内容。

| 阶段 | 捕获结果 | 结论 |
| --- | --- | --- |
| 第一轮：用户文字 + 1×1 PNG | 捕获端收到原始 PNG | 新图正常发送并建立 `IMG-001` 索引 |
| 第二轮：新增用户轮次 | 原 PNG 不再出现；出现 `IMG-001` 占位符、真实工具名和 session 句柄 | 旧图省略与提示生成正常 |
| MCP `tools/call` | `/mcp/magpie/tools/CAM-magpie` 返回受校验的 `IMG-001` 载荷 | 真实工具注册、session 校验和取图正常 |
| 第三轮：工具结果回到网关 | `function_call_output.output` 为 parts 数组，包含取图标记和真正的 `input_image` | 文本载荷在真实 hook 中成功物化 |
| 第四轮：再新增用户轮次 | 工具输出不再包含 `input_image`，仅保留“只在那一轮提供”的副本说明 | 取回副本按轮次再次省略 |

所有断言通过。临时 provider 已删除，捕获服务已停止。

## 面板与宿主状态

- Magpie 插件列表：`onRequest`、`CAM-magpie_cam_view_image`、`Attachments` 均已识别。
- `CAM-magpie` Library server 已分配给 `codex`。
- `GET http://127.0.0.1:17893/`：200，返回中文面板。
- 测试会话及图片在 `/api/sessions` 和详情 API 可见。
- 缩略图 API：200，返回 PNG data URL。
- `Host: evil.example` 加跨站 Origin：403，不返回图片。
- 旧 Codex CAM 代理已通过官方 `connectDirectly()` 停用，Codex 上游恢复 `127.0.0.1:3425`。
- 旧 Codex CAM 插件已设为 `enabled = false`，未卸载。
- 新插件保持启用，面板端口 17893 正常监听。

## 实装中发现并修复的问题

1. 本地目录安装的实际工具名为 `CAM-magpie_cam_view_image`：工具识别已改为兼容真实 CAM 命名空间，并加入回归测试。
2. Magpie 将辅助命名导出误认为插件入口：`fetchImages` 已移至 `src/tool.ts`，主入口只保留插件与页面服务，加入入口回归断言。修复后的日志未再出现插件加载错误。

## 原生窗口补充验证

初次打开时 Magpie 报“页面没有响应”，定位为缺少 bridge；补入 `_magpie/bridge.js` 后握手恢复。随后确认原生页面 CSP 不允许 inline script 和网络请求，遂改为外部 `app.js`、静态 `live.js` 和缩略图，并以 `magpie.options` 保存选择。

最终使用 Peekaboo 在真实 Magpie 窗口确认：

- 左侧“插件 → 上下文附件”入口可见且页面正常绘制；
- 会话列表、真实附件缩略图、自动开关和固定按钮均显示；
- 在合成会话 `594ec759…` 上保存“固定发送”成功，plugins.json 只写入该测试会话；
- options 保存后 URL hash 保持同一会话，未再跳回其他会话；
- 会话名称已从 Codex 最新标题索引回填，例如会话哈希可还原为对应的原始标题，不再只显示哈希；
- 测试选择、两条合成会话及其面板缩略图均已清除，列表只保留真实会话；
- 重载时复用健康的既有 panel service，避免旧进程尚未退出导致端口占用和插件加载失败。

## 尚未覆盖

- 未强制重启用户的 Codex 应用。需要重启一次，以确保旧代理与旧工具退出，并加载新的 `CAM-magpie` MCP 工具。
- PDF、Gemini 取图和完整 Codex rollout 特化逻辑仍属于后续范围。
