# magpie-local-shortlog

Magpie 的本地精简对话记录插件。**只记「用户问了什么、模型答了什么」，提示词一并记下；全部追加到同一个文件，满 20MB 轮转，内容不出本机。**

Local-only shortlog for the Magpie gateway: what the user asked, what the model answered, prompts included; tool definitions and tool output stripped. Append-only, rotated at 20MB, never leaves this machine.

「shortlog」取的是 `git shortlog` 的意思——把冗长的原始记录压成可读摘要，而不是逐字全文。不记工具定义、不记工具输出正文、不记后台的标题生成：那些占了九成体积，对「看对话」没有价值。

## 安装

在 Magpie 的 **Plugins → Discover → Unofficial, on GitHub** 搜索 `magpie-local-shortlog` 或 `local shortlog`。

也可以直接安装：

```sh
magpie plugin add github:CJSen/magpie-local-shortlog
```

这是 GitHub 分发的插件，尚未发布到 npm 或官方社区列表。根目录的 `private: true` 防止意外发布 npm 包，不影响从 GitHub 安装。

**默认关闭。** 日志包含系统提示词与你贴进对话的代码，安装后必须显式开一次。打开本插件的 **Options**，保存完整对象：

```json
{
  "enabled": true,
  "file": "conversations.log",
  "dir": "",
  "format": "text",
  "maxFileMB": 20,
  "keepFiles": 5,
  "origins": ["local"],
  "skipPaths": ["/v1/messages/count_tokens", "/v1/models", "/v1beta/models"],
  "skipAux": true,
  "showToolCalls": true,
  "showReasoning": false,
  "maxTextKB": 256,
  "systemReprintHours": 6,
  "redactKeys": [],
  "debug": false
}
```

上面就是全部可用键，值即默认值；`package.json` 里的 `magpie.options` 是 Options 编辑器的初值。

命令行等价写法：

```sh
magpie plugin options magpie-local-shortlog '{"enabled":true}'
```

> **注意：`magpie plugin options` 是整段替换，不是按键合并。** 只写 `{"enabled":true}`，`file`/`maxFileMB`/`keepFiles` 这些键会被从 `plugins.json` 里清掉（传 `off` 则清空全部选项）。功能上不受影响——缺失的键由插件回落到 `src/lib/config.ts` 里的默认值，也正是上面这份 JSON；但想「看得见、可改」，就把整段 JSON 写上，只改一个键时也一样，否则其余键会退回默认。

只对原本经过 Magpie 的请求生效，无需更改客户端连接设置。设 `enabled: false` 或停用插件即恢复直通（本插件本就是只读旁路，不改请求）。

```sh
# 关闭 / 卸载
magpie plugin options magpie-local-shortlog '{"enabled":false}'
magpie plugin rm magpie-local-shortlog
```

## 日志长什么样

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
2026-10-27 21:03:23 · workbuddy · deepseek/deepseek-flash · 919ms · 会话 53ebf742
────────────────────────────────────────────────────────────────────────
[系统提示词 · 40.3 KB · 本会话首次]
This conversation is powered by …
…

[用户]
用一句话介绍你自己

[助手]
我是你的测试助手，乐意帮你验证功能、排查问题并完成任务。
```

提示词未变化的一轮只留一行占位，体积可控：

```
[系统提示词 · 26 B · 未变化]

[用户]
第三次验收

[助手]
收到
```

工具轮只留标记，正文省略：

```
[用户]
帮我读个文件

[调用工具] Read

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
2026-10-27 21:05:12 · workbuddy · deepseek/deepseek-flash · 1204ms
────────────────────────────────────────────────────────────────────────
[工具结果 ×1 · 内容省略]

