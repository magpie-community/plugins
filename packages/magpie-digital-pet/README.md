# @magpie-community/page-digital-pet

烧 token，养电子宠物 —— 跑在 [magpie](https://github.com/yetone/magpie) 网关上的插件，带侧边栏页面。

统计**所有 magpie 记账的请求**（Claude Code、Codex、Pi、OpenCode、Gemini CLI……不管哪个 agent、是否流式），把 token 喂给当前出战宠物。失败请求不喂。

引擎来自外部依赖 [@jcendal/opencode-digital-pet](https://github.com/jcendal/digital-pet) 0.18.0（Apache-2.0，见 NOTICE），本仓库不 vendored 上游代码、不打包图鉴数据、不打包任何精灵图素材；侧边栏页面使用程序化像素兜底图。

## 界面

- **侧边栏页面**：magpie 窗口左侧导航里的「宠物」页 —— 首屏是宠物栖息地：像素宠物随状态活动，下方是五项状态条（饱食/心情/精力/清洁/亲密）与原有的进化进度条。可以给当前搭档**起名**，也可以在**图鉴与切换**里搜索 650 只宠物：已解锁的可切换展示，未解锁的灰显为「未解锁」。本轮新玩法入口都在这一页：**日常照顾**（点心/玩耍/清洁/休息/摸蛋，均有专属动画反馈）、三档**探险**（短巡逻/数据原野/深夜远征，结算得数据碎片与随机见闻）、**每日目标**（照顾 2 次、探险 1 次、自动进食 10 个请求）与**装饰收藏**（碎片解锁 8 套栖息地背景，本地成就记录）。原有的当前搭档与进化进度、喂食统计、一键孵蛋/冻结/钉 ID、喂食记录、历代列表全部保留在页面下方，每 5 秒自刷新，主题跟随 magpie 窗口（page-chat 同款带路页跳本地服务）
- **设置面板**：magpie → Settings → Plugins → Digital Pet（开关、缓存 token、补录、轮询间隔）
- **CLI**：见下

## 工作方式

```
magpie 网关 ──记账──> /v1/magpie/usage/requests
                          │  每 60s 轮询（route_id 幂等去重）
                          ▼
              本插件（magpie 的 Bun 宿主进程内）
                          │  合成 message.updated 事件
                          ▼
              digital-pet 引擎（原版）──> 用户目录存档（Windows: %APPDATA%\magpie-digital-pet\pet.db）
                          ▲
        侧边栏页面 <── 本地服务 127.0.0.1:3571（读同一库）
```

不走中间件（magpie 的中间件沙箱无 IO），不解析响应体（magpie 已经替你把每个请求的 token 数好了，流式也准）。多个宿主进程同时跑 watcher 也安全：引擎按 route_id 去重，SQLite 走 WAL；页面服务固定端口，谁先绑谁服务，端口被短命宿主占着时后来者定期重试接管。

成长阈值使用上游引擎默认值；本插件不写 `opencode-digital-pet.json`，不覆盖上游 OpenCode 插件的全局配置。

「孵新蛋」会让当前宠物退役，因此页面要求二次确认，并且同一颗新蛋 60 秒内不能连续孵化。当前伙伴必须达到 baby II 才能孵下一颗蛋；首颗蛋是 Digiegg，之后孵化池按图鉴顺序选择你还没养过的 baby 形态，不重复孵化。token 只喂给当前出战伙伴，不会平均分给历代或后备宠物。图鉴里的「切换」会展示并钉住该形态（暂停生长），管理区的「取消钉住」可随时恢复。

## 安装

```sh
magpie plugin add E:\LLM_Config\Magpie\plugins\magpie-digital-pet
```

装好即开始记账喂食，首次自动孵蛋，侧边栏「宠物」页即开即用。命令行等效操作：

```sh
cd E:\LLM_Config\Magpie\plugins\magpie-digital-pet
bun cli\pet-cli.mjs status     # 当前进度、进化百分比（与侧边栏页同源），另附四行只读养成摘要：
                               # care（四项状态）/ bond（亲密）/ fragments（数据碎片）/ expedition（进行中探险）
bun cli\pet-cli.mjs spawn     # 孵新蛋
bun cli\pet-cli.mjs events     # 最近事件
bun cli\pet-cli.mjs partners   # 养过的每一代
bun cli\pet-cli.mjs freeze     # 暂停生长（用量照记，宠物不长）
bun cli\pet-cli.mjs unfreeze
bun cli\pet-cli.mjs set 4-001  # 钉死某只（cheat，钉住时不再生长）
```

CLI 只提供只读摘要；日常照顾、探险和装饰装备等写操作请用侧边栏「宠物」页。

## 配置

| 选项 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `notifications` | `true` | 进化/孵化提示写进 magpie 插件日志 |
| `includeCacheTokens` | `false` | cache 命中是否计入。默认不计 |
| `backfill` | `false` | 补录 magpie 已记的 30 天用量（蛋立刻孵化）。改后需重载插件 |
| `pollSeconds` | `60` | 轮询间隔（15–3600s）。改后需重载插件 |
| `gatewayUrl` | `http://127.0.0.1:3425` | 网关地址 |
| `dbPath` | `%APPDATA%\magpie-digital-pet\pet.db`（Windows） | 个人存档路径；默认与插件代码目录分离，更新插件不会动存档。可显式覆盖 |
| `port` | `3571` | 侧边栏页面服务的本地端口 |

## 数据

- 数据库：Windows 默认 `%APPDATA%\magpie-digital-pet\pet.db`（SQLite，WAL，与 CLI / 页面并发安全）；其他平台为 `~/.config/magpie-digital-pet/pet.db`。首次启动会自动从旧版 `<插件目录>\data\pet.db` 迁移，旧文件保留作备份，不删除。
- 轮询游标：存档同目录 `watcher-state.json`（删掉它 + 开 `backfill` 可重算历史）

## 红线（与策划书一致）

- 不注入任何 agent 的上下文：不注册 hooks/MCP/skills，不写 agent 配置
- 不消耗 token：引擎零 LLM 调用，全部本地规则
- 不改请求：只读 magpie 的用量账本
- 侧边栏页面只绑 127.0.0.1，只服务 magpie 窗口跳来的页面
- fail-open：本插件任何异常都不影响网关

## 测试

```sh
bun tests/pet-frames.test.mjs              # 像素帧提取与加载
bun tests/pet-care-rules.test.mjs          # 照顾状态与主动操作规则
bun tests/pet-progression-rules.test.mjs   # 探险、每日目标与成就规则
bun tests/pet-care-store.test.mjs          # 养成 SQLite 存储
bun tests/pet-server-care.test.mjs         # 页面 API 与安全
bun tests/page-contract.test.mjs           # 页面结构契约
bun tests/docs-contract.test.mjs           # 文档与 CLI 摘要契约
bun tests/e2e-page.test.mjs                # 真实存档副本端到端；浏览器段见下
bun tests/selftest.mjs                     # 26 项离线自检（假网关 + 临时库 + 页面服务 + 端口接管）
```

端到端测试的核心段始终运行；真实浏览器段只有显式提供本机 Playwright Core 与浏览器路径时才运行，并在临时目录保存截图：

```sh
PET_E2E_PLAYWRIGHT="<playwright-core/index.mjs 绝对路径>" \
PET_E2E_EDGE="<msedge.exe 绝对路径>" \
PET_E2E_ARTIFACT_DIR="<截图输出目录>" \
bun tests/e2e-page.test.mjs
```

## 卸载

```sh
magpie plugin rm magpie-digital-pet
```

个人数据留在用户目录（Windows 为 `%APPDATA%\magpie-digital-pet\`），与插件代码目录分开；想全删手动删除该目录即可。旧版插件目录下的 `data\` 只保留迁移前备份。
