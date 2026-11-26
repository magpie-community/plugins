# 渠道切换修复 · Responses 400

Magpie 图形化中间件，用于修复 **Codex 等 Responses 客户端切换上游渠道后，同一会话中的对象失效并导致 400 报错**的问题，包括 Azure OpenAI 资源 ID 不匹配。

英文名称：Channel Switch Repair · Responses 400。原名“渠道会话修复”，npm 包名为 `magpie-aggregate-repair`。

常见错误：

```text
The requested item was created under a different Azure OpenAI resource.
Use the same resource that created the item to access it.
```

## 问题来源与工作原理

### 解决什么问题

Responses 返回的消息、推理项等对象可能带有上游生成的 `id`。这些 ID 标识的是某个上游资源中的对象，并不保证能在其他渠道或 Azure OpenAI 资源中使用。客户端把历史对象连同旧 ID 发回时，如果 Magpie 已经切换到另一个上游，新上游可能把它当作对旧资源的引用，因资源归属不匹配而返回 400。

例如：上一轮请求走渠道 A，返回了带 `id` 的推理项；下一轮切到渠道 B，却仍携带渠道 A 的对象 ID。即使历史内容已经放在请求里，旧 ID 仍可能触发上面的资源不匹配错误。

另一类问题是上游把会话 ID 绑定到特定渠道、账号或模型。切换后继续使用旧会话 ID，可能出现会话绑定冲突并返回 409。插件的会话 ID 处理针对这类绑定问题，不处理其他原因造成的 409。

### 默认做了什么

插件在 Magpie 选定上游后、发送请求前，通过 `onProvider` 处理匹配渠道和模型范围的 Responses 请求。默认启用两项处理：

| 处理 | 具体变化 | 目的 |
| --- | --- | --- |
| 清理历史对象 ID | 删除 `input[]` 中普通对象顶层的 `id`，保留其内容和其他字段 | 让新上游接收请求中携带的历史内容，减少对旧资源对象 ID 的依赖 |
| 按上游范围派生会话 ID | 请求带有可用的会话标识时，根据原标识、渠道、账号和模型生成带 `mgr-` 前缀的标识 | 为不同上游范围使用不同的会话标识，减少旧会话绑定冲突 |

例如，默认会把这样的历史项：

```json
{
  "input": [
    { "id": "msg_from_channel_a", "type": "message", "role": "user", "content": "继续解释" },
    { "id": "rs_from_channel_a", "type": "reasoning", "summary": [], "encrypted_content": "opaque" }
  ]
}
```

转换为：

```json
{
  "input": [
    { "type": "message", "role": "user", "content": "继续解释" },
    { "type": "reasoning", "summary": [], "encrypted_content": "opaque" }
  ]
}
```

这里删除的是对象自身的资源 ID。聊天正文、角色、推理摘要和加密内容仍留在请求里；工具调用的 `call_id`、`arguments` 及工具输出也会保留，从而维持工具调用与结果之间的关联。

### 会话 ID 如何处理

插件依次从 `client_metadata.session_id`、`client_metadata.thread_id`、`prompt_cache_key`、顶层 `session_id`、顶层 `thread_id` 中取第一个非空字符串。启用 `rotateSessionOnChange` 时，插件再结合当前渠道 ID、账号、上游模型及请求模型计算哈希，派生新的会话 ID。相同原标识和上游范围得到相同结果；范围变化后得到不同结果，首次匹配的请求也会进行派生。

派生结果写入 `prompt_cache_key`，并同步更新已有的 `client_metadata.session_id`、`client_metadata.thread_id` 和顶层 `session_id`。会话标识已带有当前范围前缀或关闭轮换时，插件只在缓存键缺失或为空时用已有标识补上。请求体没有可用标识时，插件不会编造会话 ID。

### 处理边界与可选清理

`previous_response_id` 和 `conversation` 也是恢复历史的引用入口，默认保留。若客户端只发送最新一句话，过去的上下文可能只存在于上游；删除这些指针无法凭空恢复历史。

`item_reference` 则只引用旧对象，不携带完整内容。默认安全模式下，只要请求含有这种引用且未开启 `dropItemReferences`，插件就保留历史项、会话指针和现有会话标识。若缓存键缺失或为空，仍可用已有会话标识补上，避免误删无法还原的引用。

需要进一步清理时，可手动启用相应选项：

- `dropItemReferences`：移除整个 `item_reference` 项，可能丢失它代表的上下文。
- `stripPreviousResponseId`、`stripConversation`：移除对应的会话指针。安全模式下，还需满足代码的历史检测条件：`input[]` 至少两项，同时含有 `developer` 或 `system` 角色，以及 `user` 角色。这个检测只是启发式判断，不能证明历史完整；激进模式会跳过这项检测，但仍需显式开启对应选项。

插件通过整理请求中的资源引用和会话标识来减少跨渠道错误，不会迁移上游保存的会话，也不会解密或转换 `encrypted_content`。若新上游不接受原有加密内容、仍需访问旧会话指针，或缺少必要历史，仅删除对象 ID 不一定能解决。其他原因引起的 400，例如请求格式或模型能力不匹配，也不在这项修复的范围内。

## 解决方式

插件在 Magpie 内运行，不修改 Codex 配置。

```text
Codex → Magpie → 上游渠道
```

安装后：

```text
Codex → Magpie(middleware) → 上游渠道
```

## 图形设置

插件启用后，左侧“插件”分组会出现：

