# leafsuns-agy-realtime

**AGY Realtime** 是一个用于 [Magpie](https://github.com/yetone/magpie) 的社区页面插件（`magpie-page`），只读解析本机 Google Antigravity（`~/.gemini/antigravity`）日志与会话摘要，在 Magpie 窗口及 `magpie web` 中实时展示：

- **Token 输出速度（`tok/s`）**：基于连续工具/系统步骤间隔精准测算单步速率，并在模型请求生成中提供拟实时预估跳动（`~tok/s` + 耗时 + 预估输出 Token），响应完成后无缝对齐真实统计。
- **对话每轮消耗明细**：按 `USER_INPUT` 自动切分轮次，折叠/展开查看每次调用的新增输入（`input_tokens`）、缓存复用（`cache_read_tokens` 及命中率）、流式输出（`output_tokens`）、峰值上下文与触发工具标签。
- **上下文窗口与进程调度流水线**：可视化上下文水位（200K / 1M 参考上限切换）、近期步骤调度时间线及子 Agent 状态跳转。
- **零外部依赖**：纯 Node/Bun 内置模块实现，无第三方 npm 依赖，导入 `index.mjs` 无任何副作用。

## 目录结构

```text
leafsuns-agy-realtime/
├── package.json        # Magpie 插件声明 (magpie-page + service 端口 3486)
├── index.mjs           # 插件入口（导出 default { id, server }）
├── parser.mjs          # transcript.jsonl 与只读 SQLite 解析引擎
├── server.mjs          # 本地只读 HTTP + SSE 服务（127.0.0.1:3486）
├── page/
│   ├── index.html      # Magpie 宿主带路页（连接 _magpie/bridge.js）
│   ├── boot.js         # 优先跳 window.magpie.service，桌面端回退 127.0.0.1:3486
│   └── icon.svg        # 插件图标
├── static/             # 仪表盘前端页面（相对路径适配桌面端与 magpie web 代理）
└── test/
    └── plugin.test.mjs # node --test 测试套件
```

## 本地安装与调试

```bash
# 运行自带测试
node --test

# 在本机 Magpie 中添加并测试该插件
magpie plugin add ./leafsuns-agy-realtime
magpie plugin
```

也可直接独立启动本地服务预览：

```bash
node index.mjs --port 3486
```

## 提交到 Magpie 社区的方法

Magpie 支持两种社区收录方式，按官方规范推荐配合使用：

### 方式 A：独立 GitHub 仓库自动发现（最快）

1. 将本目录推送为一个独立的公开 GitHub 仓库（例如 `https://github.com/<your-name>/leafsuns-agy-realtime`）。
2. 在 GitHub 仓库右上角 **Topics** 中添加 **`magpie-plugin`** 标签（`package.json` 的 `keywords` 已包含规范要求的 `magpie-page`）。
3. Magpie 每日自动扫描带 `magpie-plugin` 标签的仓库，并将其自动收录到应用的 **Discover → Pages（非官方社区发现）** 中，用户即可直接在 Magpie 界面一键安装。

### 方式 B：提交 PR 到 `magpie-community/plugins` 官方社区索引

1. Fork [magpie-community/plugins](https://github.com/magpie-community/plugins)。
2. 将本目录复制为 `packages/leafsuns-agy-realtime/`，并在 `package.json` 中补充 `repository` 字段：
   ```json
   "repository": {
     "type": "git",
     "url": "git+https://github.com/magpie-community/plugins.git",
     "directory": "packages/leafsuns-agy-realtime"
   }
   ```
3. 如发布到 npm，可参考仓库根目录 `registry.json` 在 `plugins` 数组中添加对应条目（字段格式已按 `scripts/registry.mjs` 对齐）：
   ```json
   {
     "package": "leafsuns-agy-realtime",
     "name": "AGY Realtime",
     "kind": "page",
     "community": true,
     "icon": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMDAgMTAwIj4KICA8cmVjdCB4PSI2IiB5PSI2IiB3aWR0aD0iODgiIGhlaWdodD0iODgiIHJ4PSIyMiIgZmlsbD0iIzRmNDZlNSIvPgogIDxwYXRoIGQ9Ik01MCAyMUw3NyA3NSA1MCA2MiAyMyA3NXoiIGZpbGw9IiNmZmZmZmYiLz4KPC9zdmc+Cg==",
     "summary": {
       "en": "Live Antigravity token speed (tok/s), context window meter, per-turn breakdown, and dispatch pipeline",
       "zh": "Antigravity 实时 Token 速度、上下文水位、每轮消耗与进程调度流水线看板"
     }
   }
   ```
4. 在 `magpie-community/plugins` 仓库执行社区检查脚本验证无误后发起 Pull Request：
   ```bash
   bun scripts/check.mjs leafsuns-agy-realtime
   ```
