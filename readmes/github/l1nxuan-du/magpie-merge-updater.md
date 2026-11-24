# 合并更新（`magpie-merge-updater`）

在保留**用户本地修改**的前提下跟踪并更新 Magpie 插件。

Magpie 更新 `@latest` 插件时会整包覆盖 `node_modules/`。本插件本身不内置任何补丁，也不代改 Magpie 的 `plugins.json`，只负责为目标插件维护一份本地可编辑副本与官方基准副本，在官方发布新版时通过三方合并保留用户自己所做的修改。

---

## 技术概述

- **职责边界**：仅管理 Magpie 的 JS 插件包（支持 `@magpie-community/*` 与普通 npm 插件），不修改 Magpie 主程序，不内置特定插件的修改逻辑，也不直接读写 Magpie 的 `plugins.json`。
- **双副本基准机制**：添加托管后，在 `~/.config/magpie/managed-plugins/<id>/` 生成供用户直接编辑与挂载的工作目录（`ours`），并在 `.bases/<id>/` 保存对应版本的官方纯净副本（`base`）。两者的差异即为用户自己的全部修改。
- **三方合并更新流水线**：
  1. **拉取校验**：从 `magpie-community/plugins`（`dist/index.json`）或 npm 获取最新包并校验 SHA-512，解包至临时目录 `.staging` 作为新版副本（`theirs`）。
  2. **三方合并**：对每个文件按 `base` / `ours` / `theirs` 进行合并——未修改文件直接升至新版；仅本地修改的文件原样保留；双方同时修改不同位置的文件自动行级合并；双方做出相同修改时自动收敛。
  3. **冲突与语法门禁**：若双方修改了同一处代码产生冲突，或合并结果未通过 JS 语法与入口模块加载校验，立即中止并展示冲突片段，当前运行中的托管目录保持不变。
  4. **快照与切换**：校验通过后，将旧版归档至 `.snapshots`（保留最近 3 个版本），同步更新 `.bases/<id>/` 为新版官方基准，再原子切换生效目录，支持一键回滚。

---

## 使用方法

### 1. 安装插件

```bash
magpie plugin add github:l1nxuan-du/magpie-merge-updater
```

安装后在 Magpie 左侧边栏 **Plugins › 合并更新** 打开管理页。

### 2. 托管并修改目标插件

1. 在 **合并更新** 页面选择本机已安装的插件（或输入插件包名），点击 **「添加托管」**。
2. 直接在编辑器中修改页面所示托管目录（`~/.config/magpie/managed-plugins/<id>/`）内的代码文件；刷新页面可随时查看本地修改统计与具体 diff。
3. 点击卡片上的 **「切换命令」**，在终端执行所示命令以停用原 `@latest` 并挂载本地托管目录（`plugin-auth.json` 按 Provider ID 存储凭据，切换来源不会丢失已有登录账号）：

   macOS / Linux（以 `<pkg>` / `<id>` 为例）：
   ```bash
   magpie plugin off <pkg>@latest
   magpie plugin add "$HOME/.config/magpie/managed-plugins/<id>"
   ```

   Windows（PowerShell）：
   ```powershell
   magpie plugin off <pkg>@latest
   magpie plugin add "$HOME\.config\magpie\managed-plugins\<id>"
   ```

### 3. 合并更新、回滚与还原

在 **合并更新** 页面按需点击：
- **检查更新**：查询上游是否有新版本。
- **预演合并**：仅在临时目录试跑三方合并与语法校验，不改动当前托管目录。
- **合并更新**：拉取官方新版并与本地修改合并生效。
- **回滚上一版**：恢复到升级前的版本（同时恢复对应基准副本）。

等价命令行（在插件目录下执行）：
```bash
bun run cli.mjs <adopt|status|diff|check|dry-run|update|rollback|remove> [--id <id>] [--json]
```

如需退出托管并切回官方原版：
```bash
magpie plugin rm "$HOME/.config/magpie/managed-plugins/<id>"
magpie plugin on <pkg>@latest
```

---

## 许可证

MIT
