# magpie-catpaw

妙手（美团 CatPaw）作为 Magpie 的 provider 插件。把妙手的三段式对话（create → 落库轮询 → agent-stream → stream/connect SSE）桥接成 OpenAI 兼容的流式接口，带积分余额卡片、工具调用适配、网页/桌面两种登录与图标。

> 非官方插件，与美团无关。它读的是你自己已登录的妙手客户端的凭据，不会把凭据发到别处。

> **0.3.0 改名**：仓库与包名由 `magpie-meituan` 改为 `magpie-catpaw`，面板里仍显示「妙手 CatPaw」，内部 `provider id` 仍是 `meituan`——路由组、白名单、积分限额都不受影响。旧地址 `github:R227BOUT/magpie-meituan` 会被 GitHub 自动重定向，已装的同学不用改配置。

**0.2.0（2026-11-14）**：与社区官方 `@magpie-community/opencode-catpaw-auth` 对齐了能力（网页登录 poll-token、工具调用 JSON 协议适配、余额窗口 `resetsAt`、402 余额不足、图片明确拒绝），但**保留自研的三段式会话协议与 `meituan` 这个 provider id**——现有路由组、白名单和积分限额都不用改。图标也已通过 PR 贡献给官方。

## 安装

```sh
magpie plugin add github:R227BOUT/magpie-catpaw
```

或者把仓库克隆到本地后 `magpie plugin add <本地目录>`。

## 登录方式

装好之后，magpie 里点「登录」，会给三个选择。

### 方式一：网页登录（不用装桌面客户端）

选它会在浏览器打开妙手官方授权页。登录完成后，插件按官方客户端同款 **poll-token 通道**每秒问一次 `?sid`，服务端对服务端直接取回 token：不监听本地端口、不受浏览器私有网络检查（PNA）影响，也不需要你复制粘贴任何东西。取到 token 后再问一次 `current-user` 补昵称和 uid（这一步失败不影响登录）。

妙手没有续期接口：token 过期后重新发起一次网页登录即可。

### 方式二：复用桌面端登录态（推荐，一键）

只要本机装过妙手、并且登录过，选这个就行。插件会自己去读妙手存的登录信息，**只读，不改任何东西**。妙手里重新登录后，插件会自动跟上，不用再管。

装在哪都能找到：它先看 `MEITUAN_AUTH_PATH` / `MEITUAN_DATA_DIR` 环境变量，再看 `%APPDATA%`、`%LOCALAPPDATA%`、用户主目录，最后每个盘符下面一层（包括 `Program Files`）都扫一遍。

> 用这个就不用看下面的步骤了。

### 方式三：手动粘贴 Token

什么时候用：妙手没装、或者想用另一个账号、或者前两种莫名其妙没成功。

**难点不在粘贴，在「那串东西在哪」。下面是逐步说明，照做就行。**

**第 1 步**　在 magpie 里选这个登录方式时，提示文字的第一行**已经写好了你这台电脑上那个文件的实际位置**，形如：

```
第 1 步：按 Win + R，输入 notepad "<你电脑上的路径>\auth.json"，回车。
```

把提示里 `notepad` 那**整行**复制出来，粘到 `Win + R` 的框里，回车。

> 路径每个人不一样：妙手装在哪个盘、哪个目录，插件就报哪个，不用你自己找。
> 它只是**打开**一个文本文件给你看，不会改到任何东西，放心。
>
> 万一这行提示说「没有在你电脑上找到妙手的登录文件」，说明本机压根没装妙手、或者装好后没登录过——那就先装妙手、登录一次，回头用「复用桌面端登录态」更省事。

**第 2 步**　记事本打开后，按 `Ctrl + F`，搜索 `accessToken`

会看到类似这样的一行：

```json
"accessToken": "很长的一串字母数字",
```

**第 3 步**　把**两个引号中间**那一整串复制下来（引号本身不要）。大概 150 个字符，从 `Ag` 开头。

**第 4 步**　回到 magpie，粘贴到输入框，确定。

> **提示「太短」怎么办**：多半是只复制了一半。回记事本，从开头一直选到结尾，重新复制一次。
>
> **提示「token 不认」怎么办**：① 也是复制不全；② 妙手里重新登录过了，旧 token 废了——回到第 1 步打开那个文件，抄新的。
>
> **别把 token 发给任何人**。它等同于你的账号密码。


## 注意

