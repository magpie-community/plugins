# Claude Subagent Router

[English](README.en.md)

为 Magpie 中的 Claude Code 提供全局多模型子代理池。每个已选模型对应一个具名子代理，并可附加多个职责标签；Claude 自主决定是否委派、选择哪些子代理，以及是否并行执行。多个结果由 Claude 自行比较、评审和综合。

仅支持 Claude Code，不更改其他 Agent，也不直接调用模型 API。

## 功能

- 从 Magpie 已为 Claude Code 提供的模型目录中选择多个模型，支持跨提供商和路由组。
- 为每个模型选择零个或多个固定职责：快速执行、复杂推理、代码实现、代码审查、探索研究、通用任务。
- 未选择职责时，子代理描述仅包含模型信息，不附加职责倾向。
- 插件页面和子代理职责说明支持中英文。
- 保留 Magpie 原有 Subagent 单模型默认值；生成的具名子代理仅覆盖自身模型。
- 模型池生效时接管默认委派，要求 Claude 从具名模型池选择；支持严格和宽松两种模式。
- 配置 N 个模型后，路由池就有 N 个可选模型。主 Claude 自身模型不计入其中；默认子委派不额外提供直接的 Claude Sonnet、Opus、Haiku 或其他池外模型选项。严格模式拒绝池外具名代理（包括 OMC 专家）；宽松模式保留显式具名代理的自身模型选择。
- 清空模型池后移除本插件生成且未被修改的定义，停止路由干预，恢复原有单模型行为。

## 与 Agent 团队插件协作

本插件可以独立使用，**不需要安装 OMC 或其他 Agent 团队插件**。它为 Claude Code 原生 Agent/Task 委派补充的是“选择哪个模型、适合什么职责”这一层；任务如何拆解、代理如何协作、结果如何验收，仍由 Claude Code 或你使用的团队工作流负责。

- **只使用 Claude Code：** 主 Claude 可以从模型池选择不同模型分别探索、实现和审查，独立任务可并行执行，最后由主 Claude 综合结果。
- **使用 OMC 等 Agent 团队插件时：** 严格模式把 OMC 的具名专家视为池外代理并拒绝其委派，返回职责匹配的 `router-*` 候选，由 Claude 把原专家职责写入新代理的任务提示词。OMC 原生的多阶段团队流程不能完整保留；继续完整使用 OMC 工作流时，请切换到宽松模式。
- **为什么拒绝而不是覆盖模型：** OMC 的 `oh-my-claudecode:executor`、`oh-my-claudecode:code-reviewer` 等代理定义 pin 了 `sonnet`、`opus` 或 `haiku`。代理定义的 `model` 优先于调用时的覆盖值，而 Hook 收到的调用常常没有 `model` 字段，因此不能只改调用参数就保证模型生效。本插件不修改 OMC 文件；严格模式通过拒绝池外具名类型，确保实际启动的代理来自模型池。
- **两种模式各有边界：** 严格模式允许同一模型池内的 `router-*` 代理；`inherit` 不会改变这一限制。宽松模式只接管默认委派，显式 `general-purpose` 和具名自定义代理保留自身模型，因此不承诺 OMC 一定使用模型池。所有任务仍由 Magpie 的既有提供商路由处理。

因此，本插件与 OMC 一类插件的关系是**模型路由与专家工作流之间的明确模式选择**：严格模式优先模型池，宽松模式优先保留具名专家工作流。

## 环境与兼容性

- Windows 10/11。
- 已在 **Magpie 0.1.2332 / Claude Code 2.1.318** 上验证插件安装、宿主加载、两模型定义生成及空池回退；另已并行验证三个不同模型的具名子代理实际回复。严格模式已实测将省略类型和显式 `general-purpose` 的委派改选为具名路由；SessionStart 也已实测让新会话第一次委派直接选择 `router-*`。
- 支持包含 `model` 子代理定义字段和并行 Agent/Task 调用的 Claude Code 版本。
- 模型目录读取 Magpie 写入 Claude Code `settings.json` 的 `modelPicker.options`。这是当前宿主没有公开完整模型目录读取权限时采用的兼容方案，并非稳定的 Magpie 公共 API；其他版本可能需要适配。

