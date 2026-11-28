// Configuration semantics: Firstmate docs/configuration.md at 298440ea.
// Handbook snapshots explain intent; current native readers own values and inheritance.
const harnesses = ['default', 'claude', 'codex', 'pi', 'pi-signed', 'opencode', 'grok', 'kimi', 'cursor', 'omp', 'agy', 'muse', 'gemini', 'rovo', 'devin', 'commandcode', 'polytoken', 'cortex', 'kiro', 'hermes'];
const backends = ['tmux', 'herdr', 'zellij', 'orca', 'cmux', 'paseo', 'rex', 't3code', 'tern', 'hc'];
export const definitions = [
  { key: 'crew-harness', label: '船员默认工具', group: '派工', choices: harnesses, inherited: true, fallback: '跟随当值 Firstmate 的工具；派工规则和任务显式选择优先。', effect: '影响以后启动的船员，不改变正在运行的会话。' },
  { key: 'backend', label: '任务运行后端', group: '派工', choices: backends, inherited: true, fallback: '先读取 FM_BACKEND，再按运行环境自动检测；最终默认 tmux。', effect: '仅保存选择，不安装依赖、不迁移或重启会话。显式任务选择和环境变量仍优先。' },
  { key: 'crew-exclude-tools', label: '船员工具排除', group: '派工', multiline: true, fallback: '没有额外工具排除；普通船员的固定通信隔离仍生效。', effect: '一行一个工具名，可保留 # 注释。不继承；仅 Claude、Pi、Pi Signed 支持非空名单，其他工具会拒绝新启动。', native: 'exclusions' },
  { key: 'project-capacity', label: '本机项目并发容量', group: '派工', multiline: true, rootOnly: true, fallback: '不设置项目容量上限。', effect: '每行“项目名称 正整数”，允许项目名称含空格；本机各 Home 共用根 Home 的容量声明，不跨机器继承。', native: 'capacity' },
  { key: 'backlog-backend', label: '任务记录方式', group: '派工', choices: ['tasks-axi', 'manual'], inherited: true, fallback: 'tasks-axi；具体账本由 .tasks.toml 决定。', effect: '仅保存后续操作的选择，不迁移已有任务记录。' },
  { key: 'startup-memory-budget', label: '启动记忆预算', group: '监督', inherited: true, fallback: '由 Firstmate 初始化默认 7500 估算 tokens；未运行初始化时不推断已生效。', effect: '正整数，控制以后启动时输出的记忆预算。', numeric: true, native: 'budget' },
  { key: 'supervision-host', label: '后台监督引擎', group: '监督', fallback: 'Claude 大副默认启用自己的引擎；其他工具默认不开启。', effect: '格式 claude [模型] 或 default [模型]。本 Home 独立；下一次通知时读取，不重启会话。' },
  { key: 'supervision-host-off', label: '关闭后台监督', group: '监督', flag: true, inherited: true, fallback: '未显式关闭；是否启用仍由工具与 supervision-host 决定。', effect: '文件存在即关闭，内容没有意义。大副的开关会继承到二副，下一次通知时读取。' },
  { key: 'self-update-source', label: 'Firstmate 更新来源', group: '更新与权限', readOnly: '更新来源影响执行代码的来源。此版本只显示，不通过通用配置编辑器改变。', fallback: 'origin；仍受 Firstmate 原生更新检查约束。', effect: '格式为已有 remote 和 branch，不继承。保存界面不会执行更新。' },
  { key: 'firstmate-role', label: '上游发布身份', group: '更新与权限', inherited: true, readOnly: '发布授权必须通过 Firstmate 的明确授权流程；此页面不能授予权限。', fallback: 'user/operator，没有上游发布授权。', effect: '配置文件不等于有效授权；二副还需要原生继承回执证明。' },
  { key: 'claude-account', label: 'Claude 船员账号固定', group: '更新与权限', private: true, readOnly: '账号选择只由你决定，此页面不读取账号内容，也不修改账号。', fallback: '未固定，使用原生启动规则的环境账号。', effect: '本 Home 独立，不继承。' },
  { key: 'pi-account', label: 'Pi 船员账号固定', group: '更新与权限', private: true, readOnly: '账号选择只由你决定，此页面不读取账号内容，也不修改账号。', fallback: '未固定，使用目标窗口的环境账号。', effect: '本 Home 独立，不继承。' },
  { key: 'claude-permission-mode', label: 'Claude 船员权限模式', group: '更新与权限', inherited: true, readOnly: '权限模式会改变安全边界，此版本仅展示；更改需明确指定所需模式。', fallback: '使用 Firstmate 原生权限选择与受管理策略规则。', effect: '不修改现有或后续任务权限。' },
  { key: 'codex-approval-mode', label: 'Codex 船员审批模式', group: '更新与权限', inherited: true, readOnly: '审批模式会改变安全边界，此版本仅展示；更改需明确指定所需模式。', fallback: '使用 Firstmate 原生审批与受管理策略规则。', effect: '不修改现有或后续任务权限。' },
];

