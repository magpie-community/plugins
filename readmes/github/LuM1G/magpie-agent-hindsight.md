# magpie-agent-hindsight

**简体中文** | [English](README.en.md)

非官方社区插件：把 **Hindsight（后知后觉）** 接入 Magpie 的 Agents 页。你只需在 Magpie 中勾选模型，插件会把配置写入 Hindsight 当前账号的 SQLite 设置，并在连接期间保持同步；断开时恢复原来的 AI 设置。

> 本插件不是 Hindsight 或 Magpie 官方作品。Hindsight 的名称和图标仅用于说明兼容对象，详见 [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)。

## 接管范围

插件会接管 Hindsight 的三条云端路径中的两条：

| 路径 | 是否接管 | 写入值 |
| --- | --- | --- |
| AI 对话 | 是 | `chatMain = "__cloud__"` |
| 日报/周报 | 是 | `summaryMain = "__cloud__"` |
| OCR、embedding、本地视觉 | 否 | 保持用户原有本地配置 |

连接后没有“只接管对话”或“只接管总结”的独立开关，会同时接管 AI 对话和日报/周报。`__cloud__` 会让 Hindsight 使用当前外部 OpenAI 兼容端点，也就是 Magpie，因此对话和日报/周报都会消耗 Magpie 或上游 token。

## 要求

- Magpie `0.1.3697`
- Hindsight `0.11.4`
- Windows、macOS 或 Linux
- 所选模型支持 Hindsight 使用的 OpenAI 兼容聊天接口
- Hindsight 的 AI 对话需要模型支持 OpenAI `tools` / function calling

插件使用 Magpie 自带的 Bun 运行时，没有 npm 运行时依赖。

## 安装

```text
magpie plugin add github:LuM1G/magpie-agent-hindsight
```

安装后打开 **Agents → Hindsight**，勾选模型并连接。`0.1.3` 会在插件后台进程加载时立即开始同步；更新后重启一次 Magpie，让托管进程重新加载。桥接路径与 `0.1.2` 相同，已连接时无需重新勾选模型。

## 桥接与状态文件

Magpie 写入：

```text
~/.magpie-agent/hindsight/bridge.json
```

格式为：

```json
{
  "schema": 1,
  "models": [
    {
      "id": "workbuddy/deepseek-v4.1-flash",
      "name": "DeepSeek-V4.1-Flash · WorkBuddy"
    }
  ],
  "gateway": {
    "url": "http://127.0.0.1:3425/v1",
    "key": "<gateway key>"
  }
}
```

插件状态写入：

```text
~/.magpie-agent/hindsight/state.json
```

状态文件包含恢复所需的原始 API key 和 gateway key，因此不要分享。日志不会输出这些密钥。不支持或已损坏的桥接不会触发数据库写入。

## 写入 Hindsight

Hindsight 把所有设置保存在 SQLite 的 `settings_store` 表中，`id = 1` 的 `data` 是一整段 JSON。插件会：

- 按 `HINDSIGHT_DATA_DIR` → `bootstrap.json.data_path` → 平台默认目录的顺序定位数据根。
- 读取 `active_user.json`，只操作当前账号的 `hindsight.<uid>.sqlite`；没有 UID 时使用 `hindsight.sqlite`。
- 使用 `BEGIN IMMEDIATE`、`busy_timeout` 和有限重试，避免 Hindsight 正在写库时损坏设置。
- 只修改 `settings_store` 的这一行，并完整保留 Settings 中的其他字段。
- 不读取也不修改 `hindsight-memory.*.sqlite`。

Windows 的 bootstrap 文件位于：

```text
%APPDATA%\Hindsight\bootstrap.json
```

数据路径键名是 `data_path`。

## 模型档案

插件最多写入 10 份 Hindsight 外部档案，名称为：

```text
Magpie · <model-id>
```

Hindsight 的 10 份上限包含用户已有档案。插件不会删除用户档案；槽位不足时会填满可用槽位、激活第一个勾选模型，并记录未能保存的模型。

连接期间，在 Hindsight 中切换到其他 `Magpie · ...` 档案会保留你的模型选择。切换到非 Magpie 端点或模型会被视为漂移，插件会重新写回 Magpie 配置。

如果你改名或编辑了插件创建的档案，该档案会被视为用户所有，断开时不再删除。

## 断开与恢复

