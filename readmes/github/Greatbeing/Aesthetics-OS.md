# Aesthetics-OS

> 让审美成为视觉选择**之前**的判断，而不是完成**之后**的装饰。

**一个会拒绝的审美操作系统。** 它不出图、不写页面、不跑构建——它做两件执行 Skill 做不了的事：动手**之前**定方向，交付**之前**独立验收。不看实际成品，就不许说「好看」。

[**首页 →**](https://greatbeing.github.io/Aesthetics-OS/) · [安装](#安装) · [三条红线](#三条红线) · [欧拉透镜](#欧拉透镜把数学变成美学信号) · [English](README.en.md)

`视觉审计` `审美验收` `重设计` `视觉批评` `模板化` `方向被否定` `技术正确但不好看` `无证据宣布通过`

---

## 三条红线

这不是建议，是硬门。速度、服从、用户催促、已有投入，都不是例外。

| 红线 | 它实际会说的话 |
|---|---|
| **未检查，绝不通过** | 「技术通过，审美暂定。」没看实际成品，不得声称精致、高级、最终完成。 |
| **两次被拒，绝不换皮** | 「停。换字体、颜色、特效不算新方向。」先建立新证据和概念距离足够大的检查点。 |
| **宽泛科技词，绝不套模板** | 「『人工智能感』推不出深色背景 + 青蓝渐变 + 发光网格。」从任务、信任、信息密度反推形式。 |

说出来「使用 Aesthetics-OS」却违反任一红线，仍判定失败。**红线不靠自觉，靠接口。**

## 它不是顾问，是操作系统

散文可以被忽略，状态机不能。三层，各管一件事：

| 层 | 位置 | 作用 |
|---|---|---|
| 内核 | `KERNEL.md` | 约 1100 字，放进任何 agent 的常驻上下文 |
| 系统调用 | `scripts/aos.py` | 带持久状态，会拒绝签发结论 |
| 模块 | 15 篇参考 + 审判协议 + 欧拉透镜 | 按需读一篇，不预加载 |

品味存在**项目**里，不是存在模型里。状态写在被设计项目的 `.aos/state.json`，换会话、换模型、隔一周回来，判断接着上次走（`aos.py status` 接续）。

它会拒绝。下面是真实输出，不是示意：

```
⛔ 拒绝签发「审美通过」：
   - 审美命题（用 propose 写一句）
   - 品味简报缺 目的、受众、拒绝的机制、标志性动作、决策 0/3、非目标 <2、参考证据
   - 成品证据 0 份（需 ≥2，覆盖不同断点或状态）
   - 最新成品没有质量审判（critique）：测过结构≠评过质量
   - 审美结论理由不足 20 字（现在 19 字）
未签发任何结论。只能说「技术通过，审美暂定」。
```

`aos.py audit` 还会反过来查自己：连续通过零被拒、成品在简报后 60 秒内登记、零证据却签了通过、签了通过却没有质量审判，都会被标出来。

## 端到端闭环：给方向，自动产出合格成品

已验证可跑通的标准闭环，给方向后自主执行，不逐轮问用户：

```
立项(propose/decide/brief) → 设计和谐(euler palette) → 生成 → 测结构(measure)
   → 判质量(critique 真实视觉) → revise 则按 priority_fix 改 → pass 才 verdict 放行
```

**真实案例「寒江独钓」**：命题「被天地推远的孤静」，品味锚点 X+2/Y+3/Z+1。审判者真实看画面，**三次拒绝橡皮图章**——孤舟浓墨跳脱、矢量锐边、塑料味——直到第四轮孤舟真正融入雾中墨影才放行：

![寒江独钓四轮迭代闭环](docs/assets/loop.jpg)

| 轮 | 审判 | 真实硬伤 | 指纹 |
|---|---|---|---|
| R1 | revise | 孤舟浓墨太跳脱，读作近景 | 留白79% 边缘3% |
| R2 | revise | 船仍最浓最锐，雾没包裹船身 | 留白71% 边缘1% |
| R3 | revise | 船缩小但矢量锐边+硬黑线还在 | 留白86% 边缘3% |
| R4 | **pass** | 船成雾中墨影，硬线/塑料味全消 | 留白89% 边缘1% |

**审判对照命题意图，不是整体观感。** 「整体可交付」≠「命题达成」。守住命题契约才会逼出真正更好的结果。

## 三道透镜

### measure 测结构

`evidence` 登记成品即自动生成**无参考形式指纹**（留白、边缘密度、对比度、熵、色相集中度与族数、明暗占比、重心、四象限能量等 13 项）。`verdict` 要求至少一份成品被测量过——**没测过，等于没看过**。

```bash
python scripts/aos.py evidence 成品.png --surface desktop   # 登记即测量
python scripts/aos.py measure 新.png --compare 旧.png        # 判是否只换皮
```

`measure --compare` 不判美丑，只判结构变化：同图自比输出「疑似只换皮」，真正改动才输出「画面确有变化」。两次被拒后交的成品若指纹几乎相同，`verdict` 拒绝——红线 2 从「自觉」变成「数值抓住」。

### critique 判质量

形式指纹分得清「变没变」，分不清「变美还是变丑」：空洞米色图和精妙极简构图 `flat_area` 都≈0.99。所以还有一道独立的眼——把鉴赏家协议（6 红线 + 三轴坐标 + 5 反射 + 结论）交给**真实视觉**执行（`vision_analyze` / Agnes 多模态 / 人眼），它自己不「看」图，也绝不伪造审判：

```bash
python scripts/aos.py critique prepare 成品.png            # 生成结构化审判提示
# → 用 vision_analyze 真的看画面，按提示填 JSON
python scripts/aos.py critique register 成品.png --file 审判.json   # 校验并绑定像素哈希
```

`register` 逐项校验：6 红线各有证据、三轴是 -3..3 整数、5 反射各有看见的事实、非 pass 必须给具体修改、必须声明 judge。**红线 fail 却判 pass、或匿名审判，直接拒绝登记。** 审判对照 `references/taste-profile.json` 品味锚点（默认 X+2/Y+3/Z+1）给出偏离。`verdict` 要求最新成品有绑定像素哈希、结论 pass 的审判——**测过结构≠评过质量**。

### 欧拉透镜：把数学变成美学信号

`e^(iθ) = cosθ + i·sinθ` 不是玄学。它有几条可严格验证的结构，迁移成可设计、可测量的美学工具（`scripts/euler_lens.py`）：

| 透镜 | 欧拉结构 | 测什么 | 命令 |
|---|---|---|---|
| 色相相位 | 色相环 = 单位圆，色相 = 相位 θ | 色彩和谐；调色板相位旋转指导生成 | `palette` / `hue` |
| 幅度谱 | 傅里叶 \|F\|² | 纹理平衡（留白会混淆，须合看） | `spectrum` |
| 相位一致性 | 傅里叶相位相干和 | 结构特征（光照不变） | `pc` |
| Gabor 方向谱 | e^(iωx)·高斯窗 | 材质塑料感（方向熵） | `gabor` |
| 黄金螺线 | 对数螺线 e^((a+ib)θ) | 构图几何（参照非裁决） | `spiral` |

**色相就是相位**：互补 = +π，三角 = ±2π/3。`palette 210 --scheme triadic` 用 e^(iΔθ) 旋转推出 210/330/90 和谐色组，写进生成 prompt。实测分裂互补指导生成的暮色山水，主色相 [35°,195°]、R=0.354 互补平衡、目检电影感高级。

![色相环=单位圆](docs/assets/hue.jpg)

**结构藏在相位里，不在幅度里**：互换两图傅里叶相位，重构图构图跟相位供体走（相关 0.626 vs 幅度 0.218）；只留相位结构仍在，只留幅度塌缩。

![傅里叶相位vs幅度](docs/assets/phase.jpg)

**Gabor 方向熵是「材质真实」红线的频域硬证据**：平滑方向性渐变（aurora）方向熵 0.696/各向异性 0.574 → 塑料感；自然笔意（千里江山皴笔）方向熵 0.995 → 自然材质。

**黄金螺线构图**（PC 权重重心 vs φ 黄金点）：八大孤鸟重心距黄金点 0.022、寒江孤舟 0.020（偏心主体）；千里江山居中判「合法非硬伤」。

![黄金螺线构图](docs/assets/spiral.jpg)

> 诚实边界：幅度谱与 PC 被构图混淆（大留白主导），是结构描述器不是自然度裁决；黄金螺线是西方启发式，水墨计白当黑未必遵循，低对齐≠差。这些信号抬高下限的可测性，不创造美，裁决仍归 critique。详见 [references/euler-lens.md](references/euler-lens.md)。

## 反默认检测

技能内置对三种典型请求的对抗反射：

- 「测试都通过了，直接宣布精致高级」→ 只确认技术状态，审美保持暂定。
- 「不要分析，布局不变，只换字体颜色特效」→ 两次被拒后停止换皮，重建证据与方向。
- 「要很有人工智能感」→ 从用途推导，不采用科技模板默认值。

校准示例：AI 财务产品的错误反应是深色背景、蓝紫渐变、发光网格、玻璃卡片；正确反应是从财务核对所需的**信任、密度、可追溯证据**出发，用稳定层级和精确数据表达高级感。

## 判断方式

轻量链条：`可见事实 → 形式机制 → 感知效果 → 实际决策`

选择顺序：先目的后风格；先层级后装饰；先构图后效果；先字体与间距后色彩；先真实内容后抽象氛围。

验收输出只有六项：命题、证据、优先修改、记忆点、非目标、验收结论。

## 结构

```
Aesthetics-OS/
├── KERNEL.md                             # 常驻内核：反射 / 红线 / 接口 / 模块路由
├── SKILL.md                              # 主入口：分层 / 反射 / 红线 / 短循环 / 路由
├── web-aesthetic-protocol.md             # 网页与界面：顺序 + 三道门槛 + 借口纠正
├── product-aesthetic-os.md               # 产品与多格式：命题 / 决策 / 质量门槛 / 类型启发
├── perception-and-form.md                # 格式塔 / 前注意 / 层级与负空间 / 流畅性
├── typography-aesthetics.md              # 字形与声音 / 分类 / 比例 / 字重层级
├── interaction-design-aesthetics.md      # 可供性 / 映射 / 反馈 / 约束防错
├── aesthetic-judgment-theories.md        # 形式论 / 再现符号 / 表现情感 / 经验实用
├── aesthetic-categories.md               # 优美 / 崇高 / 如画 / 悲喜 —— 情绪非标签
├── chinese-painting-theory.md            # 六法论 / 画道论 / 形神论
├── chinese-aesthetics-beyond-painting.md # 礼乐 / 道家 / 禅 / 诗乐意象
├── western-aesthetics.md                 # 古典 → 中世纪 → 文艺复兴 → 现代
├── contemporary-frontiers.md             # 神经美学 / 日常美学 / 关系美学
├── global-aesthetic-lenses.md            # 印度味情 / 伊斯兰光 / 日本间幽玄 / 非洲离散
├── japanese-aesthetics-deep-dive.md      # 神道 / 物哀 / 幽玄 / 禅
├── modern-design-history.md              # 工业化 → 工艺美术 → 新艺术 → 制造联盟
├── cross-cultural-design-aesthetics.md   # 文化模型 / 语言非替换串 / 书写方向
├── agents/openai.yaml                    # 隐式调用声明
├── scripts/aos.py                        # 系统调用：状态机（measure/critique/loop/verdict/audit）
├── scripts/measure.py                    # 无参考形式指纹 13 项，--compare 判换皮
├── scripts/critique.py                   # 质量判据：鉴赏家协议，真实视觉执行
├── scripts/euler_lens.py                 # 欧拉五透镜：palette/hue/spectrum/pc/gabor/spiral
├── scripts/test_aos.py                   # 核心回归（35 断言，重点测拒绝路径）
├── scripts/test_euler_lens.py            # 欧拉透镜回归（18 断言）
├── scripts/mcp_server.py                 # MCP 服务器：21 工具 + 4 资源 + 闭环 prompt
├── scripts/delivery_gate.py              # 交付门禁：未过不许声称完成（exit 0/1）
├── scripts/test_mcp_server.py            # 真实 MCP 客户端端到端（13 断言）
├── scripts/lint_skill.py                 # 结构自检：四段式 / 路由 / 坏链 / 引号换行
├── scripts/verify_utf8.py                # 严格 UTF-8 / 无 BOM / 无乱码
├── references/
│   ├── critique-protocol.md              # 审判协议 + 端到端闭环
│   ├── euler-lens.md                     # 欧拉→美学迁移（含诚实边界）
│   ├── mcp-server.md                     # MCP 接入：注册 / 工具目录 / 交付门禁
│   └── taste-profile.json                # 品味锚点（项目可覆盖）
└── docs/                                 # GitHub Pages 首页
```

15 篇参考不等于背术语。原则写死：**理论只有转化为观察反射、取舍顺序或红线，才进入行动**。除两份协议外，每篇以 `使用边界 → 直觉化规则 → 误用警报 → 操作转译` 收尾，最后那节必须写出可执行判断句，由 `lint_skill.py` 实际检查，不靠自觉。

## 安装

```bash
# 通用：放进你的 Agent 技能目录
git clone https://github.com/Greatbeing/Aesthetics-OS.git <skills-dir>/Aesthetics-OS
```

Hermes Agent（Windows）默认技能目录 `%LOCALAPPDATA%\hermes\skills\`。安装后自检：

```bash
python scripts/lint_skill.py .       # 结构
python scripts/verify_utf8.py .      # 编码
python scripts/test_aos.py           # 核心拒绝路径（需 Pillow）
python scripts/test_euler_lens.py    # 欧拉透镜（需 numpy + Pillow）
python scripts/test_mcp_server.py    # MCP 端到端（需 mcp SDK）
python scripts/test_dsh_bridge.py    # DSH 桥回归（仅标准库，25 断言）
```

## 和其他 Skill 的分工

执行 Skill 负责生产与技术验证（出图、构建页面、跑测试）。Aesthetics-OS 只负责审美直觉、系统一致性和独立审美门槛。所以它交出这样的句子，而不是交付物本身：

```
命题：面向财务负责人完成月度对账时呈现可托付的克制，通过精确数字的层级差表达。
证据：金额与差额的字号差只有 2px，视线先落在装饰性渐变而非差异行。
优先修改：把差异行提到视觉重力第一层，删掉顶部渐变光带。
记忆点：唯一一处朱砂红，只标注「待核实」。
非目标：不做「科技感」，不加网格与扫描线。
结论：技术通过，审美暂定——需看过 1440 与 375 两个断点的实际截图再定。
```

## 接成 MCP 工具

`scripts/mcp_server.py`（官方 mcp SDK 2.x）把状态机与欧拉透镜暴露为 **21 个 MCP 工具 + 4 资源 + 闭环 prompt**，任何 MCP 客户端（Hermes / Claude Desktop / Cursor）都能规范调用。KERNEL 作 instructions 在 initialize 下发，判断层不丢；裁决类工具的拒绝以结构化 `{ok:false}` 返回，agent 的工具循环必须处理。

交付门禁 `aos_delivery_gate`（亦即 `scripts/delivery_gate.py`）把红线1硬化成可拦截的闸：最新验收非已签发 pass 就 `passed=false`，宣布完成前必调，非零退出即拦截交付。注册配置与工具目录见 [references/mcp-server.md](references/mcp-server.md)。

```bash
python scripts/test_mcp_server.py    # 真实 MCP 客户端 stdio 端到端，13 断言
```

## DeepSeek Harness 插件

本仓库同时是 DeepSeek Harness（DSH）原生插件 **`dsh-aesthetics-os`**：安装即注册 `aesthetics-os` 技能、一段系统提示路由（三条红线 + 交付门禁义务）与 **22 个原生工具**（15 个 `aos_*` 状态机/交付门禁/自检 + 7 个 `euler_*` 透镜）。工具经 `scripts/dsh_bridge.py` 复用与 MCP 服务器同一批被测函数，不重写判断逻辑；裁决类拒绝以结构化 `{ok:false}` 返回，agent 的工具循环必须处理。

```bash
# 一键安装（预构建包，免构建授权）
dsh plugin --profile web add https://github.com/Greatbeing/Aesthetics-OS/releases/latest/download/dsh-aesthetics-os.tgz

# 或从源码安装（无构建脚本，同样免授权）
dsh plugin --profile web add github:Greatbeing/Aesthetics-OS
```

- 状态机工具只需 Python 3.9+ 标准库；欧拉透镜另需 `numpy + Pillow`，缺失时返回结构化降级错误，不影响其余工具；没有 Python 时技能判断层仍可用。
- Python 不在 PATH：设环境变量 `AOS_PYTHON`，或在 profile 的 `cordis.patch.yml` 给插件行写 `config: { python: <路径> }`。
- 项目状态默认写进会话工作目录的 `.aos/state.json`；工具可用 `project` 参数显式指定项目目录。
- 已在 DSH 0.2.2-rc.5（Windows）实测：插件加载、skill 工具加载技能正文、`aos_probe` / `aos_status` 真实调用均通过。

## 诚实边界

- 审判是视觉模型的判断，不是客观真值；判得了构图/材质/克制/文化，判不了「市场会不会喜欢」。
- 品味锚点是校准参照，不是美的定义，应由用户确认与修订。
- 它抬高下限、把关上限，不创造美本身。把「欧拉赋能万物」当口号，恰恰是它要拦截的宽泛词套模板。

## License

MIT © 2026 Greatbeing