definitions.push(
  {"key": "calm", "label": "Calm 简洁呈现", "group": "运行", "choices": ["on", "off", "max"], "choiceLabels": {"on": "开启", "off": "关闭", "max": "开启（旧值 max）"}, "defaultLabel": "关闭", "fallback": "未配置、不可读或未知值时关闭；旧值 max 等同开启。", "effect": "Pi 与 Claude 共用本 Home 的呈现偏好；不改变模型。", "applies": "下次会话启动或原生 /calm 命令读取", "common": true, "reference": "手册 §19.4"},
  {"key": "launch-env-allowlist", "label": "启动环境变量白名单", "group": "运行", "multiline": true, "lineFormat": "envNames", "defaultLabel": "不筛选环境变量", "fallback": "未配置时沿用目标窗口的环境；空文件启用过滤，只保留原生运行底座。", "effect": "每行只写变量名，不写值。变量值来自目标环境，不跨机复制凭据；T3 Code 在存在白名单时拒绝启动。", "applies": "后续船员及副手启动", "common": true, "reference": "手册 §19.4"},
  {"key": "herdr-presentation-spaces", "label": "Herdr 独立任务展示", "group": "运行", "choices": ["on", "off"], "defaultLabel": "自动（取决于版本）", "fallback": "未配置时：自动（取决于版本）。", "effect": "仅影响任务可视投影，不迁移任务；默认开启仍受 Herdr 最低版本约束。", "applies": "后续 Herdr 任务启动"},
  {"key": "rex-status-marks", "label": "Rex 等待提醒", "group": "运行", "choices": ["on", "off"], "defaultLabel": "关闭", "fallback": "未配置时：关闭。", "effect": "需要你处理的任务显示程序状态及通知，仅适用于 Rex。", "applies": "后续 Rex 状态上报"},
  {"key": "rex-tint", "label": "Rex 等待背景", "group": "运行", "choices": ["off", "subtle", "subtle-light"], "defaultLabel": "off", "fallback": "未配置时：off。", "effect": "等待和失败任务的背景提示，仅适用于 Rex。", "applies": "后续 Rex 状态上报"},
  {"key": "osc7501-status", "label": "终端任务状态上报", "group": "运行", "choices": ["on", "off"], "defaultLabel": "on", "fallback": "未配置时：on。", "effect": "仅在已识别且支持的终端上报 OSC 7501 状态。", "applies": "后续任务窗口初始化"},
  {"key": "wait-no-turns", "label": "等待时不消耗轮次", "group": "监督", "flag": true, "presentLabel": "已启用", "defaultLabel": "关闭", "fallback": "未配置时关闭。", "effect": "等待指令由通知唤醒，生成 brief 时加入不轮询要求。", "applies": "后续 brief 生成及恢复处理", "common": true},
  {"key": "codex-stop-park", "label": "Codex 原生回合间等待", "group": "监督", "flag": true, "presentLabel": "已启用", "defaultLabel": "关闭", "fallback": "未配置时关闭。", "effect": "让 Codex 主控在模型外等待 Watcher 唤醒；此页不会启动或修复 Watcher。", "applies": "后续 Codex Stop 等待", "common": false},
  {"key": "supervision-handoff-ack", "label": "监督交接确认", "group": "监督", "flag": true, "presentLabel": "已启用", "defaultLabel": "关闭", "fallback": "未配置时关闭。", "effect": "仅适用启用后台监督的 Claude 主控；交接持续到主控确认。", "applies": "后续监督交接", "common": false},
  {"key": "wedge-defer-parked-gate", "label": "验证关口等待不误报卡死", "group": "监督", "flag": true, "presentLabel": "已启用", "defaultLabel": "关闭", "fallback": "未配置时关闭。", "effect": "有原生证据证明正在等待监督者决策时，推迟卡死升级。", "applies": "后续 Watcher 检查", "common": true},
  {"key": "wedge-defer-worker-wait", "label": "船员已声明等待时推迟升级", "group": "监督", "flag": true, "presentLabel": "已启用", "defaultLabel": "关闭", "fallback": "未配置时关闭。", "effect": "只接受仍未解决的船员 blocked 或 needs-decision 状态，不从文字猜测等待。", "applies": "后续 Watcher 或离开模式检查", "common": false},
  {"key": "wedge-defer-validating", "label": "验证运行中推迟卡死升级", "group": "监督", "flag": true, "presentLabel": "已启用", "defaultLabel": "关闭", "fallback": "未配置时关闭。", "effect": "仅在归属明确的 no-mistakes 运行处于 running 或 fixing 时推迟。", "applies": "后续 Watcher 检查", "common": true},
  {"key": "paused-wait-supersession", "label": "等待原因失效时提前提醒", "group": "监督", "flag": true, "presentLabel": "已启用", "defaultLabel": "关闭", "fallback": "未配置时关闭。", "effect": "已声明的暂停无法解释当前验证关口或终态时，提前提醒。", "applies": "后续 Watcher 检查", "common": false},
  {"key": "paused-recheck-silent", "label": "未变化的暂停静默复查", "group": "监督", "flag": true, "presentLabel": "已启用", "defaultLabel": "关闭", "fallback": "未配置时关闭。", "effect": "首见、状态变化、到期或有未决项仍提醒；不改变复查间隔。", "applies": "后续 Watcher 检查", "common": false},
  {"key": "open-decision-reminders", "label": "未回答决策的到期提醒", "group": "监督", "flag": true, "presentLabel": "已启用", "defaultLabel": "关闭", "fallback": "未配置时关闭。", "effect": "对有明确键和时间的未决项按退避规则提醒；阈值由 Watcher 环境配置。", "applies": "后续 Watcher 检查", "common": false},
  {"key": "pause-ceiling", "label": "暂停到期升级为待处理", "group": "监督", "flag": true, "presentLabel": "已启用", "defaultLabel": "关闭", "fallback": "未配置时关闭。", "effect": "过期暂停产生一个待处理项；不会中断、退出或删除工作。", "applies": "后续 Watcher 或离开模式检查", "common": false},
  {"key": "turnend-churn-absorb", "label": "窗口仍变化时暂缓回合结束提醒", "group": "监督", "flag": true, "presentLabel": "已启用", "defaultLabel": "关闭", "fallback": "未配置时关闭。", "effect": "这是窗口变化推断，仍受证据及时间上限约束。", "applies": "后续 Watcher 检查", "common": false},
  {"key": "pr-health-monitor", "label": "PR 健康监控", "group": "交付", "flag": true, "presentLabel": "已启用", "defaultLabel": "关闭", "fallback": "未配置时关闭。", "effect": "只读监控本 Home 拥有的 PR，报告冲突、失败检查和作者待办；不评论或修改 PR。", "applies": "下次会话启动；已有监控在后续检查读取", "common": true},
  {"key": "pr-register-scan", "label": "自动登记船员报告的 PR", "group": "交付", "flag": true, "presentLabel": "已启用", "defaultLabel": "关闭", "fallback": "未配置时关闭。", "effect": "仅识别船员规范的 done 行，不从普通正文推断交付。", "applies": "后续 Watcher 检查", "common": false},
  {"key": "pr-degraded-watch", "label": "PR 变差时提醒", "group": "交付", "flag": true, "presentLabel": "已启用", "defaultLabel": "关闭", "fallback": "未配置时关闭。", "effect": "登记后检查失败、流水线失败或退出合并列车时提醒，不授予合并权限。", "applies": "后续登记与检查", "common": false},
  {"key": "park-on-review", "label": "只待人工审查时停放任务", "group": "交付", "flag": true, "presentLabel": "已启用", "defaultLabel": "关闭", "fallback": "未配置时关闭。", "effect": "停止只等待人工 PR 审查的空闲船员；保留未落地工作及任务记录。", "applies": "后续原生停放检查", "common": true},
  {"key": "hold-pr-settle", "label": "按 PR 结果结算已声明等待", "group": "交付", "flag": true, "presentLabel": "已启用", "defaultLabel": "关闭", "fallback": "未配置时关闭。", "effect": "仅处理已显式声明 PR 策略的 captain hold，不替你回答问题。", "applies": "后续贡献观察轮询", "common": false},
  {"key": "ready-after-green", "label": "检查通过后再向大副报可审查", "group": "交付", "flag": true, "presentLabel": "已启用", "defaultLabel": "关闭", "fallback": "未配置时关闭。", "effect": "二副的 PR 就绪回报等待船员报告检查通过；不代表已合并。", "applies": "后续二副交付回报", "common": false},
  {"key": "pipeline-spend", "label": "记录验证流水线用量", "group": "交付", "flag": true, "presentLabel": "已启用", "defaultLabel": "关闭", "fallback": "未配置时关闭。", "effect": "任务清理时把 no-mistakes 用量写入本 Home 的记录。", "applies": "后续原生任务清理", "common": true},
  {"key": "pr-squash-summary", "label": "Squash 提交采用 PR 摘要", "group": "交付", "flag": true, "presentLabel": "已启用", "defaultLabel": "关闭", "fallback": "未配置时关闭。", "effect": "仅在原生 GitHub squash 合并且无显式标题正文时采用 What Changed；不改变合并授权。", "applies": "后续符合条件的合并", "common": false},
  {"key": "status-archive", "label": "归档任务状态日志", "group": "交付", "flag": true, "presentLabel": "已启用", "defaultLabel": "关闭", "fallback": "未配置时关闭。", "effect": "原生清理路径保留已结束任务的状态历史。", "applies": "后续原生任务清理", "common": false},
  {"key": "record-hygiene", "label": "任务记录一致性报告", "group": "交付", "flag": true, "presentLabel": "已启用", "defaultLabel": "关闭", "fallback": "未配置时关闭。", "effect": "只报告本 Home 的不一致；此开关不授权清理。", "applies": "下次启动或后续心跳检查", "common": false},
  {"key": "treehouse-pool-report", "label": "Treehouse 池只读报告", "group": "交付", "flag": true, "presentLabel": "已启用", "defaultLabel": "关闭", "fallback": "未配置时关闭。", "effect": "只报告异常、重复或未归属池，不删除池或槽位。", "applies": "下次 bootstrap 读取", "common": false},
  {"key": "fleet-ledger", "label": "舰队活动日志", "group": "交付", "flag": true, "presentLabel": "已启用", "defaultLabel": "关闭", "fallback": "未配置时关闭。", "effect": "向本 Home 的活动日志追加原生事件，供外部工具读取。", "applies": "后续原生事件写入", "common": false},
  {"key": "stow-pass-horizon", "label": "记忆按整理次数衰减", "group": "记忆", "flag": true, "presentLabel": "已启用", "defaultLabel": "关闭", "fallback": "未配置时关闭。", "effect": "为 /stow 启用按 pass 计数的记忆衰减窗口。", "applies": "下次 /stow", "common": false},
  {"key": "herdr-lifecycle-spawn-guard", "label": "Herdr 生命周期隔离检查", "group": "运行", "flag": true, "presentLabel": "已启用", "defaultLabel": "关闭", "fallback": "未配置时关闭。", "effect": "含 Herdr 生命周期命令但缺少隔离约定的任务 brief 会被拒绝启动。", "applies": "后续派工启动", "common": false},
  {"key": "spawn-base-primary-checkout", "label": "本地交付从主检出继承已落地提交", "group": "运行", "flag": true, "presentLabel": "已启用", "defaultLabel": "关闭", "fallback": "未配置时关闭。", "effect": "仅适用符合原生条件的 local-only 任务或 scout；其他交付路径仍以 origin 为基准。", "applies": "后续符合条件的任务与审查", "common": false},
  {"key": "trace-context", "label": "跨进程追踪上下文", "group": "运行", "flag": true, "presentLabel": "已启用", "defaultLabel": "关闭", "fallback": "未配置时关闭。", "effect": "为后续 Agent 传递原生 W3C 追踪上下文，不传递账号凭据。", "applies": "后续 Agent 启动", "common": false},
  {"key": "warm-compact", "label": "温热缓存期间压缩", "group": "记忆", "parameters": [{"key": "idle-seconds", "label": "空闲时间（秒）", "default": 2700}, {"key": "min-context-tokens", "label": "最小上下文（tokens）", "default": 80000}], "multiline": true, "defaultLabel": "关闭", "fallback": "未配置时关闭；启用且未填写参数时采用原生默认值。", "effect": "仅在 Claude 主控及对应后台监督满足空闲、上下文、输入框为空等原生条件时压缩；不执行即时压缩。", "applies": "后台监督后续空闲检查", "common": true, "reference": "手册 §19.4"},
  {"key": "stow-guard", "label": "上下文整理提醒", "group": "记忆", "parameters": [{"key": "tokens", "label": "上下文阈值（tokens）", "default": 300000}, {"key": "hours", "label": "距上次整理（小时）", "default": 24}], "multiline": true, "defaultLabel": "关闭", "fallback": "未配置时关闭；启用且未填写参数时采用原生默认值。", "effect": "仅适用本 Home 的普通 Claude 主控；触发已有 /stow 提醒，不自行压缩。", "applies": "后续 Claude Stop 检查", "common": false, "reference": "当前配置文档"},
  {"key": "supervision-branch-model", "label": "Pi 监督分支模型", "group": "监督", "private": true, "readOnly": "此项由专门的原生入口管理；本页只检查配置文件是否存在。", "fallback": "未配置；有效默认及前置条件以原生入口为准。", "defaultLabel": "未配置", "effect": "使用 Pi 的 /supervision-model 选择实际可用模型；不能用普通目录代替隔离分支的连通性检查。", "applies": "由专门入口核对", "hiddenLabel": "已配置 · 内容隐藏"},
  {"key": "supervision-branch-effort", "label": "Pi 监督分支推理强度", "group": "监督", "private": true, "readOnly": "此项由专门的原生入口管理；本页只检查配置文件是否存在。", "fallback": "未配置；有效默认及前置条件以原生入口为准。", "defaultLabel": "未配置", "effect": "与 /supervision-model 的模型选择一起核对能力；不改变主控模型。", "applies": "由专门入口核对", "hiddenLabel": "已配置 · 内容隐藏"},
  {"key": "lane-capacity", "label": "任务通道容量策略", "group": "运行", "private": true, "readOnly": "此项由专门的原生入口管理；本页只检查配置文件是否存在。", "fallback": "未配置；有效默认及前置条件以原生入口为准。", "defaultLabel": "未配置", "effect": "包含容量、压力源及准入规则；按原生 fm-capacity 配置，不能与本机项目并发上限混用。", "applies": "由专门入口核对", "hiddenLabel": "已配置 · 内容隐藏"},
  {"key": "herdr-project-groups", "label": "Herdr 项目分组规则", "group": "运行", "private": true, "readOnly": "此项由专门的原生入口管理；本页只检查配置文件是否存在。", "fallback": "未配置；有效默认及前置条件以原生入口为准。", "defaultLabel": "未配置", "effect": "可含任务前缀及项目的分组规则，仅改变显示与符合条件的窗口摆放。", "applies": "由专门入口核对", "hiddenLabel": "已配置 · 内容隐藏"},
  {"key": "read-repetition.json", "label": "Pi 重复读取限制", "group": "记忆", "private": true, "readOnly": "此项由专门的原生入口管理；本页只检查配置文件是否存在。", "fallback": "未配置；有效默认及前置条件以原生入口为准。", "defaultLabel": "未配置", "effect": "由 Pi 扩展加载的 JSON 策略；规则与当前 Pi 扩展版本配套。", "applies": "由专门入口核对", "hiddenLabel": "已配置 · 内容隐藏"},
  {"key": "brief-include.md", "label": "船员常令", "group": "记忆", "private": true, "readOnly": "此项由专门的原生入口管理；本页只检查配置文件是否存在。", "fallback": "未配置；有效默认及前置条件以原生入口为准。", "defaultLabel": "未配置", "effect": "在生成 ship 或 scout brief 时附加；仅本 Home，不继承。本文不展示常令内容。", "applies": "由专门入口核对", "hiddenLabel": "已配置 · 内容隐藏"},
  {"key": "branch-prompt-include.md", "label": "监督分支常令", "group": "记忆", "private": true, "readOnly": "此项由专门的原生入口管理；本页只检查配置文件是否存在。", "fallback": "未配置；有效默认及前置条件以原生入口为准。", "defaultLabel": "未配置", "effect": "追加到监督分支提示词末尾；仅本 Home，不继承。本文不展示常令内容。", "applies": "由专门入口核对", "hiddenLabel": "已配置 · 内容隐藏"},
  {"key": "dispatch-never-send", "label": "派工解析禁止发送字段", "group": "权限", "private": true, "readOnly": "此项由专门的原生入口管理；本页只检查配置文件是否存在。", "fallback": "未配置；有效默认及前置条件以原生入口为准。", "defaultLabel": "未配置", "effect": "限制发送到派工解析服务的数据；配置沿原生继承流程传播。", "applies": "由专门入口核对", "hiddenLabel": "已配置 · 内容隐藏"},
  {"key": "claude-accounts", "label": "Claude 可选账号列表", "group": "权限", "private": true, "readOnly": "此项由专门的原生入口管理；本页只检查配置文件是否存在。", "fallback": "未配置；有效默认及前置条件以原生入口为准。", "defaultLabel": "未配置", "effect": "多个账号按原生派工规则选择，与单账号固定互斥；不显示账号内容。", "applies": "由专门入口核对", "hiddenLabel": "已配置 · 内容隐藏"},
  {"key": "codex-permission-mode", "label": "Codex 文件与命令权限", "group": "权限", "private": true, "readOnly": "此项由专门的原生入口管理；本页只检查配置文件是否存在。", "fallback": "未配置；有效默认及前置条件以原生入口为准。", "defaultLabel": "未配置", "effect": "与自动审批模式分别管理；缺文件的原生默认不代表正在运行会话的有效权限。", "applies": "由专门入口核对", "hiddenLabel": "已配置 · 内容隐藏"},
  {"key": "auto-land", "label": "合并后自动清理", "group": "交付", "private": true, "readOnly": "此项由专门的原生入口管理；本页只检查配置文件是否存在。", "fallback": "未配置；有效默认及前置条件以原生入口为准。", "defaultLabel": "未配置", "effect": "涉及任务清理与落地核查，须由原生生命周期流程管理。", "applies": "由专门入口核对", "hiddenLabel": "已配置 · 内容隐藏"},
  {"key": "keep-ai-trailers", "label": "保留 AI 提交署名", "group": "交付", "private": true, "readOnly": "此项由专门的原生入口管理；本页只检查配置文件是否存在。", "fallback": "未配置；有效默认及前置条件以原生入口为准。", "defaultLabel": "未配置", "effect": "提交归属策略受当前项目与用户约定约束；普通设置页不更改。", "applies": "由专门入口核对", "hiddenLabel": "已配置 · 内容隐藏"},
  {"key": "contribution-review-bots", "label": "可信审查机器人名单", "group": "交付", "private": true, "readOnly": "此项由专门的原生入口管理；本页只检查配置文件是否存在。", "fallback": "未配置；有效默认及前置条件以原生入口为准。", "defaultLabel": "未配置", "effect": "精确匹配 GitHub 登录名的信号白名单，不用显示名或评论正文匹配。", "applies": "由专门入口核对", "hiddenLabel": "已配置 · 内容隐藏"},
  {"key": "nm-home-resolver", "label": "验证 Home 解析程序", "group": "交付", "private": true, "readOnly": "此项由专门的原生入口管理；本页只检查配置文件是否存在。", "fallback": "未配置；有效默认及前置条件以原生入口为准。", "defaultLabel": "未配置", "effect": "本机可执行程序路径；由原生安装及验证流程管理。", "applies": "由专门入口核对", "hiddenLabel": "已配置 · 内容隐藏"},
  {"key": "record-export-root", "label": "任务记录导出目录", "group": "交付", "private": true, "readOnly": "此项由专门的原生入口管理；本页只检查配置文件是否存在。", "fallback": "未配置；有效默认及前置条件以原生入口为准。", "defaultLabel": "未配置", "effect": "专用绝对路径，需要 Home 间互不重叠的所有权核查。", "applies": "由专门入口核对", "hiddenLabel": "已配置 · 内容隐藏"},
  {"key": "watched-tools.json", "label": "工具更新观察清单", "group": "集成", "private": true, "readOnly": "此项由专门的原生入口管理；本页只检查配置文件是否存在。", "fallback": "未配置；有效默认及前置条件以原生入口为准。", "defaultLabel": "未配置", "effect": "结构化工具清单只控制原生更新观察，不在保存设置时安装或更新工具。", "applies": "由专门入口核对", "hiddenLabel": "已配置 · 内容隐藏"},
  {"key": "usage-warner", "label": "Claude 用量预警阈值", "group": "集成", "private": true, "readOnly": "此项由专门的原生入口管理；本页只检查配置文件是否存在。", "fallback": "未配置；有效默认及前置条件以原生入口为准。", "defaultLabel": "未配置", "effect": "按具体额度窗口设置消耗百分比，并由原生命令启用；不是额度查看器。", "applies": "由专门入口核对", "hiddenLabel": "已配置 · 内容隐藏"},
  {"key": "wedge-evidence-guards", "label": "卡死升级证据程序", "group": "监督", "private": true, "readOnly": "此项由专门的原生入口管理；本页只检查配置文件是否存在。", "fallback": "未配置；有效默认及前置条件以原生入口为准。", "defaultLabel": "未配置", "effect": "可执行程序的绝对路径名单；不能在通用编辑器里设置执行入口。", "applies": "由专门入口核对", "hiddenLabel": "已配置 · 内容隐藏"},
  {"key": "wedge-alarm", "label": "离开模式卡死告警通道", "group": "监督", "private": true, "readOnly": "此项由专门的原生入口管理；本页只检查配置文件是否存在。", "fallback": "未配置；有效默认及前置条件以原生入口为准。", "defaultLabel": "未配置", "effect": "支持系统通知、Herdr 及命令通道；含命令执行入口，交给原生配置流程。", "applies": "由专门入口核对", "hiddenLabel": "已配置 · 内容隐藏"},
  {"key": "launch-env-tmux-session", "label": "Orca 环境来源会话", "group": "运行", "private": true, "readOnly": "此项由专门的原生入口管理；本页只检查配置文件是否存在。", "fallback": "未配置；有效默认及前置条件以原生入口为准。", "defaultLabel": "未配置", "effect": "仅 Orca 使用，需与白名单和现存 tmux 环境一起核验；不跨机继承。", "applies": "由专门入口核对", "hiddenLabel": "已配置 · 内容隐藏"},
  {"key": "watch.env", "label": "Watcher 环境参数", "group": "监督", "private": true, "readOnly": "此项由专门的原生入口管理；本页只检查配置文件是否存在。", "fallback": "未配置；有效默认及前置条件以原生入口为准。", "defaultLabel": "未配置", "effect": "可能包含环境赋值或凭据；不读取内容，启动时按原生入口载入。", "applies": "由专门入口核对", "hiddenLabel": "已配置 · 内容隐藏"},
  {"key": "pstack-dev-base", "label": "PStack 开发基准目录", "group": "集成", "private": true, "readOnly": "此项由专门的原生入口管理；本页只检查配置文件是否存在。", "fallback": "未配置；有效默认及前置条件以原生入口为准。", "defaultLabel": "未配置", "effect": "特定开发检出的绝对路径，只影响符合条件的后续任务。", "applies": "由专门入口核对", "hiddenLabel": "已配置 · 内容隐藏"},
  {"key": "lavish-axi-host", "label": "Lavish 服务地址", "group": "集成", "private": true, "readOnly": "此项由专门的原生入口管理；本页只检查配置文件是否存在。", "fallback": "未配置；有效默认及前置条件以原生入口为准。", "defaultLabel": "未配置", "effect": "每机独立服务的地址，不把 Mac 绝对路径或端口直接当成 WSL 配置。", "applies": "由专门入口核对", "hiddenLabel": "已配置 · 内容隐藏"},
  {"key": "lavish-url-domains", "label": "Lavish 域名项目映射", "group": "集成", "private": true, "readOnly": "此项由专门的原生入口管理；本页只检查配置文件是否存在。", "fallback": "未配置；有效默认及前置条件以原生入口为准。", "defaultLabel": "未配置", "effect": "将评审 URL 归入正确项目，按原生映射格式设置。", "applies": "由专门入口核对", "hiddenLabel": "已配置 · 内容隐藏"},
  {"key": "github-hosts", "label": "GitHub Enterprise 主机", "group": "集成", "private": true, "readOnly": "此项由专门的原生入口管理；本页只检查配置文件是否存在。", "fallback": "未配置；有效默认及前置条件以原生入口为准。", "defaultLabel": "未配置", "effect": "企业主机选择不是账号登录；按原生 forge 配置管理。", "applies": "由专门入口核对", "hiddenLabel": "已配置 · 内容隐藏"},
  {"key": "external-review.md", "label": "外部审查工具说明", "group": "集成", "private": true, "readOnly": "此项由专门的原生入口管理；本页只检查配置文件是否存在。", "fallback": "未配置；有效默认及前置条件以原生入口为准。", "defaultLabel": "未配置", "effect": "按原生外部审查接口管理，不在此处执行审查命令。", "applies": "由专门入口核对", "hiddenLabel": "已配置 · 内容隐藏"},
  {"key": "external-review-url", "label": "外部审查工具地址", "group": "集成", "private": true, "readOnly": "此项由专门的原生入口管理；本页只检查配置文件是否存在。", "fallback": "未配置；有效默认及前置条件以原生入口为准。", "defaultLabel": "未配置", "effect": "地址由原生外部审查接口使用。", "applies": "由专门入口核对", "hiddenLabel": "已配置 · 内容隐藏"},
  {"key": "external-review-backup", "label": "外部审查备用工具", "group": "集成", "private": true, "readOnly": "此项由专门的原生入口管理；本页只检查配置文件是否存在。", "fallback": "未配置；有效默认及前置条件以原生入口为准。", "defaultLabel": "未配置", "effect": "备用工具由原生审查接口解析。", "applies": "由专门入口核对", "hiddenLabel": "已配置 · 内容隐藏"},
  {"key": "t3code-instances", "label": "T3 Code 供应商实例", "group": "集成", "private": true, "readOnly": "此项由专门的原生入口管理；本页只检查配置文件是否存在。", "fallback": "未配置；有效默认及前置条件以原生入口为准。", "defaultLabel": "未配置", "effect": "实例映射需结合 T3 实际目录验证，不从名称猜测模型支持。", "applies": "由专门入口核对", "hiddenLabel": "已配置 · 内容隐藏"},
  {"key": "t3code-token", "label": "T3 Code 连接凭据", "group": "权限", "private": true, "readOnly": "此项由专门的原生入口管理；本页只检查配置文件是否存在。", "fallback": "未配置；有效默认及前置条件以原生入口为准。", "defaultLabel": "未配置", "effect": "只检查文件是否存在，不读取或显示凭据。", "applies": "由专门入口核对", "hiddenLabel": "已配置 · 内容隐藏"},
  {"key": "cmux-socket-password", "label": "cmux 连接凭据", "group": "权限", "private": true, "readOnly": "此项由专门的原生入口管理；本页只检查配置文件是否存在。", "fallback": "未配置；有效默认及前置条件以原生入口为准。", "defaultLabel": "未配置", "effect": "只检查文件是否存在，不读取或显示凭据。", "applies": "由专门入口核对", "hiddenLabel": "已配置 · 内容隐藏"},
  {"key": "voice-region", "label": "语音服务区域", "group": "集成", "private": true, "readOnly": "此项属于语音与 Inbox 的原生配置，不读取内容或调用付费 API。", "fallback": "未配置时遵循原生语音及 Inbox 的必填或默认规则。", "defaultLabel": "未配置", "effect": "语音及模型侧问是独立通道，不改变 Plannotator Inbox，也不接管 Firstmate 任务账。", "applies": "后续原生语音或模型调用", "hiddenLabel": "已配置 · 内容隐藏"},
  {"key": "voice-model", "label": "语音模型", "group": "集成", "private": true, "readOnly": "此项属于语音与 Inbox 的原生配置，不读取内容或调用付费 API。", "fallback": "未配置时遵循原生语音及 Inbox 的必填或默认规则。", "defaultLabel": "未配置", "effect": "语音及模型侧问是独立通道，不改变 Plannotator Inbox，也不接管 Firstmate 任务账。", "applies": "后续原生语音或模型调用", "hiddenLabel": "已配置 · 内容隐藏"},
  {"key": "voice-profile", "label": "语音 AWS 账号配置", "group": "集成", "private": true, "readOnly": "此项属于语音与 Inbox 的原生配置，不读取内容或调用付费 API。", "fallback": "未配置时遵循原生语音及 Inbox 的必填或默认规则。", "defaultLabel": "未配置", "effect": "语音及模型侧问是独立通道，不改变 Plannotator Inbox，也不接管 Firstmate 任务账。", "applies": "后续原生语音或模型调用", "hiddenLabel": "已配置 · 内容隐藏"},
  {"key": "voice-id", "label": "语音音色", "group": "集成", "private": true, "readOnly": "此项属于语音与 Inbox 的原生配置，不读取内容或调用付费 API。", "fallback": "未配置时遵循原生语音及 Inbox 的必填或默认规则。", "defaultLabel": "未配置", "effect": "语音及模型侧问是独立通道，不改变 Plannotator Inbox，也不接管 Firstmate 任务账。", "applies": "后续原生语音或模型调用", "hiddenLabel": "已配置 · 内容隐藏"},
  {"key": "voice-read-scope", "label": "语音读取范围", "group": "集成", "private": true, "readOnly": "此项属于语音与 Inbox 的原生配置，不读取内容或调用付费 API。", "fallback": "未配置时遵循原生语音及 Inbox 的必填或默认规则。", "defaultLabel": "未配置", "effect": "语音及模型侧问是独立通道，不改变 Plannotator Inbox，也不接管 Firstmate 任务账。", "applies": "后续原生语音或模型调用", "hiddenLabel": "已配置 · 内容隐藏"},
  {"key": "voice-read-deny", "label": "语音禁止读取词", "group": "集成", "private": true, "readOnly": "此项属于语音与 Inbox 的原生配置，不读取内容或调用付费 API。", "fallback": "未配置时遵循原生语音及 Inbox 的必填或默认规则。", "defaultLabel": "未配置", "effect": "语音及模型侧问是独立通道，不改变 Plannotator Inbox，也不接管 Firstmate 任务账。", "applies": "后续原生语音或模型调用", "hiddenLabel": "已配置 · 内容隐藏"},
  {"key": "inbox-region", "label": "Inbox 模型区域", "group": "集成", "private": true, "readOnly": "此项属于语音与 Inbox 的原生配置，不读取内容或调用付费 API。", "fallback": "未配置时遵循原生语音及 Inbox 的必填或默认规则。", "defaultLabel": "未配置", "effect": "语音及模型侧问是独立通道，不改变 Plannotator Inbox，也不接管 Firstmate 任务账。", "applies": "后续原生语音或模型调用", "hiddenLabel": "已配置 · 内容隐藏"},
  {"key": "inbox-stt-model", "label": "Inbox 语音转文字模型", "group": "集成", "private": true, "readOnly": "此项属于语音与 Inbox 的原生配置，不读取内容或调用付费 API。", "fallback": "未配置时遵循原生语音及 Inbox 的必填或默认规则。", "defaultLabel": "未配置", "effect": "语音及模型侧问是独立通道，不改变 Plannotator Inbox，也不接管 Firstmate 任务账。", "applies": "后续原生语音或模型调用", "hiddenLabel": "已配置 · 内容隐藏"},
  {"key": "inbox-ask-model", "label": "Inbox 侧问模型", "group": "集成", "private": true, "readOnly": "此项属于语音与 Inbox 的原生配置，不读取内容或调用付费 API。", "fallback": "未配置时遵循原生语音及 Inbox 的必填或默认规则。", "defaultLabel": "未配置", "effect": "语音及模型侧问是独立通道，不改变 Plannotator Inbox，也不接管 Firstmate 任务账。", "applies": "后续原生语音或模型调用", "hiddenLabel": "已配置 · 内容隐藏"},
  {"key": "inbox-profile", "label": "Inbox AWS 账号配置", "group": "集成", "private": true, "readOnly": "此项属于语音与 Inbox 的原生配置，不读取内容或调用付费 API。", "fallback": "未配置时遵循原生语音及 Inbox 的必填或默认规则。", "defaultLabel": "未配置", "effect": "语音及模型侧问是独立通道，不改变 Plannotator Inbox，也不接管 Firstmate 任务账。", "applies": "后续原生语音或模型调用", "hiddenLabel": "已配置 · 内容隐藏"}
);

