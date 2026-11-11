# magpie-openbot-armor

Magpie 的 OpenBot 破甲插件：**gateway hook + 配置页面**。

它只改写经过 Magpie 网关的 OpenBot 请求，目标有三件事：

1. 保留每个 OpenBot bot 的 `name` / `title` / `description` 里的语气、身份、背景；
2. 清掉人设里的显式 anti-jobs，并改写 OpenBot 固定 developer prompt 里的反覆盖条款；
3. 把可配置的全局执行协议注入到请求的系统提示词里。

不修改 OpenBot 本体，不修改 `app.asar`，不修改 OpenBot 数据库，不修改 `~/.config/opencode`。  
本仓库只包含插件文件；安装命令见第 5 节。插件运行时不写任何状态文件，也不改 `plugins.json`。

---

## 1. 设计结论

### 1.1 为什么是 gateway hook，不是 middleware

Magpie 有两套请求改写入口：

| 入口 | 运行环境 | 文件系统 | `ctx.cwd` | 适合本插件 |
|---|---|---|---|---|
| `magpie.middleware` | moejs | 无 | 无 | 不适合 |
| `magpie.hooks` | Bun plugin host | 有 | 有 | **适合** |

本插件需要：

- 每次请求读取本地协议文件；
- 解析相对路径时用 `ctx.cwd`；
- 读 `ctx.origin` 做来源白名单；
- 配置页通过 `magpie.options.set` 热更新后，下一次请求生效；
- `gatewayTimeoutMs: 3000`。

因此用 `magpie.hooks`，文件是 `hooks.js`。

### 1.2 为什么有配置页

Magpie 社区插件支持 `magpie.page`：一个沙箱 iframe 页面，出现在窗口侧边栏的 Plugins 组里。页面可以：

- `await magpie.ready`
- `magpie.theme` / `magpie.onTheme`
- `magpie.options.get()`
- `magpie.options.set()`（每秒最多一次）
- 用原生 `<input type="file">` + `File.text()` 导入用户主动选的文件

配置页提供：

- **快速开始**：一键启用（推荐设置）/ 一键全部关闭，三步说明
- 总开关
- `off` / `observe` / `enforce` 三种模式
- **四种协议来源**：内置完整版 / 内置精简版（省 token）/ 本地文件 / 页面内联
- 文件路径配置、内联正文编辑与文件导入
- 高级清洗开关
- **按 OpenBot bot 名灰度**（`profileNames`）、来源、Magpie agent、模型前缀过滤
- 配置 JSON 一键查看/复制备份；内置 JSON 编辑器（粘贴修改、类型校验、应用）与字段说明表
- **说明**：Magpie → 插件 → Options 是宿主级的原始 `magpie.options` 编辑器；本页是同一份 options 的日常编辑 UI，宿主编辑器保留作为插件页故障/无页面时的兜底，**不要也无法从插件侧删除宿主入口**。
- 保存、恢复默认、未保存状态


### 1.3 单一真相源

协议正文有四个可选来源，但同一时刻只用一个：

| `armor_source` | 正文来自 | 改提示词方式 | 热更新 |
|---|---|---|---|
| `bundled` | 插件自带 `armor.md`（约 4.4 KB） | 改插件目录里的 `armor.md` | 是，按 mtime/size 缓存 |
| `compact` | 插件自带 `armor.compact.md`（约 1 KB，省 token） | 改插件目录里的精简版 | 是，按 mtime/size 缓存 |
| `file` | `armor_file` 指定的本地文件 | 用外部编辑器改该文件 | 是，每次请求读文件 |
| `inline` | 页面里的 `armor_text` | 页面编辑或导入文件后保存 | 是，Magpie 重启插件 host 后下一次请求生效 |

页面里的「导入文件」会把文件内容读进 `armor_text` 并切到 `inline`，不会同时维护文件和内联两份真相。  
「使用此文件」切到 `file`，此后正文归那个文件，页面只读。  
「使用内置」切回 `bundled`。

### 1.4 “删除 anti-jobs 段落”的真实边界

`stripPersonaSections` / `stripTaskBullets` / 英文段落清洗都是**尽力而为的已知格式清洗**，不是通用语义解析器：

