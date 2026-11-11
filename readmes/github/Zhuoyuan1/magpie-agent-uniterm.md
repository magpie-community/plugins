# magpie-agent-uniterm

让 **Magpie** 认识 **uniTerm**：把 uniTerm 内置 AI Agent 的请求导到 Magpie 的本地网关（默认 `http://127.0.0.1:3425/v1`），模型统一由 Magpie 提供、统一走路由组和账号切换。

**agent 类** Magpie 插件，只做两件事：告诉 Magpie 配置在 `ai.json` 的哪个位置；接线时把 uniTerm 的模型列表改写为指向网关的记录。不碰 uniTerm 其它配置。

---

## 1. 两种模式（`agent.js` 顶部一行开关）

```js
const LIST_ALL_MODELS = true;   // 默认：全量模型写进 uniTerm
```



|               | 模式 B（默认，`true`）                       | 模式 A（`false`）          |
| ------------- | ------------------------------------- | ---------------------- |
| uniTerm 的模型列表 | Magpie 的全部模型（如 31 条），在 **uniTerm 里选** | 只有 1 条，在 **Magpie 里选** |
| Magpie 那一行    | 只有一个 provider 开关（开=接管）                | 一个 model 下拉框 + 开关      |
| 换模型           | 在 uniTerm 的 AI 设置里点                   | 在 Magpie 里点，重启 uniTerm |
| 路由组           | 也作为条目出现（如 `auto/deepseek-flash`），可用   | 可在 Magpie 里选到          |

改完开关要 `magpie uniterm default` 断开再重新打开，插件才会按新模式重写。

---

## 2. 安装

```bash
magpie plugin add C:\path\to\magpie-agent-uniterm
```

装完 Magpie → Agents 出现 **uniTerm**。

平台路径在 `agent.js` 顶部的 `PLATFORM` 改：`"win"`（默认，`$APPDATA/uniTerm/ai.json`）/ `"mac"` / `"linux"`。

## 3. 使用

1. Magpie → uniTerm → 打开开关（或在终端 `magpie uniterm provider magpie`）。
2. uniTerm → AI 设置 → 模型列表里看到 N 条 `Magpie · <模型>`，选一条。
3. 重启 uniTerm（后端启动时才读 `ai.json`）。

断开：`magpie uniterm default` —— 原模型列表（含加密 key）原样还原。

## 4. 卸载

先 `magpie uniterm default` 断开，再 `magpie plugin remove <插件路径>`。