## 安装

### 从 GitHub 安装

在 Windows Terminal 中运行：

```powershell
magpie plugin add github:Emilia06120878/magpie-claude-subagent-router
```

也可在 Magpie 的“设置 → 插件”中添加同一仓库地址。安装后宿主加载时会注册空池、不干预调用的 Hook；打开插件配置页，选择模型并点击**应用**，才会生成子代理并启用路由。

### 本地开发安装

```powershell
git clone https://github.com/Emilia06120878/magpie-claude-subagent-router.git
magpie plugin add .\magpie-claude-subagent-router
```

本地目录以原地方式加载，不会复制到 Magpie 插件目录。修改源码后，在 Magpie 中关闭再开启插件，然后重新打开配置页面。

## 使用

1. 先在 Magpie 中配置提供商、路由组和 Claude Code，并应用 Agent 设置。
2. 在 Magpie 侧边栏打开 **Claude Subagent Router**，或从 Agents 页面中 Claude Code 的菜单打开配置页。
3. 勾选模型；按需为每个模型勾选职责标签。
4. 选择默认委派模式：**严格**要求所有 Agent/Task 委派使用生成的 `router-*` 代理，包括省略类型、显式 `general-purpose`、OMC 专家和其他池外具名类型；拒绝原因会按职责优先列出候选。**宽松**只拦截省略类型的调用，允许显式 `general-purpose` 和具名自定义代理。
5. 点击**应用**。宿主重载后生成子代理定义、更新动态路由状态，并安装 Claude Code `SessionStart` 与 `PreToolUse` Hook。
6. 启动新的 Claude Code 会话，确认具名子代理和 Hook 已加载。Claude 可使用一个子代理，也可并行调用多个；它也可以不委派。

要恢复原行为，点击**清空模型池**，再点击**应用**。未应用的页面更改不会影响子代理。

## 实现方法

插件由 Magpie 宿主模块和沙盒配置页面组成：

1. 宿主按 `CLAUDE_CONFIG_DIR`（未设置时为 `~/.claude`）定位 Claude Code 配置目录。
2. 从 Claude Code `settings.json` 的 `modelPicker.options` 读取 Magpie 管理的模型目录，仅保留 `model` 与 `label`；页面使用本地静态快照，不进行网络请求。
3. 点击应用时，页面将规范化后的全局模型池保存到插件自身 options，Magpie 随后重载宿主。
4. 每个模型生成一个稳定名称的 `<claude-config-dir>/agents/<name>.md`，通过 frontmatter 中的 `model` 保留完整模型引用，通过 `description` 向 Claude 提供中英文职责说明。
5. Claude Code 原生 Agent/Task 机制负责子代理执行和并行调度，请求继续经由 Magpie 的既有模型路由。不会创建独立的模型客户端或额外评审模型。
6. 插件向 Claude Code 用户级 `settings.json` 添加两个带唯一命令路径的 Hook。`SessionStart` 在新会话注入当前模型池及选择规则，要求父 Claude 第一次委派就明确选择 `router-*`；`PreToolUse` 匹配 `Agent|Task` 并兜底拦截默认渠道。两者均从 `agents/.claude-subagent-router-route.json` 读取本次成功生成的代理名单。严格模式拦截省略类型、显式 `general-purpose` 和所有池外具名类型（包括 OMC 专家），宽松模式仅拦截省略类型。显式指定池外 `model`（包括直接的 Claude `claude-sonnet`、`claude-opus`、`claude-haiku` 引用）也会被拒绝，不能绕过路由；应省略 `model` 字段并选择池内具名子代理，由该定义提供实际模型。其他池内模型引用及 `inherit` 仅允许用于生成的具名代理。拒绝原因把可选名称和职责反馈给父 Claude，由 Claude 选择后重试，不擅自选择模型。
7. 生成的 `router-*` 正常放行；严格模式拒绝 Explore、Plan 和其他自定义子代理，宽松模式保留这些具名类型。空池时 SessionStart 不注入指令，PreToolUse 不拦截；路由文件缺失或损坏、Hook 异常时也完全不干预。Hook 不写日志，不发送网络请求，也不自动批准权限。
8. 子代理定义中的模型优先于 Magpie 原有的 `CLAUDE_CODE_SUBAGENT_MODEL` 默认值；未指定该字段的子代理仍遵循原有优先级。