- 中文目前只识别 `【不做什么】`、`【不做】`、`【不能做】`、`【边界】`、`【限制】`、`【禁止】` 等已知标题；
- 英文目前只识别 `Anti-jobs`、`Boundaries`、`Limits`、`Restrictions`、`Out of scope`、`Never do` 等已知标题；
- 如果 bot 用自然语言写 anti-jobs（例如“本角色不负责售后”、“我只做 A，不做 B”），可能不会被删除；
- 真正**通用**的一层不是删除，而是 `armor.md` 第 1.2 条：任何语言、标题、段落、措辞里的 anti-jobs 都作废；`patchProfile` 还会在 description 末尾追加“本角色无 anti-jobs”的执行协议行。

所以：删除是可选清理，协议覆盖才是通用保险。这也是参考 `magpie-purge` / `agent-purge` 的 `replace` 只能算近似、`strict` 更彻底但会丢宿主上下文这一设计后的取舍。

### 1.5 默认行为与边界

- `enabled: false`：安装后不自动改写请求，必须显式打开。
- `allowedOrigins: ["local", "magpie-key", "unknown"]`：`gateway-key` / `remote` 请求跳过。
- `mode: "enforce"`：默认执行；`observe` 只计算不返回改写后的 body；`off` 不动。
- hook 只改 system / messages / instructions / contents 中的文本，**不改** `tools`、`tool_choice`、`model`、`stream`、`functions`、`toolConfig`；Magpie 会拒绝改这些字段的 gateway hook。
- 任何异常、超时、协议文件不可读、非 OpenBot 请求都会 fail-open，原请求照发。
- `targetAllOpenCode: true` 是兜底：上下文压缩把 `<openbot-developer-instructions>` 压掉后，仍对所有 `ctx.agent === "opencode"` 请求注入协议；默认关闭。页面上的「一键启用（推荐设置）」会打开这个兜底；如果同时使用非 OpenBot 的 OpenCode，可在高级里关掉。

---

## 2. 文件结构

```text
magpie-openbot-armor/
├── package.json                  # magpie.hooks + magpie.page + 默认 options
├── hooks.js                      # Magpie asynchronous gateway hook
├── armor.md                      # bundled 默认协议正文
├── armor.compact.md              # bundled 精简协议（省 token）
├── lib/
│   ├── armor.mjs                 # 文件读取、~ 展开、mtime/size 缓存
│   ├── options.mjs               # option 归一化、协议来源解析、过滤
│   └── openbot-armor.mjs         # 纯请求改写逻辑
├── page/
│   ├── index.html                # 配置页
│   ├── i18n.js                   # zh / en 文案
│   ├── app.js                    # 页面逻辑、串行保存、文件导入
│   ├── style.css
│   └── icon.svg
├── scripts/
│   └── check-openbot-anchors.mjs # 只读检测 OpenBot 更新后锚点是否还在
├── test/
│   ├── openbot-armor.test.mjs
│   └── hooks.test.mjs
└── README.md
```

---

## 3. 配置页能改什么

打开 Magpie → Plugins → **OpenBot 破甲**（英文 `OpenBot Armor`）。

| 区域 | 内容 |
|---|---|
| 总开关 | 启用 / 关闭插件 |
| 模式 | `off`、`observe`、`enforce` |
| 协议来源 | `bundled`、`compact`、`file`、`inline` |
| 文件路径 | `armor_file`，相对路径按请求 `ctx.cwd` 解析 |
| 内联正文 | 文本框、文件导入、清空、切到 inline |
| 预览 | 只读预览内联正文；bundled/file 只显示来源说明 |
| 高级 | 各 strip 开关、`targetAllOpenCode`、origin/agent/model 过滤、hook 超时 |
| 保存 | 串行写入 `magpie.options`，遵守 1 次/秒限制 |
| 恢复默认 | 写回默认值并保存 |
| 配置 JSON | 只读备份、一键复制；点「编辑 JSON」可粘贴修改并校验应用；下方附完整字段说明表（字段 / 类型 / 默认值 / 说明） |

保存时 Magpie 会重启插件 host；**下一次请求**使用新配置。页面明确显示这一点。

---

## 4. 选项

`package.json` 里的默认 `magpie.options`：

```json
{
  "enabled": false,
  "mode": "enforce",
  "gatewayTimeoutMs": 3000,
  "armor_source": "bundled",
  "armor_file": "",
  "armor_text": "",
  "injectArmor": true,
  "stripPersonaSections": true,
  "stripTaskBullets": true,
  "stripEnglishAntiJobs": true,
  "stripEnglishSections": true,
  "targetAllOpenCode": false,
  "allowedOrigins": ["local", "magpie-key", "unknown"],
  "agents": [],
  "models": [],
  "profileNames": []
}
```