const oldDefaults = {"crew-harness": "跟随当值工具", "backend": "自动检测", "crew-exclude-tools": "无额外排除", "project-capacity": "不设上限", "backlog-backend": "tasks-axi", "startup-memory-budget": "7500 · 初始化默认", "supervision-host": "按工具默认规则", "supervision-host-off": "未显式关闭", "self-update-source": "origin", "firstmate-role": "user / operator", "claude-account": "未固定", "pi-account": "未固定", "claude-permission-mode": "原生权限规则", "codex-approval-mode": "原生审批规则"};
for (const item of definitions.slice(0, 14)) {
  item.group = ({ 派工: '运行', 监督: '监督', 更新与权限: '权限' })[item.group];
  item.defaultLabel = oldDefaults[item.key];
  item.common = true;
  item.applies = item.readOnly ? '由原生入口核对' : '后续原生读取；不重启运行中的会话';
}
Object.assign(definitions.find(x => x.key === 'supervision-host-off'), { presentLabel: '已关闭' });
Object.assign(definitions.find(x => x.key === 'self-update-source'), { group: '集成' });
Object.assign(definitions.find(x => x.key === 'startup-memory-budget'), { group: '记忆', reference: '手册 §19.4' });
Object.assign(definitions.find(x => x.key === 'crew-exclude-tools'), { unit: '项排除' });
Object.assign(definitions.find(x => x.key === 'project-capacity'), { unit: '个项目' });
Object.assign(definitions.find(x => x.key === 'launch-env-allowlist'), { unit: '个变量名', inherited: true });
const inherited = new Set(['crew-dispatch.json','dispatch-never-send','crew-harness','backlog-backend','backend','herdr-presentation-spaces','herdr-project-groups','startup-memory-budget','trace-context','launch-env-allowlist','claude-permission-mode','codex-approval-mode','lavish-axi-host','t3code-instances','keep-ai-trailers','supervision-host-off','firstmate-role']);
for (const item of definitions) item.inherited = inherited.has(item.key);
for (const key of ['supervision-branch-model','supervision-branch-effort','codex-permission-mode','voice-region','voice-model','voice-id','voice-read-scope','inbox-region','inbox-stt-model','inbox-ask-model']) {
  const item = definitions.find(x => x.key === key); item.private = false; item.readOnly = '此项通过对应原生入口配置，本页显示保存值。';
}
for (const key of ['auto-land','keep-ai-trailers']) Object.assign(definitions.find(x => x.key === key), { flag: true, presentLabel: '已启用', defaultLabel: '关闭', fallback: '未配置时关闭。' });
for (const key of ['claude-permission-mode','codex-approval-mode','codex-permission-mode']) Object.assign(definitions.find(x => x.key === key), { defaultLabel: 'bypass（原生默认）', fallback: '缺文件时 Firstmate 原生启动默认跳过权限询问；受 Harness 策略及具体启动参数约束。不代表运行中会话的有效权限。' });
const harnessScopes = {
  'calm': ['claude', 'pi', 'pi-signed'],
  'crew-exclude-tools': ['claude', 'pi', 'pi-signed'],
  'claude-account': ['claude'],
  'claude-accounts': ['claude'],
  'claude-permission-mode': ['claude'],
  'codex-approval-mode': ['codex'],
  'codex-permission-mode': ['codex'],
  'codex-stop-park': ['codex'],
  'pi-account': ['pi', 'pi-signed'],
  'supervision-branch-model': ['pi', 'pi-signed'],
  'supervision-branch-effort': ['pi', 'pi-signed'],
  'read-repetition.json': ['pi', 'pi-signed'],
  'warm-compact': ['claude'],
  'stow-guard': ['claude'],
  'usage-warner': ['claude'],
  'supervision-host': ['claude', 'codex', 'cursor', 'opencode', 'omp', 'grok'],
};
const backendScopes = { 'herdr-presentation-spaces': 'Herdr', 'herdr-project-groups': 'Herdr', 'herdr-lifecycle-spawn-guard': 'Herdr', 'rex-status-marks': 'Rex', 'rex-tint': 'Rex', 'launch-env-tmux-session': 'Orca', 't3code-instances': 'T3 Code', 't3code-token': 'T3 Code', 'cmux-socket-password': 'cmux' };
for (const item of definitions) {
  item.harnesses = harnessScopes[item.key] || [];
  item.harnessLabel = item.key === 'supervision-host' ? '非 Pi 主控' : [...new Set(item.harnesses.map(h => h === 'claude' ? 'Claude Code' : h.startsWith('pi') ? 'Pi / Pi Signed' : 'Codex'))].join('、') || '通用';
  item.backendLabel = backendScopes[item.key];
}
Object.assign(definitions.find(x => x.key === 'codex-stop-park'), { presentLabel: '开关已设置 · 待核验', requirements: '需受支持版本的原生交互 Codex 会话持有 Home 锁；在新会话启动时选择模式。版本要求由 fm-codex-stop-park.sh 核验，文件存在不等于已生效。' });
export const groups = [
  { key: '运行', name: '运行与环境', hint: '船员后续启动使用的环境、终端与容量。' },
  { key: '监督', name: '监督与等待', hint: '本 Home 的监督、暂停和防卡死策略。' },
  { key: '记忆', name: '记忆与上下文', hint: '启动记忆、整理提醒和温热压缩。' },
  { key: '交付', name: '交付与记录', hint: 'PR 观察、等待审查及任务记录。' },
  { key: '权限', name: '账号与权限', hint: '账号、审批和发布身份；不读取凭据。' },
  { key: '集成', name: '集成与更新', hint: '工具、服务和独立通道；不在此执行安装。' },
];