- **同一时刻只跑一路会话**：妙手对单账号同时只允许一个 agent 会话，并发是排队不是并行（`maxConcurrency: 2` 已留余量）。
- **建会话频控**：连续约 6 次 `create` 会触发 429，冷却实测约 41 秒。撞到后插件本地直接拦 45 秒，不会原地重试（原地退避只会把窗口续期）。
- **积分**：上游只给余额（`availableCredits`），体验版按套餐周期重置，没有签到端点。看板显示余额与下次重置时间；`userPlan.nextRefreshTime` 是合法的 13 位毫秒时间戳时写成窗口的 `resetsAt`，Smart 路由据此先用「积分先刷新」的账号，取不到就标 `aside` 不参与排序。干净读数不带 `signIn`，magpie 会据此撤掉之前误标的「已退出登录」。
- **余额不足**：上游给 402、返回「当前余额不足以完成本次操作」、或在助手文本里塞这句话，非流式与工具模式都会转成 402 `insufficient_credits`（markdown 链接摊开成纯文本），账号按积分休息而不是被判成渠道故障。**流式响应已经发出去，改不了 HTTP 状态码**，只能在流里补一个明确的错误帧，别把那条当成正常回答。
- **计费倍率**：模型清单带官方 `rateMultiplier`（如 `glm-5.3-flash ×0.06`、`LongCat-2.0` 限时免费），模型名旁会标注。
- **按次计费**：妙手是「次数 × 倍率」计费，不是按 token。所以下面用 token 折算的额度只是近似。
- **工具调用**：会话协议只收一段扁平文本，所以工具定义以系统指令随 prompt 一起送，模型按严格 JSON 回复，插件再解析回 OpenAI `tool_calls`。只有整条回复就是调用 JSON（裸对象或单个 fence 块）才算调用，散文里引用的示例不会误判；未声明的工具名、缺必需参数的调用会丢弃。`tool_choice=required` / 指定工具却没拿到调用时，带上一轮回复做**一次**显式重试。工具模式统一缓冲后再按 `stream` 参数输出 JSON 或合法 SSE——调用 JSON 本来就切不出有意义的增量。
- **图片**：上游 `model-types` 的 `supportImage` 说的是「桌面客户端里的模型能读图」，这套三段式会话只送文本、`create` 的 `images` 一直是空的。所以 0.2.0 起**不再声明任何模型支持图片输入**，带图请求直接 400 明确拒绝，而不是静默丢图。需要看图请换别的渠道。

## 与预算插件/看门狗的对接

妙手在预算体系里的账号键是 `meituan/<你的 uid>`，uid 就是 `logins.json` 里的 `user`（也就是 magpie 界面上这个账号显示的名字）。

给妙手设每日额度，在 magpie 的「积分限额」面板（`magpie-plugin-budget`）里展开妙手那一行、填数字即可；手写 JSON 的话是：

```json
{
  "dailyCredits": {
    "meituan": 500,
    "meituan/<你的 uid>": 200
  }
}
```

`meituan` 是渠道级（该渠道所有账号合计），`meituan/<uid>` 是账号级（优先于渠道级）。

注意妙手按次数×倍率计费，token 换算出来的额度只是近似——精确盯余额看插件自带的积分卡片。

## 与官方 catpaw 插件的关系

社区官方 [`@magpie-community/opencode-catpaw-auth`](https://github.com/magpie-community/plugins/tree/main/packages/catpaw) 用的是 `round → event → turn` 新协议，上游维护更活跃。本插件保留自研三段式协议（2026-11-14 真机实测仍可用）和 `meituan` id，作为长期可用的备选：

- 两者 provider id 不同（`meituan` / `catpaw`），配置互不覆盖；但**别让同一个妙手账号同时开着两个插件跑**——妙手单账号同一时刻只允许一路 agent 会话。
- 想切官方版：在 `plugins.json` 里给本插件那行加 `"off": true`，再按官方 README 把 `meituan/*` → `catpaw/*`、积分限额键一起迁过去，并重新登录一次。
- 本仓库继续保留、不归档。图标（自绘猫爪，非官方 logo）已通过 [PR #1129](https://github.com/magpie-community/plugins/pull/1129) 贡献给官方。
- 官方能力层的来源与许可见 `features.mjs` 头部（MIT）。

## 测试

```sh
node run-tests.mjs           # 全部 41 项：unit / features / 真机 e2e + 脱敏闸门
node run-tests.mjs --quick   # 只跑离线 27 项（unit + features）+ 脱敏闸门
```

`test/features.mjs` 用注入的假上游跑完整条三段式链路，不联网、不用真实凭据；`test/e2e.mjs` 才会真打妙手端点（一条极短消息，烧掉的积分可忽略）。

## 更新记录

### 0.2.0（2026-11-14）

- 新增网页登录（poll-token 通道），与官方同款。
- 新增工具调用 JSON 协议适配：指令注入、严格解析、强制 `tool_choice` 一次重试。
- 余额窗口改用 `resetsAt`（仅认 13 位毫秒）；干净读数不带 `signIn`；body `code 4010` / `4011` 也判登录失效。
- 余额不足统一转 402 `insufficient_credits`，不再冒充渠道故障或正常回答。
- 图片不再按 `supportImage` 声明可读，带图明确 400 拒绝。
- 离线测试新增 19 项，`run-tests.mjs` 纳入 `features` 套件；真机 e2e 14 项全绿。
- 图标贡献给官方 catpaw（PR #1129）。

### 0.1.0

三段式会话桥接、积分卡片、桌面登录态复用、手动粘贴 token、图标、预算插件对接。

## 许可

MIT