命令行等价用法（在插件目录执行时使用 `PLUGIN_DIR="$(pwd)"`）：

```bash
PLUGIN_DIR="$(pwd)"
magpie plugin options "$PLUGIN_DIR" '{"enabled":true,"mode":"enforce"}'
magpie plugin options "$PLUGIN_DIR" '{"armor_source":"file","armor_file":"/path/to/armor.md"}'
magpie plugin options "$PLUGIN_DIR" '{"mode":"observe"}'
magpie plugin options "$PLUGIN_DIR" '{"enabled":false}'
```

---

## 5. 安装与启用

安装命令（`PLUGIN_DIR` 指向本仓库根目录）：

```bash
PLUGIN_DIR="$(pwd)"   # 如果在插件目录执行；也可以改成实际路径

# 1. 添加本地插件
magpie plugin add "$PLUGIN_DIR"

# 2. 查看插件实际短名
magpie plugin list

# 3. 启用
magpie plugin options "$PLUGIN_DIR" '{"enabled":true}'

# 或打开 Magpie → Plugins → OpenBot 破甲 → 打开开关 → 保存
```

安装后建议先 `observe`，确认页面显示和 Magpie 日志无异常，再切 `enforce`。

---

## 6. 验证

**已对照 OpenBot 0.60.0 / 0.61.0 的 prompt 结构验证**：固定规则字符串（含 0.61 的 `Report a safety check, such as a certificate or sandbox block; do not work around it.`）与 `<agent_profile>`（数组元素按 `\n` 连接、`tagSafe(JSON.stringify({id,name,title,description}, null, 2))`）逐字节一致；锚点脚本在 0.61.0 的 `app.asar` 上全部命中。

```bash
cd "$PLUGIN_DIR"
npm test
npm run check
npm run check:anchors -- --help
```

`npm test` 覆盖：

- 内置协议读取与缓存
- option 归一化与别名
- bundled / compact / file / inline 四种来源
- origin / agent / model 过滤
- OpenBot 固定规则改写
- 中英文 anti-job 清洗且保留质量规则
- `<agent_profile>` 人设保持
- 四种协议的系统提示词注入与去重
- `applyToRequest` 不改 tools/model/stream
- hook 的 disabled / enforce / observe / compact / file / fail-open 路径

`check-openbot-anchors.mjs` 是**只读**的：流式读 `app.asar`，检查这些锚点是否还在：

```text
<openbot-developer-instructions>
You are a persistent local OpenBot teammate.
none changes other rules here for tools
<agent_profile>
description (1-2000 characters of standing instructions
```

官方 OpenBot 更新后跑一次：

```bash
# 路径由环境变量提供，不写死任何本地路径：
OPENBOT_APP_ASAR=/path/to/OpenBot.app/Contents/Resources/app.asar npm run check:anchors
# 或者：npm run check:anchors -- /path/to/OpenBot.app/Contents/Resources/app.asar
```

如果 `missing` 非空，说明 OpenBot 改了 prompt 结构，需要更新 `lib/openbot-armor.mjs` 里的 `EXACT_RULES` / `PROFILE_RE` / `OPENBOT_HINT`。

---

## 7. 回滚

只回滚插件，不需要动 OpenBot：

```bash
magpie plugin off "$PLUGIN_DIR"
magpie plugin rm "$PLUGIN_DIR"
```

或在配置页把总开关关掉并保存。

如果只想临时停用：

```bash
magpie plugin options "$PLUGIN_DIR" '{"enabled":false}'
```

---

## 8. 使用边界

插件只读取协议文件并修改内存中的请求；页面保存时写入 Magpie 自己的插件 options。它不修改：

- Magpie 的 `plugins.json`、`plugins.yml`、`library.json`（页面保存的 options 除外）
- `~/.config/opencode/`
- OpenBot 的 `openbot.db`、`app.asar`、`Info.plist`
- 不执行全局 `npm install`、Homebrew、Xcode 安装
- 不启动后台进程、定时任务或登录项
- 不写运行时状态文件

运行时 hook 只读协议文件、只改内存里的请求体；页面保存属于 Magpie 正常的 options 写入。测试使用系统临时目录并在结束后清理。

