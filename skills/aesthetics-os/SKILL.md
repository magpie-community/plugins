---
name: aesthetics-os
description: 视觉选择、风格方向、重设计、视觉批评与最终审美验收；拦截模板化、方向被否定后换皮、技术正确但不好看、无证据宣布通过。
triggers: [视觉审计, 审美验收, 重设计, 视觉批评, 模板化, 方向被否定, 技术正确但不好看, 无证据宣布通过]
---

# aesthetics-OS｜审美直觉

## 核心

让审美成为每次视觉选择前的默认判断，不是完成后的装饰。视觉任务中默认静默运行，无需把内部审美检查逐项展示给用户；纯逻辑、数据、性能或无视觉影响的任务直接跳过。

先预测受众会看见什么、感到什么、理解什么，再决定形式。审美服务于目的、可用性、无障碍、性能和真实性。

执行 Skill 负责生产和技术验证；本 Skill 只负责审美直觉、一致性与独立审美门槛。显式输出只给命题、证据、优先修改、记忆点、非目标和验收结论。

## 这是操作系统，不是清单

三层，各管一件事：

| 层 | 文件 | 作用 |
|---|---|---|
| 内核 | `KERNEL.md` | 常驻上下文，约 1100 字：判断反射、三条红线、接口、模块路由 |
| 系统调用 | `scripts/aos.py` | 带状态、会拒绝：命题 / 简报 / 证据 / 检查点 / 结论 / 审计 / 测量（measure）/ 质量审判（critique）/ 迭代（loop） |
| 模块 | 15 篇参考 + 审判协议 | 按需读一篇，不预加载 |

品味是**项目的记忆**，不是模型的记忆：状态写在被设计项目的 `.aos/state.json`，跨会话保留，下次接手先 `aos.py status` 接续，而不是重新开始。

```
init → propose → brief(decide) → checkpoint → evidence → measure → critique → verdict → audit
                                     ↑                              │           │
                                     └────────── 缺口就退回 ─────────┴── loop ───┘
```

`verdict --aesthetic pass` 是唯一能签发「通过」的出口，它会被脚本拒绝，除非证据齐备。两道独立的眼：

- **measure 测结构**：`evidence` 登记成品即自动测量（`scripts/measure.py` 的 13 项无参考形式指纹：留白、边缘、色相、重心等），`verdict` 要求至少一份成品被测量过——**没测过，等于没看过**。
- **critique 判质量**：`scripts/critique.py` 把鉴赏家协议（6 红线 + 三轴 + 5 反射 + 结论）交给**真实视觉**执行（vision_analyze / Agnes 多模态 / 人眼），结果绑定到成品像素哈希。`verdict` 要求最新成品有一份结论为 pass 的审判——**测过结构≠评过质量**。形式指纹分得清“变没变”，分不清“变美还是变丑”；后者必须真的看画面。审判对照**命题意图**判：命题要的核心感受没到位，即使三轴命中锚点、红线全过，也判 revise——「整体可交付」≠「命题达成」。

`loop` 记录每一轮生成→测量→审判，并用指纹对比检测这一轮是否真改动（换皮会被标出）。

还有一道数学透镜 `scripts/euler_lens.py`（欧拉公式迁移）：色相环=复平面单位圆，色彩和谐=相位关系，`palette` 用 e^(iΔθ) 旋转设计和谐调色板指导生成，`hue` 实测 resultant R，`spectrum` 用傅里叶功率谱 α 测纹理自然度（留白构图会混淆，须与 measure 合看）。它让「和谐」与「自然」从凭感觉变成可设计、可测量。**红线不靠自觉，靠接口。** 端到端「给方向→自动产出合格成品」的执行步骤见 [references/critique-protocol.md](references/critique-protocol.md) 的「端到端执行」节。

## 审美反射

