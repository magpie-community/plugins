# Busy Bird

**鸟儿飞来飞去的 magpie 桌面挂件**

**A tiny transparent perch where a bird carries every magpie request.**

一张透明、无边框、可点击穿透的桌面小卡片，栖息着一只小喜鹊：magpie 里每出现一个请求，就有一只戴着该 Agent 颜色的鸟儿从左侧 Agent 出发，穿过中间的 magpie 栖木，飞到右边的账号上等待回答，再把结果带回 Agent。空闲时，栖木上的喜鹊会蹦一蹦、抖抖翅膀。

**做它的理由很简单**：不想为了看一眼 magpie 在干什么就切窗口。挂着这张卡片，鸟在飞就说明有请求在跑，鸟停在栖木上就说明一切安静。

<p align="center">
  <img src="./docs/screenshots/card.png" alt="桌面卡片：一只鸟正穿过 magpie 栖木" width="330">
  <img src="./docs/screenshots/stats.png" alt="用量统计面板" width="300">
</p>
<p align="center">
  <img src="./docs/screenshots/island.png" alt="灵动岛模式：吸附在屏幕顶部的一条胶囊" width="300">
</p>

[![platform](https://img.shields.io/badge/platform-Windows%2010%2F11-4b465c?style=flat-square)](#)
[![electron](https://img.shields.io/badge/electron-39-8f7cff?style=flat-square)](https://www.electronjs.org/)
[![license](https://img.shields.io/badge/license-MIT-61d7e7?style=flat-square)](./LICENSE)

## 它从哪来

这是 [yimi1mi/busy-magpie](https://github.com/yimi1mi/busy-magpie) 的缩小致敬版：飞的还是那只喜鹊（同一套 SVG 与飞行曲线，MIT 授权），但卡片从 632×432 缩到 300×190，只留下最喜欢的那件事——**鸟儿飞来飞去**。

- **一只请求一只鸟**：每个进行中的请求是一只 Courier，翅膀 0.42s 一拍，沿贝塞尔丝线滑行，转弯时压坡度。
- **换装**：右键卡片/灵动岛 → 换装。小鸟（扇翅飞行）、小车（沿线行驶、轮子转）、亲嘴（男孩走到右端女孩跟前亲吻再走回）、猴子（沿线走、到站摘香蕉叼回家）。普通模式与灵动岛通用。
- **一个应用自动合并**：当 Agent 与账号是同一品牌（如 DeepSeek Harness 走 DeepSeek 账号），只画一张芯片、一根丝线，请求穿过 magpie 原路返回。
- **灵动岛多会话手动选择**：底部胶囊分页条，点选要看的会话（不自动轮播），选中项为发光短条。
- **统计方块**：点顶栏 📊 展开——今日调用、请求总数、费用、输出速度、会话数，加近 24 小时柱状图（`bucket=hour`）。
- **穿过 magpie 有一圈涟漪**，Agent、连线、鸟、涟漪用同一个品牌色。
- **空闲的生命感**：没有请求时，栖木上的喜鹊随机蹦跳、抖翅、左右张望；断线时它会打瞌睡（变暗）。
- **顶部 token 胶囊**：读取 `/v1/magpie/usage`，单击在 今日 / 7 天 / 30 天 / 全部 之间循环。
- **透明、置顶、点击穿透**：只有顶部 26px 的拖动条和胶囊接收鼠标，其余点击落到下层窗口。

## 安装

### 下载现成的包（推荐，不需要装 Node）

[v0.1.0 Release](https://github.com/jvkal/busy-bird/releases/latest) 里有一个 `BusyBird-0.1.0-win-x64.zip`（约 120 MB，自带 Electron 运行时）：

1. 解压到 `%LOCALAPPDATA%\Programs\`，解压后应当是
   `%LOCALAPPDATA%\Programs\Busy Bird\Busy Bird.exe`
2. 双击 `Busy Bird.exe`，桌面右上角会出现挂件，托盘里多一只鸟
3. 想让它跟着 magpie 自动起来，再装下面的启动器插件

PowerShell 一条命令解压到位：

```powershell
Expand-Archive .\BusyBird-0.1.0-win-x64.zip "$env:LOCALAPPDATA\Programs" -Force
```

这个位置正好是插件默认查找的第一个正式安装路径，装完之后插件不需要任何环境变量就能把挂件拉起来。

### 作为 magpie 插件（启动器）

```bash
magpie plugin add github:jvkal/busy-bird
```

插件是启动器：magpie 第一次用到它会自动拉起桌面挂件。挂件本体需要在本地能找到，查找顺序：

1. `BUSY_BIRD_APP` 环境变量指向的可执行文件
2. `%LOCALAPPDATA%\Programs\Busy Bird\Busy Bird.exe`（安装版）
3. 插件目录内 `npm install` 过的 Electron 开发副本

### 直接运行源码

需要 Node.js 20+，以及本机正在运行的 magpie（默认 `127.0.0.1:3425`）。

```bash
npm install
npm start
```

启动后没有任务栏窗口，只有桌面卡片和托盘图标。

### 不想连真 magpie？用模拟器看效果

```bash
npm run mock            # 在 127.0.0.1:3529 模拟 trace / usage
# 另开一个终端
BUSY_BIRD_GATEWAY=http://127.0.0.1:3529 npm start
```

或者让挂件自己给自己造数据（不联网）：

```bash
npm run shot            # --demo + 截图到 docs/screenshots/bird.png
npx electron . --shot=docs\screenshots\idle.png --demo --idle   # 只看栖息状态，不发请求
```

## 交互

- **拖动 + 中心吸附**：按住卡片顶部 26px 的条拖动；靠近屏幕正中间（横向或纵向中线 20px 内）自动吸附，卡片内显示一条白色辅助线，松手即停在正中。首次启动默认就在屏幕正中间。
- **透明度**：托盘菜单 →「不透明度」，20% – 100% 六档，只调背景，文字保持清晰。
- **token 胶囊**：单击切换时间窗；悬停显示输入 / 输出 / 缓存明细。
- **托盘菜单**：显示 / 隐藏、总在最前、时间窗、退出。
- **边角自由拉伸**：抓住卡片任意一个角或左右两边拖动，整张卡片等比放大缩小（宽 150 – 1200），画面按宽度整体缩放，不会把布局挤变形。托盘菜单另有 迷你／小／中／大 四档。
- **单实例**：无论是 `启动挂件.bat`、托盘、还是 magpie 插件拉起，同一时间只会有一只鸟，重复启动会直接并入已运行的那一只。
- **位置记忆**：位置和尺寸写进 `%APPDATA%\Busy Bird\settings.json`，重启保持。

## 它是怎么工作的

```text
magpie 本机网关 (:3425)
   │  GET /v1/magpie/trace   (long poll, 增量合并)
   │  GET /v1/magpie/usage   (按时间窗)
   ▼
Electron 主进程 (src/main.js)
   │  IPC
   ▼
透明 BrowserWindow (web/)
   ├─ wires: Agent ┈┈┈ magpie ┈┈┈ 账号 的丝线
   ├─ birds: 每个请求一只 Courier（SVG + getPointAtLength 逐帧飞行）
   └─ perch: 空闲时栖息在 magpie 栖木上的喜鹊
```

- trace 的 `after=seq` 只返回变化的路由，主进程维护合并表；网关重启（pid 变化）后自动清屏重取。
- 长轮询失败按 1s / 2s / 4s / 5s 退避重试，每次重试都重新解析网关地址；左上角圆点变琥珀色。
- 渲染层没有 Node 权限；trace 与 usage 只读本机，不发送任何数据到外部。

## 项目结构

```text
plugin/launch.hooks.mjs  magpie 启动器插件（magpie.hooks 入口）
plugin/server.mjs        空 provider stub
src/main.js              窗口、托盘、长轮询、usage、拖动、保活心跳
src/preload.js           contextBridge 白名单
web/index.html           卡片结构
web/app.js               舞台渲染、飞行状态机、栖息闲置动画、胶囊
web/flight-path.mjs      贝塞尔丝线与缓动（取自 busy-magpie）
web/magpie-path.mjs      喜鹊剪影路径（取自 busy-magpie）
web/styles.css           透明卡片、扇翅、涟漪、闲置动作
tools/mock-server.mjs    本地模拟 trace / usage
assets/icon.png          托盘图标
```

## 已知限制

- 只展示本机 magpie 网关；窗口固定 260×160，不缩放。
- 主视图最多 3 条泳道，更多请求分组时共用最下面一条。
- 穿过动效只有涟漪一种（原版还有漩涡 / 溶解 / 电弧）。
- 系统开启「减少动态效果」时停止扇翅与流动虚线，但鸟仍会移动。

## 致谢

- [yimi1mi/busy-magpie](https://github.com/yimi1mi/busy-magpie)：喜鹊 SVG、飞行曲线、回放模型与整体灵感，MIT 授权。

## License

[MIT](./LICENSE)