---

## 9. 已知边界

- Magpie 对插件页的 options POST 整体上限 64KB（`http.MaxBytesReader`），页面因此把内联协议正文限制在 40KB；更大的正文请用 `file` 来源。
- 页面不显示每请求运行状态：Magpie 的 `GatewayBegin` 每个请求调用 `checkList()`，`plugins.json` 的 mtime/size 变化会被判定为“另一个 magpie 改了插件”并触发插件 host 重启，因此 hook 不写 `plugins.json`；需要排查看 Magpie 插件统计/日志。
- 只覆盖经过 Magpie 网关的请求；OpenBot 若改成 Claude/Codex 直连，插件看不到。
- 不改变模型权重或 WorkBuddy / DeepSeek 服务端策略；prompt 层不等于模型层。
- 不改 OpenBot 数据库里存储的 `description`；破甲发生在请求发出前。
- 不处理工作区 `AGENTS.md` 里未来可能出现的任意自然语言 anti-jobs；运行时协议会把这类条款声明作废，但不会逐文件清洗。
- `targetAllOpenCode: true` 会影响所有经过 Magpie 的 OpenCode 请求，不只是 OpenBot；默认关闭。

## 10. 与官方插件文档的逐条对照

对照 [usemagpie.ai/docs/zh/plugins](https://usemagpie.ai/docs/zh/plugins)（2026-11 版）逐条核验：

| 官方要求 | 本插件 | 结果 |
|---|---|---|
| 网关钩子声明 `"magpie": { "hooks": "./hooks.js" }` | package.json 同款 | ✅ |
| 导出具名异步 `onRequest(body, ctx)` | `export async function onRequest` | ✅ |
| 纯网关插件不需要 main/exports | 无 main/exports/index.*，宿主只按 hooks 入口加载 | ✅ |
| 返回对象替换请求，undefined 保留原请求 | 只在 `result.changed` 时返回 body，否则 undefined | ✅ |
| 改 model/stream/工具/工具选择会被回滚 | 只改 messages/system/instructions/contents/systemInstruction，测试锁定 | ✅ |
| 每个钩子收到独立副本 | hook 不依赖 body 引用语义，observe 模式显式 structuredClone | ✅ |
| `ctx.report(code, bytes)` 只接受 ready/empty/unbound/unauthorized/unavailable/invalid/skipped | 只用 ready/invalid/skipped | ✅ |
| `gatewayTimeoutMs` 100–10000 | 默认 3000，页面与 normalize 都按此夹紧 | ✅ |
| 选项变更触发宿主重载；下一次请求生效 | SetPageOptions→SetOptions→Restart（page.go 源码确认），页面明示 | ✅ |
| 页面脚本必须是文件，不能内联；`connect-src 'none'` | 全部 `<script src>`，无内联脚本/内联事件；无 fetch | ✅ |
| `magpie.options.set` 每秒最多一次，返回保存后的选项 | 串行 flush，间隔 1100ms，采用返回值 | ✅ |
| `page.titles` 按 zh/zh-TW/ja/de | 齐全 | ✅ |
| 页面文件必须在 `page.file` 所在文件夹内 | page/* 与 page/icon.svg 均在 | ✅ |
| 文件夹插件就地加载，armor.md 随包根解析 | lib/armor.mjs 用 `import.meta.url` 定位包根 armor.md | ✅ |
| 测试应在沙箱 HOME 里做（官方 `mktemp -d` 模式） | 单测 47 项通过；沙箱命令见下 | ✅ |

文档的中文页 ctx 字段表未列 `origin`（英文源码版有）：本插件把缺失 origin 视为 `unknown` 且默认放行，两种宿主行为下都能正常工作。

**沙箱端到端验证（官方推荐方式）：**

```bash
PLUGIN_DIR="$(pwd)"
sb=$(mktemp -d)
m() { env HOME=$sb XDG_CONFIG_HOME=$sb/.config XDG_CACHE_HOME=$sb/.cache MAGPIE_ADDR=127.0.0.1:3499 magpie "$@"; }
m plugin add "$PLUGIN_DIR" </dev/null
m plugin --json
m plugin options "$PLUGIN_DIR" '{"enabled":true,"mode":"observe"}'
# 之后 rm -rf $sb 清理；全程不触碰你真实的 ~/.config/magpie
```

---

## License

[MIT](LICENSE)