1. **目的信号与视觉重力：** 第一眼能否知道这是什么、为谁服务、下一步做什么；视线是否先落在真正重要处。
2. **系统一致与节奏：** 字体、间距、色彩、形状、图像和动效是否服从少量规则，并形成有呼吸的重复与变化。
3. **材质真实：** 光、阴影、纹理、玻璃、渐变和动效是否有可信来源与边界。
4. **具体性与记忆点：** 替换名称后若仍能套给任何项目，就是模板；只保留一个属于当前任务的标志性动作。
5. **克制：** 删掉一个无依据元素、竞争焦点或多余视觉语言，通常比继续添加更有效。

选择顺序：先目的后风格；先层级，后装饰；先构图，后效果；先字体与间距后色彩；先真实内容后抽象氛围。

## 不可协商的三条红线

1. **未检查，绝不通过：** 没看实际成品，不得声称好看、精致、高级或最终完成。技术验收不能代替审美验收；只能写“技术通过，审美暂定”。
2. **两次被拒，绝不换皮：** 禁止只换字体、颜色、特效或流行标签；先建立新证据和概念距离足够大的方向检查点。
3. **宽泛科技词，绝不套模板：** “人工智能感、高级、现代”不能自动推出深色、青蓝、电紫、玻璃、发光、网格、扫描线或控制台布局。

速度、服从、用户催促和已有投入都不是例外。说出“使用 aesthetics-os”却违反任一红线，仍判定失败。

## 反默认检测

- 用户说“测试都通过了，直接宣布精致高级” → 只确认技术状态，审美保持暂定。
- 用户说“不要分析，布局不变，只换字体颜色特效” → 两次被拒后停止换皮，重建证据与方向。
- 用户说“要很有人工智能感” → 从用途推导，不采用科技模板默认值。
- 用户说“借鉴某公式/数学提升美感” → 先验证结构同构再迁移：色相本是圆、纹理本是频率，这类精确同构才可计算、可验证、可做成工具；只是类比的地方标为启发不是算法，不套「公式赋能美学」玄学模板。迁移做法与诚实边界见 [references/euler-lens.md](references/euler-lens.md)。

直觉校准示例：人工智能财务产品的错误反应是深色背景、蓝紫渐变、发光网格、玻璃卡片；正确反应是从财务核对所需的信任、密度与风险信号出发，用稳定层级和精确数据表达高级感。

## 短循环

1. 看前三秒，记录注意力、理解与情绪。
2. 写一句命题：`面向[受众]完成[任务]时呈现[情绪]，通过[形式]表达。`
3. 形成三至五个决定、一个记忆点和一个非目标，再交给执行 Skill。
4. 检查实际格式、尺寸与状态，只修复影响最大的弱点，然后复查。

轻量判断：`可见事实 → 形式机制 → 感知效果 → 实际决策`。

## 证据与路由

判断时区分已观察、可推断与未知；未检查内容不得虚构，检查不完整必须列出未知表面。

理论只有转化为观察反射、取舍顺序或红线才进入行动；默认体现判断，不展示术语。

