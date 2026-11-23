# 补丁更新（`magpie-patch-updater`）

面向 Magpie 的原生本地页面插件，用于在**保留自定义补丁**的前提下安全跟踪、预演校验、原子更新并一键回滚本地托管插件（内置 `@magpie-community/opencode-agy-cli-auth` 的热补丁模块）。

---

## 快速安装

在支持 `github:` 插件源的 Magpie（macOS / Windows / Linux）中直接安装：

```bash
magpie plugin add github:l1nxuan-du/magpie-patch-updater
```

或在客户端 **Plugins › Discover** 中搜索 `magpie-patch-updater` 一键安装。安装后在左侧边栏 **Plugins › 补丁更新** 打开管理页面。

如需修改本地页面服务监听端口（默认 `18910`）：

```bash
magpie plugin options github:l1nxuan-du/magpie-patch-updater '{"port": 18910}'
```

---

## 1. 架构与安全设计

### 1.1 本地托管目标插件架构
- **不直接修改 `node_modules`，不做启动期竞态猴子补丁**：将目标插件解包并托管到独立本地目录 `~/.config/magpie/patched-plugins/<id>/`，通过 `magpie plugin add <本地绝对路径>` 接入 Magpie，免疫 `@latest` 自动更新覆盖，同时触发 `pathstamp.go` 的优雅热重载。
- **全异步原子流水线（检查 → 暂存 → 打补丁 → 校验 → 切换 → 回滚）**：
  - 从 `magpie-community/plugins` 的 `dist/index.json`（含 `ETag` + TTL 缓存与 jsDelivr 镜像回退）获取上游元数据，下载后强制执行 `sha512-<base64>` 恒定时间完整性校验。
  - 在受管目录之外的 `.staging` 隔离目录解包（拦截路径穿越与越界符号链接）、单遍内存缓存应用补丁、执行 `Bun.Transpiler` 语法校验、补丁 `verify()` 断言及隔离 `HOME` 模块加载测试。
  - 全部通过后归档旧版本至 `.snapshots`（保留最近 3 个快照），两步原子切换至生效目录；任一环节失败则立即中止，线上受管目录保持字节级不变。
- **上游合入自动检测**：每次更新前调用 `detectUpstreamed(dir)`，若上游已原生合入对应修复，自动跳过该补丁并提示退役。
- **本机服务安全边界**：仅绑定 `127.0.0.1`，严格校验 `Host`（防 DNS 重绑定）、`Origin`（仅放行 `Origin: null` 与同端口本机同源）及每进程随机鉴权令牌（`crypto.timingSafeEqual`）；宿主模式下 `process.stdout` 零字节输出。

### 1.2 内置补丁列表（`@magpie-community/opencode-agy-cli-auth`）

| 补丁 ID | 中文名称 | 默认状态 | 上游关联 | 说明 |
| --- | --- | --- | --- | --- |
| `agy-401-recovery` | 401 认证过期自动重连恢复 | 默认启用 | `magpie-community/plugins#1296` | 识别长驻 `agy acp` 进程 OAuth 过期尾标，自动回收旧进程并透明重试一次 |
| `agy-silence-timeout-15m` | 静默超时放宽至 15 分钟 | 默认关闭 | `magpie-community/plugins#1465` | 将单轮静默超时默认值从 5 分钟放宽至 15 分钟 |
| `agy-executor-error-guard` | 拦截执行器错误避免误判 200 | 默认关闭 | `magpie-community/plugins#1467` | 拦截流末尾独立行 `⚠ agent executor error:`，按失败回合返回而非误判 200 |

---

## 2. 将 `agy-cli` 切换至补丁托管版

1. 打开 Magpie 侧边栏 **补丁更新** 页面点击「接管认证插件」（或在插件目录运行 CLI）：
   ```bash
   bun run cli.mjs adopt \
     --id opencode-agy-cli-auth \
     --package @magpie-community/opencode-agy-cli-auth
   ```
2. 停用原 `@latest` 条目并挂载本地补丁托管目录（`~/.config/magpie/plugin-auth.json` 按 provider ID `agy-cli` 存储凭据，切换来源不会丢失任何已登录账号）：
   ```bash
   magpie plugin off @magpie-community/opencode-agy-cli-auth@latest
   magpie plugin add "$HOME/.config/magpie/patched-plugins/opencode-agy-cli-auth"
   ```
   Windows PowerShell 下对应路径为 `"$HOME\.config\magpie\patched-plugins\opencode-agy-cli-auth"`。

---

## 3. CLI 用法与退出码

```bash
bun run cli.mjs <adopt|check|dry-run|update|status|rollback|toggle-patch|help> [--id <id>] [--json]
```

- `0`：执行成功
- `1`：一般运行错误
- `2`：参数用法错误
- `3`：补丁锚点冲突或校验未通过（线上受管目录未改动）
- `4`：SHA-512 完整性校验失败或拦截危险压缩包

---

## 4. 许可证

MIT
