# magpie-system-prompt-file

> **Magpie plugin** · a system prompt (a **persona**) loaded from a local `.md` / `.txt` file and injected into every agent request.
>
> A file-based counterpart of `@magpie-community/middleware-system-prompt`, whose prompt can only be given inline as an option string. Here the prompt lives in a file you can edit, and the file is read again on every request.
>
> **macOS and Windows are both supported.** Markdown and plain text both work.

[English](#english) · [中文](#中文)

---

<a name="english"></a>

## English

### What it does

Magpie routes every agent's request to a model. This plugin sits in front of
that routing step and puts a system prompt into the request, in the place the
target API keeps it:

| Protocol | Where the prompt goes |
| --- | --- |
| Anthropic (`/v1/messages`) | `body.system` |
| Chat Completions (`/v1/chat/completions`) | the first `system` / `developer` message |
| Responses (`/v1/responses`) | `body.instructions` |
| Gemini (`/v1beta/models/...`) | `body.systemInstruction` |

### Where the persona is injected

**The persona lives in a file, not in the plugin's settings.** The default
location is:

```
~/.config/magpie/prompts/system.md
```

That path is the *source of truth*. You edit it, save it, and the next
request Magpie handles uses the new text — no reload, no restart, no
`magpie` command. The file is read on every single request.

The plugin's `prompt_file` option names that file. Point it anywhere else
and that file becomes the source of truth instead:

```json
{ "prompt_file": "~/Documents/persona/my-prompt.md" }
```

### Supported formats

| Format | Example | Notes |
| --- | --- | --- |
| **Markdown** (`.md`) | `# Persona` | the frontmatter block is dropped by default |
| **Plain text** (`.txt`) | `You are a patient assistant.` | read as it is |
| **Any other extension** | `.prompt`, `.persona`, no extension at all | the extension is not checked; the file is read as text |

Encoding and line endings are handled for you:

- UTF-8 (with or without a byte order mark)
- UTF-16, little or big endian, with or without a byte order mark — a file
  saved by a Windows editor that still saves in UTF-16 is read correctly
- LF or CRLF line endings, normalized to LF

### Install on macOS

```sh
git clone https://github.com/IvanXxxxyyuffff/magpie-system-prompt-file.git
cd magpie-system-prompt-file
sh install.sh
```

The installer copies the package into
`~/.config/magpie/plugins/magpie-system-prompt-file`, creates
`~/.config/magpie/prompts/system.md` if it is not there yet, and registers
the plugin with Magpie.

To do it by hand:

```sh
magpie plugin add /path/to/magpie-system-prompt-file
magpie plugin options /path/to/magpie-system-prompt-file '{
  "prompt_file": "~/.config/magpie/prompts/system.md",
  "override": true,
  "position": "append",
  "strip_frontmatter": true,
  "gatewayTimeoutMs": 3000
}'
```

Magpie's own binary on macOS is at
`/Applications/magpie.app/Contents/MacOS/magpie`; if `magpie` is not on your
`PATH`, use that path instead.

### Install on Windows

**The installer (recommended).** Download
`magpie-system-prompt-file-setup.exe` from the
[releases page](https://github.com/IvanXxxxyyuffff/magpie-system-prompt-file/releases),
double-click it and press Next. It needs no administrator rights, and it:

1. copies the plugin into
   `%USERPROFILE%\.config\magpie\plugins\magpie-system-prompt-file`,
2. writes the persona to
   `%USERPROFILE%\.config\magpie\prompts\system.md` (an existing file
   there is left alone),
3. registers the plugin with magpie and sets its options,
4. leaves an uninstaller and a shortcut on the desktop.

Uninstall it from Windows' Installed apps, or with the `Uninstall
magpie-system-prompt-file` shortcut in the Start menu.

**Where magpie is installed does not matter.** The Windows build of
magpie is a single `magpie.exe` you download and run where you like —
`Downloads` is the usual place, and it is neither on `PATH` nor under
`%LOCALAPPDATA%\Programs`. The installer writes magpie's `plugins.json`
itself, so the plugin shows up in Plugins whether magpie is in `Downloads`,
on the desktop, in `Programs`, or somewhere else entirely. When the CLI is
found it is used as well, so magpie reloads the list at once.

If magpie is not installed yet, the installer still puts everything in
place; install magpie afterwards and run the shortcut on your desktop
(`magpie-system-prompt-file`) once, and it registers the plugin.

**By hand.** PowerShell:

```powershell
git clone https://github.com/IvanXxxxyyuffff/magpie-system-prompt-file.git
cd magpie-system-prompt-file
powershell -ExecutionPolicy Bypass -File install.ps1
```

The installer copies the package into
`%USERPROFILE%\.config\magpie\plugins\magpie-system-prompt-file`, creates
`%USERPROFILE%\.config\magpie\prompts\system.md` if it is not there yet, and
registers the plugin.

To do it by hand:

```powershell
magpie plugin add C:\path\to\magpie-system-prompt-file
magpie plugin options C:\path\to\magpie-system-prompt-file '{
  "prompt_file": "~/.config/magpie/prompts/system.md",
  "override": true,
  "position": "append",
  "strip_frontmatter": true,
  "gatewayTimeoutMs": 3000
}'
```

### How to use it

1. **Write the persona.** Open the prompt file and put your text in it:

   ```markdown
   ---
   title: my persona
   ---

   You are a patient, precise assistant. Answer in English.
   ```

2. **Save it.** That is all. The next request uses it.

3. **Change it any time.** Edit the file, save, done.

**A few options worth knowing** (`magpie plugin options <path> '<json>'`):

| Option | Default | Meaning |
| --- | --- | --- |
| `prompt_file` | `""` | one `.md` / `.txt` file to read |
| `prompt_files` | `[]` | several files, read in order and joined with a blank line |
| `system_prompt` | `""` | an inline prompt, used when no file is configured |
| `override` | `true` | `false` keeps a request's own system prompt and adds nothing |
| `position` | `"append"` | `append` puts the file's after the request's own, `prepend` before it |
| `agents` | `[]` | when given, the only agents it applies to (e.g. `["codex", "claude"]`) |
| `models` | `[]` | when given, the only model name prefixes it applies to |
| `strip_frontmatter` | `true` | drops a leading YAML `---` block |
| `gatewayTimeoutMs` | `3000` | the hook's own budget, 100-10000 ms |

`system_prompt_file`, `system_prompt_files` and `persona_file` are accepted
as spellings of `prompt_file` and `prompt_files`. A file always wins over
the inline `system_prompt`.

**Paths work the same on both systems:**

| Written as | Read as |
| --- | --- |
| `~/...` or `~\...` | the home directory, on macOS and on Windows |
| `$VAR`, `${VAR}`, `%VAR%` | the environment variable |
| `C:\Users\me\prompt.md` | absolute on Windows, and never mistaken for a relative path on macOS |
| `\\server\share\prompt.md` | absolute (UNC) on Windows |
| `prompts/system.md` | relative to the request's working directory |

### Why a gateway hook and not a middleware

Magpie runs `magpie.middleware` in its own moejs engine, which has no
`node:fs`: a middleware cannot read a file at all. The asynchronous
`magpie.hooks` entry runs in the Bun plugin host, where `node:fs` works, so
this plugin is a hook. The two entry names never overlap, so the file is
loaded as a hook only.

### Safety of the request

- The hook never changes `model`, `stream`, the tools or the tool choice.
- A file that cannot be read is reported on the plugin host's log and the
  request is left as it was; it never fails the call.

### Test

```sh
node test/run.test.mjs
```

36 cases: the four protocols, append and prepend, `override` on and off, the
`agents` and `models` filters, frontmatter on and off, several files, inline
fallback, `~` and relative paths, a missing file, a hot reload, and the
cross-platform paths and encodings.

### Uninstall

```sh
magpie plugin rm ~/.config/magpie/plugins/magpie-system-prompt-file
```

---

<a name="中文"></a>

## 中文

### 它做什么

Magpie 把各个 agent 的请求转发给模型。这个插件挂在转发之前，把一段系统提示词
（**人格 / persona**）写进请求里，放在目标 API 存放它的位置：

| 协议 | 提示词写到哪里 |
| --- | --- |
| Anthropic（`/v1/messages`） | `body.system` |
| Chat Completions（`/v1/chat/completions`） | 第一条 `system` / `developer` 消息 |
| Responses（`/v1/responses`） | `body.instructions` |
| Gemini（`/v1beta/models/...`） | `body.systemInstruction` |

### 人格注入从哪里注入

**人格写在一个文件里，不在插件设置里。** 默认位置：

```
~/.config/magpie/prompts/system.md
```

这个路径就是**唯一真相源**。你改它、保存，下一个走 Magpie 的请求立刻用上新的文字
——不用重载、不用重启、也不用敲任何 `magpie` 命令。文件在**每一次请求**时都会
重新读一遍。

插件的 `prompt_file` 选项指向这个文件。把它换成别的路径，那个文件就成为新的
唯一真相源：

```json
{ "prompt_file": "~/Documents/persona/my-prompt.md" }
```

### 支持什么格式

| 格式 | 例子 | 说明 |
| --- | --- | --- |
| **Markdown**（`.md`） | `# Persona` | frontmatter 块默认会被剥掉 |
| **纯文本**（`.txt`） | `You are a patient assistant.` | 原样读入 |
| **其他扩展名** | `.prompt`、`.persona`、甚至没有扩展名 | 不检查扩展名，按文本读 |

编码和换行会自动处理：

- UTF-8（带或不带 BOM）
- UTF-16，大小端、带或不带 BOM —— Windows 编辑器存的 UTF-16 文件也能正确读出
- LF 或 CRLF 换行，统一成 LF

### macOS 怎么安装

```sh
git clone https://github.com/IvanXxxxyyuffff/magpie-system-prompt-file.git
cd magpie-system-prompt-file
sh install.sh
```

安装脚本会把插件复制到
`~/.config/magpie/plugins/magpie-system-prompt-file`，在
`~/.config/magpie/prompts/system.md` 不存在时创建它，并在 Magpie 里注册插件。

手动安装的话：

```sh
magpie plugin add /path/to/magpie-system-prompt-file
magpie plugin options /path/to/magpie-system-prompt-file '{
  "prompt_file": "~/.config/magpie/prompts/system.md",
  "override": true,
  "position": "append",
  "strip_frontmatter": true,
  "gatewayTimeoutMs": 3000
}'
```

macOS 上 Magpie 自己的可执行文件在
`/Applications/magpie.app/Contents/MacOS/magpie`；`magpie` 不在 `PATH` 上就用这个
路径。

### Windows 怎么安装

**用安装包（推荐）。** 到
[Releases 页面](https://github.com/IvanXxxxyyuffff/magpie-system-prompt-file/releases)
下载 `magpie-system-prompt-file-setup.exe`，双击，一路 Next 就行。**不需要管理员
权限**，它会：

1. 把插件复制到
   `%USERPROFILE%\.config\magpie\plugins\magpie-system-prompt-file`；
2. 把人格写入
   `%USERPROFILE%\.config\magpie\prompts\system.md`（已有文件不会被覆盖）；
3. 在 Magpie 里注册插件并设置好选项；
4. 留下卸载程序和桌面快捷方式。

卸载：Windows 设置 → 已安装的应用里找到它卸载，或用开始菜单里的
`Uninstall magpie-system-prompt-file` 快捷方式。

**Magpie 装在哪都不影响。** Windows 版 Magpie 就是一个你下载下来自己放的
`magpie.exe`——通常在 `Downloads`，**既不在 PATH，也不在
`%LOCALAPPDATA%\Programs`**。安装器会直接写 magpie 的 `plugins.json`，所以
无论 Magpie 在 `Downloads`、桌面、`Programs` 还是别的地方，插件都会出现在
Plugins 列表里。找到 CLI 时还会顺便调用它，让 magpie 立刻重载。

如果当时还没装 Magpie，安装器也会把文件都放好；之后装上 Magpie，再运行一次
桌面上的 `magpie-system-prompt-file` 快捷方式，插件就注册上了。

**手动安装。** PowerShell：

```powershell
git clone https://github.com/IvanXxxxyyuffff/magpie-system-prompt-file.git
cd magpie-system-prompt-file
powershell -ExecutionPolicy Bypass -File install.ps1
```

安装脚本会把插件复制到
`%USERPROFILE%\.config\magpie\plugins\magpie-system-prompt-file`，在
`%USERPROFILE%\.config\magpie\prompts\system.md` 不存在时创建它，并在 Magpie 里
注册插件。

手动安装的话：

```powershell
magpie plugin add C:\path\to\magpie-system-prompt-file
magpie plugin options C:\path\to\magpie-system-prompt-file '{
  "prompt_file": "~/.config/magpie/prompts/system.md",
  "override": true,
  "position": "append",
  "strip_frontmatter": true,
  "gatewayTimeoutMs": 3000
}'
```

### 具体怎么使用

1. **写人格。** 打开提示词文件，把你的内容写进去：

   ```markdown
   ---
   title: 我的 persona
   ---

   你是一个耐心、精确的助手。用中文回答。
   ```

2. **保存。** 就这一步，下一个请求就用上了。

3. **随时改。** 改文件、保存，完事。

**几个常用选项**（`magpie plugin options <路径> '<json>'`）：

| 选项 | 默认值 | 含义 |
| --- | --- | --- |
| `prompt_file` | `""` | 读取一个 `.md` / `.txt` 文件 |
| `prompt_files` | `[]` | 读多个文件，按顺序用空行拼接 |
| `system_prompt` | `""` | 内联提示词，没配文件时用它 |
| `override` | `true` | `false` 表示保留请求自带的系统提示词，什么都不加 |
| `position` | `"append"` | `append` 追加在请求自带提示词之后，`prepend` 放之前 |
| `agents` | `[]` | 填了就只对列出的 agent 生效（如 `["codex", "claude"]`） |
| `models` | `[]` | 填了就只对匹配的模型名前缀生效 |
| `strip_frontmatter` | `true` | 剥掉开头的 YAML `---` 块 |
| `gatewayTimeoutMs` | `3000` | hook 自己的超时，100-10000 毫秒 |

`system_prompt_file`、`system_prompt_files`、`persona_file` 都是
`prompt_file` / `prompt_files` 的别名。配了文件就以文件为准，忽略内联的
`system_prompt`。

**两个系统上路径写法一致：**

| 写成 | 会被读成 |
| --- | --- |
| `~/...` 或 `~\...` | 用户主目录，macOS 和 Windows 都一样 |
| `$VAR`、`${VAR}`、`%VAR%` | 环境变量 |
| `C:\Users\me\prompt.md` | Windows 下的绝对路径，在 macOS 上也不会被误当成相对路径 |
| `\\server\share\prompt.md` | Windows 下的绝对路径（UNC） |
| `prompts/system.md` | 相对于请求的工作目录 |

### 为什么是 hook 而不是 middleware

Magpie 的 `magpie.middleware` 跑在自带的 moejs 引擎里，那里没有 `node:fs`：
middleware 根本读不了文件。异步的 `magpie.hooks` 入口跑在 Bun 插件宿主里，
`node:fs` 可用，所以这个插件做成 hook。两个入口名不重叠，同一个文件只会被当作
hook 加载。

### 对请求的克制

- 绝不改 `model`、`stream`、tools 或 tool_choice。
- 文件读不到时在插件宿主日志里报一行，请求原样放行，绝不让调用失败。

### 测试

```sh
node test/run.test.mjs
```

36 个用例：四种协议、append 与 prepend、`override` 开与关、`agents` 与 `models`
过滤、frontmatter 开与关、多文件、内联兜底、`~` 与相对路径、文件缺失、热更新，
以及跨平台路径与编码。

### 卸载

```sh
magpie plugin rm ~/.config/magpie/plugins/magpie-system-prompt-file
```

## License

MIT