```text
渠道切换修复 · Responses 400
```

设置页可以修改：

- 是否启用
- 渠道范围
- 模型范围
- 安全模式
- 是否移除无法恢复的引用项
- 是否允许移除上一轮响应指针
- 是否允许移除会话指针

点击“保存设置”后，下一次请求生效。

## 默认配置

```json
{
  "middleware": {
    "enabled": true,
    "providers": ["*"],
    "models": [],
    "mode": "safe",
    "dropItemReferences": false,
    "stripPreviousResponseId": false,
    "stripConversation": false,
    "rotateSessionOnChange": true
  }
}
```

## 字段说明

### 渠道范围

留空或填 `*` 表示所有 Responses 渠道。也可以填写具体渠道 ID 或通配符：

```json
["relay-main", "relay-*"]
```

### 模型范围

留空表示不限模型：

```json
["deepseek/*", "gpt-*"]
```

### 安全模式

- `safe`：默认；保留未允许清理的 `item_reference`，会话指针清理还需通过历史检测
- `aggressive`：跳过会话指针清理的历史检测；仍需显式开启各清理选项

### 清理项

- `dropItemReferences`：删除无法还原的引用项，默认关闭
- `stripPreviousResponseId`：删除上一轮响应指针，默认关闭
- `stripConversation`：删除会话指针，默认关闭

在历史项清理中，默认只删除 `input[]` 中普通对象顶层的 `id`，不会删除：

- `content`
- `role`
- `encrypted_content`
- `summary`
- `call_id`
- `arguments`
- 工具调用和工具输出

## 安装

在 Magpie 的插件搜索中输入 `渠道切换`、`会话修复`、`Responses`、`400` 或 `Codex`，找到“渠道切换修复 · Responses 400”。也可以用完整包名 `magpie-aggregate-repair` 查找。

从 npm 安装：

```powershell
magpie plugin add npm:magpie-aggregate-repair
```

也可以直接从 GitHub 安装：

```powershell
magpie plugin add github:xwyjh3612/aggregate-repair
```

安装后，在 Magpie 的插件设置中启用“渠道切换修复 · Responses 400”。

如果已下载插件文件或克隆源码，请先解压完整目录，再双击：

```text
一键安装.cmd
```

`install.cmd` 也是同一个安装入口。安装失败时窗口会显示具体原因；重新安装会保留已有插件设置。

或在仓库目录执行：

```powershell
magpie plugin add .
```

## 注意

默认处理会清理普通历史项的对象 ID，并在存在可用标识时派生上游会话 ID。聊天正文和加密推理内容会保留；额外的引用项或会话指针清理需要手动开启。

如果上游报告 `prompt_cache_key is required`，而会话标识只在 HTTP 请求头里，插件无法从请求体取到它。可以在 Magpie 中编辑报错渠道的「额外请求体」，添加：

```json
{
  "prompt_cache_key": "${sessionId}"
}
```

Magpie 会在转发时填入当前会话 ID，并保留请求中已有的缓存键。只给明确要求该字段的渠道添加这项设置，避免为其他渠道发送不需要的字段。

如果上游必须依赖会话指针才能恢复历史，请不要开启：

```json
{
  "stripPreviousResponseId": true
}
```

除非同时具备完整历史重放能力，否则删除会话指针会丢上下文。

## 开发

```powershell
npm run check
npm test
npm pack --dry-run
```

## 发布

### 自动发布（推荐）

仓库的 `.github/workflows/npm-publish.yml` 使用 GitHub Actions 和 npm Trusted Publishing（OIDC）。配置一次后，推送与包版本一致的 `v*` 标签会自动检查、测试并发布到 npm，附带来源证明。

在 npm 的包设置中添加 GitHub Actions Trusted Publisher，填写：

| 字段 | 值 |
| --- | --- |
| Organization or user | `xwyjh3612` |
| Repository | `aggregate-repair` |
| Workflow filename | `npm-publish.yml` |
| Environment name | 留空 |
| Allowed actions | 允许直接执行 `npm publish` |

工作流使用 GitHub 托管的 runner、Node.js 24 和 npm 11.21.2。认证由 OIDC 完成，无需设置 `NPM_TOKEN` 或 `NODE_AUTH_TOKEN` secret。

设置新的 Trusted Publisher 后，需要在两天内成功发布一次以验证配置。后续发版执行：

```powershell
npm version patch
git push origin main --follow-tags
```

`npm version patch` 会提升包版本、创建提交和 `v<版本号>` 标签；标签推送后触发自动发布。可以在仓库的 Actions 页面查看结果。

已经上传到 Staged Packages 的版本仍需要在 npm 上确认一次；自动发布后续版本时使用 `npm publish`，不会再进入待确认区。npm 不允许直接发布已存在于待确认区的同一版本。

详情见 [npm Trusted Publishing 文档](https://docs.npmjs.com/trusted-publishers/)。

### 本机手动发布

包发布到 npm 后，可以用上面的 npm 命令安装。发布前会自动执行语法检查和测试：

```powershell
npm login --registry=https://registry.npmjs.org
npm publish
```

后续更新先提升 `package.json` 中的版本号，再提交代码并发布；npm 不允许重复发布同一个版本。

公开 GitHub 仓库添加 `magpie-plugin` topic 后，会显示在 Magpie 的“插件 → 发现 → Unofficial, on GitHub”区域。详情见 [Magpie 插件发布文档](https://usemagpie.ai/docs/plugins)。

## 许可证

MIT