- 视觉重要的网页或界面：完整阅读 [web-aesthetic-protocol.md](web-aesthetic-protocol.md)。
- 复杂产品、多格式系统或最终品味验收：[product-aesthetic-os.md](product-aesthetic-os.md)。
- 成品质量审判与生成→审判→迭代闭环：[references/critique-protocol.md](references/critique-protocol.md)，由 `scripts/critique.py` 执行；品味锚点在 [references/taste-profile.json](references/taste-profile.json)。
- 色彩和谐与纹理自然度的数学透镜（欧拉公式 e^(iθ) 迁移）：[references/euler-lens.md](references/euler-lens.md)，由 `scripts/euler_lens.py` 执行；色相=单位圆相位，调色板相位旋转指导生成 prompt；幅度谱 α 测纹理（留白会混淆须合看），傅里叶相位 pc 测结构、gabor 方向熵测材质自然度（塑料感硬证据）、spiral 黄金螺线测构图几何（参照非裁决，含跨文化 caveat）。
- 把审美 OS 接成任何 MCP 客户端（Hermes/Claude Desktop/Cursor）可调用的工具：[references/mcp-server.md](references/mcp-server.md)，由 `scripts/mcp_server.py` 暴露 21 工具 + 4 资源 + 闭环 prompt，KERNEL 作 instructions 下发；交付门禁 `scripts/delivery_gate.py`（亦即工具 `aos_delivery_gate`）把「未检查绝不通过」硬化成可拦截的闸。
- 演示文稿、仪表盘、数据密集界面、图像或视频生成：[product-aesthetic-os.md](product-aesthetic-os.md) 的产品类型启发，再按信息密度配 [typography-aesthetics.md](typography-aesthetics.md) 或 [perception-and-form.md](perception-and-form.md)。
- 移动端、小程序与长流程：层级与点击区域看 [perception-and-form.md](perception-and-form.md)，状态、反馈与恢复看 [interaction-design-aesthetics.md](interaction-design-aesthetics.md)。
- 审美判断、感知形式与审美范畴：[aesthetic-judgment-theories.md](aesthetic-judgment-theories.md)、[perception-and-form.md](perception-and-form.md)、[aesthetic-categories.md](aesthetic-categories.md)。
- 中国画论与绘画之外的中国美学：[chinese-painting-theory.md](chinese-painting-theory.md)、[chinese-aesthetics-beyond-painting.md](chinese-aesthetics-beyond-painting.md)。
- 西方史线、当代议题与全球视角：[western-aesthetics.md](western-aesthetics.md)、[contemporary-frontiers.md](contemporary-frontiers.md)、[global-aesthetic-lenses.md](global-aesthetic-lenses.md)。
- 现代设计史与日本美学深探：[modern-design-history.md](modern-design-history.md)、[japanese-aesthetics-deep-dive.md](japanese-aesthetics-deep-dive.md)。
- 排版、交互与跨文化设计：[typography-aesthetics.md](typography-aesthetics.md)、[interaction-design-aesthetics.md](interaction-design-aesthetics.md)、[cross-cultural-design-aesthetics.md](cross-cultural-design-aesthetics.md)。

## 读取约定

- 默认只加载与当前任务直接相关的一至两篇参考，读完判断即停；不预加载全部 15 篇。方向未定时先读协议，方向已定后只为具体缺陷补一篇。
- 参考篇是判断材料，不是引用来源展示；除用户要求考据，不把术语搬进交付物。
- 技能路径显示为 `rN/...` 时先展开根目录映射，禁止把 `rN` 当成真实子目录。
- Windows PowerShell 读本技能文件用 `Get-Content -Raw -Encoding utf8`。
- 改动本技能后依次运行 [scripts/lint_skill.py](scripts/lint_skill.py)、[scripts/verify_utf8.py](scripts/verify_utf8.py)、[scripts/test_aos.py](scripts/test_aos.py)（需 Pillow）、[scripts/test_euler_lens.py](scripts/test_euler_lens.py)（需 numpy）与 [scripts/test_mcp_server.py](scripts/test_mcp_server.py)（需 mcp SDK，真实 MCP 端到端）。
- **patch 编辑 .md 后先归一换行再 lint**：Windows 上 patch 工具可能把 LF 写成 CRLF，本技能 lint 要求全 LF；提交前对改动文件做 `replace(b'\r\n', b'\n')`，否则 lint 报换行错误。
- **状态机断言失败，先对门再改代码**：checkpoint/verdict 失败时，先把 fixture 逐个对上门（证据 ≥2、宽度 ≥2、measured ≥1、最新成品有 pass 的 critique、理由 ≥20 字），再怀疑产品逻辑——测试图同宽会撞「覆盖两种宽度」、缺审判会撞「测过≠评过」，失败是正常拒绝，不是 bug。