[助手]
文件里是配置
```

## 功能

- **一轮一条**：请求与回复先在内存里合成整轮，`onResponse` 时一次写入，并发请求不会交错。
- **只记新增用户消息**：多轮对话每轮都重发整段历史，这里按「最后一条 assistant 之后」截取，天然去重，插件重启也不会把历史再抄一遍。
- **提示词按需重印**：默认只在首次输出全文，之后留一行占位；提示词变了、换了客户端、超时、日志已轮转时才重印。
- **工具正文不入库**：工具调用与工具结果只留一行标记，`showToolCalls` 可关。
- **单文件追加 + 20MB 轮转**：按「轮」轮转，不做字节切分。
- **只读旁路 fail-open**：不修改、不拒绝、不阻塞任何请求，自身出异常也只丢日志，不影响对话。

系统提示词什么时候重印——去重键是 `(客户端 agent, 会话 session)`，判据是整段提示词的 sha1：

| 情况 | 本轮写出 | 标注 |
| --- | --- | --- |
| 这个键第一次出现 | 全文 | `本会话首次` |
| 提示词本身变了（sha1 变） | 全文 | `提示词已变更` |
| 上一次落盘的是别的客户端 | 全文 | `客户端切换` |
| 距上次输出超过 `systemReprintHours` | 全文 | `距上次超过 6 小时` |
| 日志已经轮转，全文留在 `.1` 里了 | 全文 | `日志已轮转，重印` |
| 以上都不成立 | 只留一行占位 | `未变化` |

没有 session id 的客户端（curl、部分 CLI）所有请求共用一个键，同样受时间窗约束，不会「一辈子只出现一次」。

## 配置项

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 总开关 |
| `file` | `"conversations.log"` | 追加的文件名（相对 `dir`） |
| `dir` | `""` | 日志目录，空 = 默认目录 |
| `format` | `"text"` | `text`（人读）/ `jsonl`（一行一轮 JSON，机器读） |
| `maxFileMB` | `20` | 单文件轮转阈值（1–512） |
| `keepFiles` | `5` | 保留的历史段数，`0` = 只留当前文件 |
| `origins` | `["local"]` | 记录哪些来源：`local` / `gateway-key` / `remote` |
| `skipPaths` | `["/v1/messages/count_tokens","/v1/models","/v1beta/models"]` | 不记录的路径 |
| `skipAux` | `true` | 跳过标题生成这类后台调用 |
| `showToolCalls` | `true` | 是否输出 `[调用工具]` / `[工具结果]` 标记 |
| `showReasoning` | `false` | 是否输出完整思考内容（正文为空时总会给一小段预览） |
| `maxTextKB` | `256` | 单条消息上限，超出保留头尾并标 `[已截断 …]` |
| `systemReprintHours` | `6` | 同一 `(客户端, 会话)` 距上次输出提示词超过这么久就重印全文；`0` = 不按时间重印 |
| `redactKeys` | 见 `src/lib/config.ts` | **追加**的敏感字段名（自动合并内置黑名单，写 `[]` 即只用内置） |
| `debug` | `false` | 把每次钩子的进出与跳过理由写进 `debug.log`，用于排查「为什么没记录」 |

改完选项立即生效，不用重启 magpie。

## 日志在哪

默认 `~/.config/magpie/plugin-data/magpie-local-shortlog/conversations.log`（有 `XDG_CONFIG_HOME` 时跟随；可用 `dir` 覆盖）。

```sh
tail -f ~/.config/magpie/plugin-data/magpie-local-shortlog/conversations.log   # 实时看
grep -n "关键词" ~/.config/magpie/plugin-data/magpie-local-shortlog/conversations.log
```

> 更名前的旧目录 `plugin-data/magpie-log/` 会被**继续沿用**：只要新目录还没建、旧目录还在，插件就原地追加，历史日志不会失联。想迁到新路径，把旧目录 `mv` 成新名字即可，下次写入自动改道。

轮转后的历史段：`conversations.log.1`（上一个 20MB）、`.2` …，数字越大越旧。

轮转规则：写前预判（`当前大小 + 本轮字节 > maxFileMB` → 先轮转再写）；按「轮」轮转、不按字节截断——一轮要么整轮在这个文件，要么整轮在下个文件；单轮本身超限时先轮转、再允许该文件超限写完（宁可一个文件 25MB，也不要一轮断成两半）；只做 `rename` 不复制；所有写入串在一条 promise 链上，避免并发同时判定轮转。

## 隐私

日志包含完整提示词、你的提问和模型回答，也就包含你贴进去的代码和文件内容。因此：

1. 默认关闭，装完必须显式 `enabled: true`；
2. 默认只记 `origin: "local"`（本机回环且没有网关 key 的请求），远程流量不落盘；
3. 目录 `0700`、文件 `0600`；
4. 两层脱敏：字段名黑名单（`api_key`/`token`/`authorization`/`cookie`… 整值替换为 `[redacted]`）+ 令牌正则（`sk-…`、`ghp_…`、`xox…`、`AKIA…`、`Bearer …`、私钥块）；
5. 只做上述尽力脱敏——**自然语言里的敏感内容无法保证被清除**，别把日志目录同步到公网或云盘。

## 已知限制

- 拿不到**原始 SSE 逐事件字节**，回复是网关合成后的完整内容；也拿不到上游报错的具体文本（只有「失败」标记）。
- `onResponse` 是**尽力投递**：进程退出、回复超大等情况会丢，表现为该轮整轮缺失。
- 工具输出正文、工具定义 schema 默认不入库；排查工具问题时请临时看 Magpie 自己的会话记录或 Gateway 请求日志。
- 没有全局总量配额，靠 `maxFileMB × keepFiles` 兜底（默认约 120MB）。

## 自查与测试

不需要 magpie、不连模型、不装依赖（Node ≥ 22.6）：

```sh
node --experimental-strip-types scripts/verify.mjs
```

覆盖 30 项：单文件、工具定义不入库、多轮不重复、标题生成跳过、Anthropic 协议、工具轮标记、脱敏（含系统提示词）、轮转与不切分、开关与来源闸门、空正文兜底、提示词回显策略（占位行 / 时间窗重印 / 客户端切换重印 / 轮转后重印），以及更名后的目录兼容。

## 协议

[MIT](LICENSE) © 2026 chjs