首次连接前，插件会备份这些字段：

- `externalEnabled`
- `externalProvider`
- `endpoint`
- `model`
- `apiKey`
- `summaryMain`
- `chatMain`

断开时只恢复仍由插件控制的值：

- 活动 endpoint/key/provider 仍指向 Magpie 时，恢复原来的活动字段。
- `summaryMain` 或 `chatMain` 仍是 `__cloud__` 时，恢复原值。
- 只删除字段与插件最后一次写入完全一致的档案；用户改名或编辑过的档案保留。

恢复完成后，后台进程停止读取 Hindsight 数据库和账号标记，只保留桥接文件轮询以等待下一次连接。

## 账号切换

插件只处理 `active_user.json` 指定的当前账号。账号切换时，先恢复旧账号数据库，再向新账号应用当前 Magpie 选择。状态按 UID 分开保存，避免跨账号覆盖。

## 常见问题

### Hindsight 设置页仍显示旧值

Hindsight 前端会缓存设置。下一次对话或总结通常已读取数据库中的新值；设置页可能需要刷新或重启 Hindsight 才会重绘。

### 已连接，但 Hindsight 没有出现云端 API 界面

先完全退出 Hindsight（包括托盘图标）再重新打开，而不只是切换设置页。Hindsight 会在启动时读取 SQLite 设置；只运行中的窗口可能一直保留连接前的界面。

然后确认：

- `~/.magpie-agent/hindsight/bridge.json` 存在且包含 `schema: 1`。
- `~/.magpie-agent/hindsight/state.json` 存在，当前账号的 `connected` 为 `true`。
- Hindsight 设置中的 `endpoint` 不是空值，并且 `externalProfiles` 中有 `Magpie · ...` 档案。

如果 `bridge.json` 已存在但 `state.json` 不存在，重启一次 Magpie，让插件后台进程重新加载；必要时在 Agents 页断开再连接。后台通常会在 2 秒内完成第一次同步。

### 对话返回 400，日报/周报正常

custom provider 可能注入 `chat_template_kwargs`，部分上游不接受该字段。把 Hindsight 的 `chatThinking` 设为 `auto` 或 `off`，或改用支持该字段的上游。

### 日报/周报正常，但对话失败

所选模型可能不支持 OpenAI `tools` / function calling。请在 Magpie 中选择支持工具调用的模型。

### 插件一直提示等待连接

确认 Magpie 已完成连接，并检查 `~/.magpie-agent/hindsight/bridge.json` 是否存在且包含 `schema: 1`。损坏或旧格式的桥接文件不会写库。

### 自定义数据目录找不到

设置 `HINDSIGHT_DATA_DIR`，或在 `%APPDATA%\Hindsight\bootstrap.json` 中写入 `data_path`。桥接和状态文件始终在 `~/.magpie-agent/hindsight`，不会放进 Hindsight 数据目录。

### 存在多个账号数据库

插件只使用 `active_user.json` 指向的账号。如果标记缺失、账号不明确或存在多个候选库，插件会等待而不是猜测。

## 限制

- 只接管 Hindsight 的 AI 对话与日报/周报。
- 同一时间只处理当前账号。
- v1 没有 Agent 页面内的范围开关，连接即全部接管。
- Hindsight 设置结构属于应用内部实现；本版本以 `0.11.4` 为准，未来升级可能需要跟版。
- 插件无法让不支持 tools 的上游支持 tools，也无法修复上游拒绝 `chat_template_kwargs`。
- Hindsight UI 可能缓存旧设置，需要刷新或重启。

## 开发

```text
npm test
npm pack --dry-run
```

开发测试需要 Node.js 22.5+ 和 Bun。测试只使用临时 HOME/APPDATA 和临时 SQLite 数据库，不读写真实的 `%APPDATA%\Hindsight` 数据库。集成测试会自动查找 PATH 或 Magpie 缓存中的 Bun，也可用 `MAGPIE_BUN` 指定；找不到 Bun 时会明确跳过。

## 许可

插件源代码使用 MIT 许可，见 [`LICENSE`](./LICENSE)。

Hindsight 官方图标是单独的 GPL-3.0 第三方资产，见 [`LICENSE-GPL-3.0.txt`](./LICENSE-GPL-3.0.txt) 和 [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)。本插件是社区作品，不代表 Hindsight 或 Magpie 官方。
