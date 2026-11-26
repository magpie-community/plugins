# 用量与额度看板 · Usage & Quota board

一个 [Magpie](https://usemagpie.ai) 本地页面插件：在 Magpie 窗口的侧边栏加一个标签页，一次看清**所有供应商、所有账号**的用量与剩余额度。

> 只读本地数据，不发任何外网请求，不修改 Magpie 的任何配置。

---

## 功能

### 页一 · 用量查看

- **时间范围**：今天 / 7 天 / 30 天 / **自定义（精确到时分）**
- **四个汇总维度**：按模型 / 按供应商 / 按账号 / 按 Harness（发起请求的 Agent）
- **列**：名称、调用次数、Token 用量（M，= 输入+输出+缓存合计）、缓存命中率（仅"按模型"维度）、错误数、费用
- 按账号维度的名称显示为 `供应商 · 账号`，同名账号可区分

### 页二 · 账号额度

- **两级折叠**：供应商 → 账号，带「全部展开 / 全部折叠」
- **列**：名称、总量、已使用、未使用、使用率、进度条、最近请求时间
- 进度条三色：≤60% 绿、60–90% 橙、>90% 红
- 供应商行 = 其下各账号相加

---

## 安装

```bash
magpie plugin add github:chuanqiLjp/magpie-usage-quota-board
```

装好后重启 Magpie 窗口，侧边栏「插件」分组里会出现 **用量与额度看板**。

### 更新

插件装的是 `main` 分支，只包含已验证发布的版本。有新版本时 Magpie 的插件页会出现提示，点「更新」即可；也可以：

```bash
magpie plugin update
```

### 卸载

```bash
magpie plugin remove magpie-usage-quota-board
```

本地开发时也可以直接指向当前目录（改代码后重新 `add` 即生效）：

```bash
git clone https://github.com/chuanqiLjp/magpie-usage-quota-board.git
cd magpie-usage-quota-board
magpie plugin add .
```

---

## 数据从哪来

| 数据 | 来源 |
|---|---|
| 用量（今天 / 7 天 / 30 天 / 全部） | `GET http://127.0.0.1:3425/v1/magpie/usage?period=` |
| 账号额度 | `GET http://127.0.0.1:3425/v1/magpie/quotas` |
| 自定义区间用量 | 只读 `~/.config/magpie/usage.jsonl` |
| 「最近请求」时间 | 同上（额度接口不带请求时间） |

插件**不读** `providers.json` / `settings.json`，**不写**任何文件。

### 供应商额度口径

| 供应商 | 取哪个窗口 |
|---|---|
| Trae CN（`trae-cn`） | `Credits` |
| 商汤小浣熊（`raccoon`） | `Credits`（**忽略 `Daily pool`**） |
| CodeArts（`codearts`） | `总积分`（已含基础+赠送，不叠加） |
| MiniMax Code（`minimax-code`） | `Credits` |
| QwenWork（`qwenwork`） | 从 `balance` 文字解析：总量 = monthly + long-term，已用 = 总量 − 剩余 |

新增供应商的做法见 [AGENTS.md](AGENTS.md) 第 5 节。

---

## 已知限制

| 限制 | 原因 | 影响 |
|---|---|---|
| 自定义区间的**费用显示 `—`** | `usage.jsonl` 只记 token 与耗时，不落单价 | 要准确费用请用今天/7 天/30 天 |
| 没有「正在请求的会话数」 | Magpie 网关未暴露在途请求数（`/v1/magpie/live`、`/routing`、`/sessions` 均 404） | 改为显示「最近请求时间」 |
| 折叠状态**不跨刷新保持** | Magpie 页面跑在 `sandbox="allow-scripts"` 的 iframe 里，没有 `localStorage` | 页面右上角会提示「折叠状态仅本次有效」 |
| 从未请求过的账号「最近请求」为 `—` | 流水账里没有该账号记录 | 正常现象 |

---

## 端口

默认监听 `127.0.0.1:3499`，可在插件选项里改 `port`。

启动前会探测端口：已是本插件（例如残留实例）则直接复用；被别的程序占用会给出明确提示而不是崩溃。

---

## 开发

零运行时依赖，只用 Node 内置模块。

```bash
node --test           # 跑全部单测（24 条，自动发现 test/ 下的用例）
PORT=3501 npm start   # 本地起服务；自验一律用非生产端口（生产端口是 3499）
```

改代码前请先读 [AGENTS.md](AGENTS.md)：里面有禁止事项、开发流程、口径定义、添加供应商的步骤和自测清单。踩过的坑记录在 [docs/开发记录与经验.md](docs/开发记录与经验.md)。

欢迎提交 Issue 和 PR。提交前请确保 `node --test` 全绿。

---

## 许可证

[MIT](LICENSE)
