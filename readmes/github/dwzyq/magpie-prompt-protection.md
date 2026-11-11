# Magpie Prompt Protection

把 AxonHub 的「提示保护规则」搬到 Magpie：一个**网关中间件 + 可视化管理页面**插件。

在 Agent 请求发往模型之前，用正则表达式匹配提示内容，并对命中内容执行：

- **脱敏（mask）**：把匹配内容替换成自定义文本，请求继续发送
- **拒绝（reject）**：直接拦截整个请求并返回错误

所有规则保存在 Magpie 的插件 options（`plugins.json`）里，页面与网关读取同一份配置。

## 功能

- 正则规则管理：创建、编辑、删除、启用/禁用、批量启用/禁用/删除
- 按消息角色限定作用范围：`system`、`developer`、`user`、`assistant`、`tool`
- 不选作用范围时对所有角色生效
- 多条脱敏规则按顺序叠加执行；第一条命中的拒绝规则立即终止请求
- 页面内置实时测试预览：在本地匹配，不会发送测试文本
- 支持从 AxonHub 迁移的规则结构（`name` / `description` / `pattern` / `status` / `settings`）
- 支持四种 Agent API 协议：OpenAI Chat Completions、OpenAI Responses、Anthropic Messages、Gemini generateContent
- 提供中文、英文界面，跟随 Magpie 窗口语言

## 安装

建议使用最新版 Magpie（插件页面与网关中间件都需要较新的版本）。

```bash
magpie plugin add github:dwzyq/magpie-prompt-protection
```

也可以在 Magpie 的「插件 → 添加插件」里填入：

```text
dwzyq/magpie-prompt-protection
```

安装后打开侧边栏的「提示保护」页面管理规则。

本地开发时可以直接加载文件夹：

```bash
magpie plugin add ./magpie-prompt-protection
```

## 快速开始

1. 打开「提示保护」页面，点击「创建规则」
2. 填写名称、正则表达式，选择处理方式
3. 如果选择「脱敏」，填写替换文本
4. 勾选需要保护的消息角色，或留空表示全部角色
5. 在「测试预览」里输入一段文本，确认匹配结果
6. 保存后规则默认启用；如需停用，可在列表里关闭状态开关
7. 之后所有经过 Magpie 网关的请求都会自动执行这条规则

## 规则结构

页面会生成并保存如下 JSON：

```json
{
  "rules": [
    {
      "id": "rule-...",
      "name": "mask-api-keys",
      "description": "隐藏 API Key",
      "pattern": "sk-[A-Za-z0-9]{48}",
      "status": "enabled",
      "settings": {
        "action": "mask",
        "replacement": "[REDACTED_API_KEY]",
        "scopes": ["system", "user"]
      },
      "createdAt": "2026-11-06T12:00:00.000Z",
      "updatedAt": "2026-11-06T12:00:00.000Z"
    }
  ],
  "rejectMessage": "request blocked by prompt protection policy"
}
```

### 字段

| 字段 | 说明 |
| --- | --- |
| `pattern` | 正则表达式，默认区分大小写 |
| `settings.action` | `mask` 或 `reject` |
| `settings.replacement` | `mask` 时的替换文本，支持 `$1` 和 `${name}` 捕获组引用 |
| `settings.scopes` | 作用角色数组；空数组表示全部 |
| `status` | `enabled` 或 `disabled`；新建默认 `enabled` |
| `rejectMessage` | 命中 `reject` 规则时返回给 Agent 的错误文本 |

规则按数组顺序执行。每条 `mask` 规则在前一条的结果上继续替换；任意一条 `reject` 规则命中后立即拒绝，不再执行后续规则。

## 作用范围与协议

| 范围 | OpenAI Chat | OpenAI Responses | Anthropic Messages | Gemini |
| --- | --- | --- | --- | --- |
| `system` | `messages[].role=system` | `instructions` / system message | `system` | `systemInstruction.parts[].text` |
| `developer` | `messages[].role=developer` | `messages[].role=developer` | - | - |
| `user` | 用户消息 | 字符串 `input` 或 user message | user 消息 | `contents[].role=user` |
| `assistant` | assistant 消息 | assistant message | assistant 消息 | `contents[].role=model` |
| `tool` | `role=tool/function` 的消息 | `function_call_output` / `custom_tool_call_output` | `tool_result` 内容块 | `functionResponse.response` 中的字符串 |

只检查文本字段；图片、工具调用参数、工具名称和非文本内容不会被修改。

## 常用正则示例

```text
# OpenAI API Key
sk-[a-zA-Z0-9]{48}

# 通用 API Key
(?i)api[_-]?key['"]?\s*[:=]\s*['"]?[a-zA-Z0-9_-]{20,}

# 信用卡号
\b(?:\d{4}[-\s]?){3}\d{4}\b

# 邮箱
\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b

# 提示注入
(?i)ignore\s+(previous|all)\s+(instructions|rules)
```

页面支持面板开头的 `.NET` 风格内联标志，例如 `(?i)`、`(?im)`，会转换成对应的 JavaScript 正则标志。

## 与 AxonHub 的对应关系

| AxonHub | 本插件 |
| --- | --- |
| 提示保护规则管理页 | 「提示保护」插件页面 |
| `mask` / `reject` | 同名 action |
| `system` / `developer` / `user` / `assistant` / `tool` | 同名 scopes |
| 规则按 ID 升序执行 | 规则按数组顺序执行 |
| 请求进入 Provider 前处理 | Magpie 网关中间件 `onRequest` |
| 仅处理请求方向 | 仅处理请求方向 |

## 注意事项

- 正则表达式在 Magpie 网关中执行，请写简单、可控的模式，避免灾难性回溯（ReDoS）。中间件钩子有 250ms 超时，超时后请求会按原样发送。
- 这是防止误发敏感信息的辅助措施，不是数据丢失防护的替代品；提示注入防护也可能被改写绕过，建议配合多层防护。
- 页面只读写本插件自己的 options，不读取账号、密钥或对话内容。
- 规则保存在 Magpie 本地的 `plugins.json`，不会上传到任何服务器；但请自行保护 Magpie 配置文件的访问权限。

## 开发

```bash
# 用沙箱 HOME 运行，避免影响正在使用的 Magpie
sb=$(mktemp -d)
m() { env HOME=$sb XDG_CONFIG_HOME=$sb/.config XDG_CACHE_HOME=$sb/.cache magpie "$@"; }

m plugin add ./magpie-prompt-protection
m plugin --json
```

修改页面文件后重启插件或重新打开页面；网关中间件文件变更由 Magpie 每秒检查并重载。

## License

MIT
