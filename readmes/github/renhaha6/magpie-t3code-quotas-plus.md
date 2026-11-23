# magpie-t3code-quotas-plus

> **来源说明与致谢**
> 本项目基于 [`uiuing/magpie-t3code-quotas`](https://github.com/uiuing/magpie-t3code-quotas)（MIT License）进行二次开发与增强；其中“将 T3 Code 非原生白名单厂商透传到 T3 Code 用量面板”的思路参考了 [`8liang/magpie-t3code-hub`](https://github.com/8liang/magpie-t3code-hub)（MIT License）。完整保留原作者版权声明与 MIT 许可证，感谢两位作者的开源贡献！

极简的 **Magpie 插件**，让你在 **T3 Code 的 `Usage → Limits`** 里直接查看 Magpie 各账号（含远程 Magpie 与非原生厂商）的剩余额度与多账号汇总。

- **零改源码**：不改 Magpie 本体，也不改 T3 Code 本体，纯薄适配层。
- **零第三方依赖**：纯 ES Modules + Node/Bun 内置 API。
- **装完自动接入**：自动写入 `~/.t3/userdata/settings.json`（兼容 `$T3CODE_HOME`），T3 Code 自动热加载，无需手动填表；并正确识别 T3 Code 对密钥的加密脱敏（`••••••`），重启不再反复要求重新同步。
- **安全隔离**：首次启动自动生成高熵随机连接密钥；仅监听 `127.0.0.1`、严格校验 `Host` 头防 DNS rebinding，控制页接口校验每次启动生成的随机 `X-UI-Token`，绝不触碰任何 OAuth Token。

---

## 本版本新增与改进

1. **修复远程 Magpie 供应商（`<remote>/<provider>`）无法显示的问题**
   - 自动解析带远程前缀的供应商（如 `ram/codex`、`ram/claude`、`ram/agy-cli`、`ram/grok`），剥离前缀后归入对应的 T3 Code 原生分组，同时保留来源标识（如 `来自 RAM`），与本地同名账号清晰区分、不撞 Key。
2. **支持将其他非原生厂商透传到 T3 Code，并可自由选择显示分组**
   - 可将 **WorkBuddy、Qoder CN、MClaw、Devin** 等 T3 Code 原生白名单之外的厂商额度一并展示到 T3 Code（自动跳过报错与无限额条目），并在 Magpie 左侧栏控制页的「其他厂商」卡片右上角 /「高级设置」中实时切换承载方式：
     - **借用 Grok 分组（默认推荐）**：独立区域展示，统一进度条铺满整行、无虚假 `Weekly ·` 前缀，不污染 Claude / Codex / Antigravity 分组（适合未使用 Grok 的用户）。
     - **借用 Claude 分组**：合并为单列 `Magpie` 汇总展示。
     - **借用 Antigravity 分组**：以自定义 `groups` 桶展示真实的 `<供应商/账号> · <窗口名>`，每项独占一条完整进度条。
     - **不透传**：仅在 Magpie 插件控制页查看，保持 T3 面板绝对纯净。
3. **支持在 T3 Code 中直接明文显示完整账号名（默认开启）**
   - 新增「高级设置 → 在 T3 中明文显示账号名」开关，解决 T3 Code 默认将账号名折叠为 1～2 个首字母缩写（如 `D / M / Q / W`）的问题，移动端与桌面端均可直接看清完整账号与厂商名称。
4. **优化进度条与节奏标尺准确性**
   - 修复多厂商不同周期混排时进度条分裂出空白列的问题，以及未知周期时长误报 `Ahead of pace` 标尺的问题。

---

## 安装方式

### 在 Magpie 中安装（推荐）

打开 Magpie → **Plugins（插件）** 搜索 `T3 Code 额度 Plus` 或添加 `github:renhaha6/magpie-t3code-quotas-plus`，也可终端执行：

```sh
magpie plugin add github:renhaha6/magpie-t3code-quotas-plus
```

安装开启后：
- 插件自动随 Magpie 启动并写入 T3 Code 配置，直接去 T3 Code 按 `⌘U`（`Usage → Limits`）或输入 `/usage-limits` 即可查看额度。
- Magpie 左侧栏会出现 **「T3 Code 额度」** 控制页，所有预设与勾选立即生效。

### 独立命令行运行（可选）

```sh
bun serve.mjs
# 或
node serve.mjs
```

支持环境变量：`PORT`、`MANAGEMENT_KEY`、`MAGPIE_ADDR` / `MAGPIE_URL`、`MAGPIE_API_KEY`、`KEPT_ONLY`。

---

## 核心功能

1. **简洁控制页 + 多语言支持（简体中文 / 繁體中文 / English）**
   - 默认自动跟随 Magpie 界面语言，也可在「高级设置」中手动切换；支持浅色 / 深色主题跟随。
   - 四种显示方式一目了然：**智能（默认推荐）**、**合并**、**逐个**、**仅在用**。
   - **智能模式**：按厂商账号数自动分流——单家已选 **≤ 4 个号** 逐个显示；**≥ 5 个号** 自动按同套餐合并成 1 条大宽条，防 T3 Code 弹窗拥挤（阈值 `4` 可自定义）。

2. **干净的合并条标识 + 高级重置时间开关（默认关闭）**
   - 合并展示到 T3 Code 时不插入任何奇怪占位符：1–9 个账号圆标直接显示数量（如 `5`、`7`），10 个及以上以套餐首字母或 `×` 开头（如 `pro · 12 个账号`）。
   - 「高级设置」中提供 **「合并后显示重置时间」** 开关（默认关闭：仅全部账号同步重置时显示），开启后默认按 **最晚（全部重置，推荐）** 显示；周额度已用完的账号不计入 5 小时那一行的时间（它要等的是周额度，由 Weekly 那一行显示），也可选 **最早 / 平均**，并附带清晰提醒说明。

3. **自定义重置分组窗口 + 双视图看额度**
   - 高级设置支持按 **秒 / 分钟** 自定义重置分组窗口（默认 5 分钟，`0` 表示不分组），自动合并相近重置波次。
   - 支持 **按厂商**（含全选 / 主力套餐 / 在用 / 清空快捷筛选）与 **按模型**（跨厂商并排对照）双视图；其他厂商额度默认折叠在底部。

4. **在线热切换端口**
   - 在高级设置中可直接切换端口：先试绑定新端口（被占用不中断原服务），成功后自动同步 `plugins.json` 与 T3 Code 配置。

---

## 支持范围与说明

- **T3 Code 原生 `Usage → Limits` 范围**：受 T3 Code 服务端白名单限制，原生分组显示 **Claude、Codex (ChatGPT)、Antigravity、Grok** 四类订阅账号（支持多账号、多套餐与 `<remote>/<provider>` 远程 Magpie 账号）。
- **其他非原生厂商额度**：WorkBuddy、Qoder CN、MClaw、Devin、DeepSeek、Kimi、GLM、MiniMax 等既会在控制页的「按模型看」与底部「其他厂商」中汇总展示，也可通过控制页下拉框透传到 T3 Code（支持 **Grok / Claude / Antigravity / 不透传** 四种模式）。
- **远程 T3 Code 接入**：服务仅监听 `127.0.0.1`；若 T3 Code 在另一台电脑，请在控制页展开「连接密钥与远程设备手动接入」复制 SSH 隧道命令后手动添加到 T3 Code。

## 本地测试

```sh
bun test
# 或
node --test
```

## 致谢与许可（License）

- 原项目：[uiuing/magpie-t3code-quotas](https://github.com/uiuing/magpie-t3code-quotas)（`Copyright (c) 2026 uiuing`，MIT License）
- 非原生厂商透传思路参考：[8liang/magpie-t3code-hub](https://github.com/8liang/magpie-t3code-hub)（MIT License）

本项目继续沿用 **MIT License**，详见 [LICENSE](./LICENSE)。