本插件提供独立页面，不替换 Magpie 原生“档位 → Subagent”单选控件。

## 文件安全

- 使用稳定的合法名称和模型 ID 哈希，避免特殊字符影响文件名。
- 通过 `agents/.claude-subagent-router.json` 记录本插件生成文件的 SHA-256。
- 不覆盖同名用户文件；用户修改过的生成文件不再自动更新或删除。
- 采用同目录临时文件原子写入。
- 模型目录损坏或不可用时保留现有定义；已保存但暂时不在目录中的模型不会被静默删除，取消选择后才清理其未修改的定义。
- 清空模型池不需要可用模型目录，仍可清理未被修改的插件定义。

## 限制

- 配置依赖 Windows 本机 Claude Code 配置目录；不支持 Claude Code 的 WSL 独立配置。
- Magpie 的模型选择器发生变化后，重新打开插件页面或应用配置以刷新目录。
- 已在某个 Claude Code 会话中加载的子代理定义和 Hook 需要新会话才能更新；安装、模式变更和清空后都应重启 Claude Code。
- Hook 使用命令 `node <插件目录>/hook.js`，因此系统需能在命令行运行 Node.js 20 或更高版本。
- 禁用或卸载插件前，请先清空模型池并应用。空池停止路由干预，但 Hook 配置仍保留为无操作项；宿主停止后无法保证自动清理。卸载后可使用下面的卸载步骤移除 Hook、路由状态和未修改的插件定义。手动修改过的定义会保留。
- 同名冲突或手动修改会在页面中列出，插件不会接管这些文件，也不会把它们加入可路由名单。

## 卸载

### 推荐：先清理，再卸载插件

1. 在插件页面点击**清空模型池**，再点击**应用**。这会删除未被修改的插件子代理，并停止路由干预。
2. 在 Windows Terminal 中运行：

```powershell
magpie plugin rm magpie-claude-subagent-router
```

3. 重启 Claude Code。清空模型池后，已安装但未加载新配置的 Hook 不会干预默认委派。

### 完整清理（适用于不再使用插件）

如果希望同时移除 Hook、路由状态和所有未被修改的插件定义，在**卸载插件前**运行：

```powershell
node "<已安装插件目录>\uninstall-hook.js"
magpie plugin rm magpie-claude-subagent-router
```

GitHub 安装版的实际目录可在 Magpie 的插件详情中查看；本地开发版就是克隆的项目目录。脚本只删除本插件拥有的 Hook 和未被用户修改的定义，不删除其他 Claude Code 子代理，也不删除源码目录。

如果已经先卸载插件，可在仍保留的项目源码目录运行 `node uninstall-hook.js`，或手动删除 Claude Code `settings.json` 中指向本插件 `hook.js` 的 SessionStart 和 PreToolUse 两个条目。

## 隐私

插件没有 npm 依赖，不发送网络请求，不读取提供商凭据配置。宿主读写 Claude Code `settings.json` 以读取模型目录并维护本插件的两个 Hook 条目，保留其他设置；不会重写 `env` 的语义。页面快照仅包含模型 ID、显示名称和同步状态，不包含 `description`、环境变量、账户标识或密钥。模型选择、职责和路由模式保存在 Magpie 的插件选项中。

路由状态仅记录具名代理、模型引用和职责描述。Hook 接收 Claude Code 提供的 Agent/Task 调用 JSON，但不保存任务内容、不写日志，也不将内容发送到其他服务。

模型任务内容由 Claude Code 和 Magpie 的既有执行链路处理，遵循用户已配置的提供商与隐私设置。

## 开发

需要 Node.js 20 或更高版本，无需安装依赖：

```powershell
npm test
npm run test:coverage
```

测试使用临时目录，不修改真实 Claude Code 配置。自动化测试覆盖多模型与多职责、完整模型引用、空池回退、文件所有权、损坏目录、Windows 路径和敏感字段隔离。

## 许可证

[MIT](LICENSE) © 2026 Emilia06120878 and contributors
