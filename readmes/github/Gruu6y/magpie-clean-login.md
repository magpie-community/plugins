# Magpie Clean Login · 干净登录

**简体中文** · [English](README.en.md)

[![tag](https://img.shields.io/github/v/tag/Gruu6y/magpie-clean-login?style=flat-square)](https://github.com/Gruu6y/magpie-clean-login/tags)
[![ci](https://github.com/Gruu6y/magpie-clean-login/actions/workflows/ci.yml/badge.svg)](https://github.com/Gruu6y/magpie-clean-login/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

**一句话：让你在 magpie 里登录多个账号时，每个账号看起来都是一台独立的电脑、从独立的网络出口上网。**

如果你只用一个账号，magpie 本身就够了。如果你有好几个账号——比如两个 Claude、三个 WorkBuddy——那就需要它。

![干净登录的供应商页：四个标签页、一次性的登录浏览器准备，以及可以直接开始登录的供应商卡片](assets/screenshot-providers.png)

> **这是非官方插件。** 由 [Gruu6y](https://github.com/Gruu6y/magpie-clean-login) 开发维护，**不是** magpie 官方或 `magpie-community` 发布的。代码全部公开，欢迎读、欢迎提 issue、欢迎提 PR。

<a id="contents"></a>

## 目录

- [它到底解决什么问题](#what)
- [为什么用它](#why)
- [环境要求](#requirements)
- [安装](#install)
- [快速开始](#quick-start)
- [四个标签页](#tabs)
- [功能](#features)
- [命令行与 agent](#cli)
- [排查问题](#troubleshooting)
- [隐私与数据存放位置](#privacy)
- [参与贡献](#contributing)
- [许可](#license)

<a id="what"></a>

## 它到底解决什么问题

你在 magpie 里登录一个 AI 服务，正常流程是：弹出浏览器 → 你输入账号密码 → 登录完成 → 凭据存进 magpie。

一个账号时这样没问题。**但你要登第二个账号时，麻烦来了。**

供应商（Claude、OpenAI、各家国产服务）会记录「这次登录是从哪台电脑、哪个网络来的」。它们看的不只是 IP，还有浏览器指纹——你的显卡型号、装了哪些字体、屏幕分辨率、canvas 渲染出来的细微差别。这些东西合起来，几乎等于一台电脑的身份证号。

于是：

- 你用同一个浏览器登了账号 A，再登账号 B —— 供应商看到的是**同一台电脑上的两个账号**。
- 更麻烦的是**续期**。凭据过期后自动刷新，走的还是同一套浏览器身份，等于每隔一段时间就再提醒对方一次：这两个账号是一家的。
- 一旦某个账号出问题，其他账号很容易被连坐。

**干净登录做的事很简单：把每个账号关进它自己的浏览器里。**

| | 不用干净登录 | 用干净登录 |
| --- | --- | --- |
| 浏览器身份 | 所有账号共用一套指纹 | 每个账号一套，登录后固定不变 |
| 网络出口 | 跟着系统/magpie 的全局设置 | 每个账号用你指定的那条代理 |
| 退出再登录 | 可能变成一台"新电脑" | 还是原来那台，身份保留 |
| 续期 | 同一套身份反复出现 | 各走各的身份和出口 |

<a id="why"></a>

## 为什么用它

**因为 magpie 自己不做这件事。** magpie 的维护者不愿意和供应商对着干，所以 magpie 里没有任何机制去遮掩"同一台机器登录了很多账号"。这不是 bug，是它的取舍。

干净登录补的就是这一块，具体三条：

1. **一个账号就是一台机器。** 浏览器配置、cookie、指纹从不共用。退出登录不会丢掉这个身份，下次登录还是用它——供应商看到的是一台老电脑回来了，不是一台新电脑。确实需要换一台机器时，在账号行点 **更换指纹**。
2. **你选的出口就是真正的出口。** 登录浏览器**和**插件自己发出的请求都走你选的那条代理。选"直连"就是真直连，不会悄悄退回 magpie 的全局代理。
3. **不用自己维护供应商名单。** 它直接读你已经装好的供应商插件和 magpie 市场目录。你往 magpie 里加一个供应商，这里就多一张卡片。

> **说清楚边界：** 一个账号、一个指纹、一个出口。供应商怎么用它的服务仍然由它决定——**本插件不绕过任何验证，也不替你注册账号。**

<a id="requirements"></a>

## 环境要求

| | |
| --- | --- |
| 宿主 | [magpie](https://usemagpie.ai)，带 Plugins 面板 |
| 系统 | **Windows x64** —— 随插件下载的登录浏览器是只有 Windows 版的 Camoufox 构建 |
| 运行时 | Bun **≥ 1.4.2** |
| 磁盘 | 下载约 170 MB，落盘约 616 MB，安装时需要约 1.02 GB 可用空间 —— 只需一次 |
| 网络 | 只用于你自己发起的动作：代理测速、信任分与身份检测页面、运行时下载，以及供应商自己的登录 |

其他平台暂时不支持；需要的话请提到 [issue tracker](https://github.com/Gruu6y/magpie-clean-login/issues)。

<a id="install"></a>

## 安装

1. 打开 magpie → **Plugins** → **Discover** → **Unofficial**（非官方插件）。
2. 找到 **Gruu6y** 发布的 **Clean Login**，点 **Install**。列表没同步出来就点 **Retry**——magpie 缓存的是 GitHub 告诉它的结果。
3. 从侧栏打开 **Clean Login**，你会看到上面那张图里的页面。

每个版本都在本仓库打了 tag（`v0.1.x`），[tag 列表](https://github.com/Gruu6y/magpie-clean-login/tags)就是版本历史。

<a id="quick-start"></a>

## 快速开始

下面四步走完，你就有一个干净登录的账号了。全程大约 5 分钟，其中大部分时间在等浏览器下载。

### 第 1 步：准备登录浏览器（只做一次）

打开插件后，供应商页顶部有一块 **登录浏览器设置**。点 **准备浏览器**，等它下载完。

- 下载约 **170 MB**，用固定的 sha256 摘要校验，只下一次。
- 第一张图里这块的徽标写 **未安装** —— 生成截图用的是一个空的浏览器目录，正好就是你第一次打开时看到的样子。
- 下载失败可以直接重试，不影响其他功能。

这一步装的是一个**独立的浏览器**，不是你日常用的那个。以后所有登录都在它里面进行，不会污染你平时的浏览器。

### 第 2 步：加一条代理出口

切到 **代理 IP** 标签页 → 点右上角 **添加代理** → 填名称、类型（HTTP / HTTPS / SOCKS5）、地址、端口，需要认证就填用户名密码。

加完点这一行的 **测试**。它会真的通过这条代理连出去，然后告诉你：**出口 IP 是什么、在哪个地区、延迟多少毫秒**。

![代理 IP 页：右上角选择测速目标，下面是每条出口的实测结果、地区筛选和操作按钮](assets/screenshot-proxies.png)

看上图的几个细节：

- 右上角 **测速目标** 可以选"通用（出口检测）"，也可以选某家供应商。选了供应商，测的就是**到那家 API 主机**的延迟，而不是到一个通用测试站。
- `JP 静态 01` 那行写的是 `~512 ms`，下面标着 `qoder-cn · TLS`。**波浪号是有含义的**：只完成了 TLS 握手、没拿到 HTTP 响应，所以这个数字只是握手耗时，不是真正的请求延迟。插件不会把它伪装成一个漂亮数字。
- 测试失败**不会**偷偷退回直连，而是把失败原因摆给你看。

### 第 3 步：选供应商，开始登录

回到 **供应商** 标签页，找到你要登的那家，点卡片上的 **添加账号**。

在弹出的对话框里：

1. **选一条代理**——下拉里会显示每条出口的实测延迟，并且把**这家供应商还没用过的**排在前面。
2. 如果这家要求先填个值（手机号、站点地址、密钥），对话框里会给出输入框，填好再点 **开始登录**。
3. 需要浏览器登录的，会弹出一个独立窗口。你在里面照常登录就行，完成后它自己收尾，账号随即出现在 magpie 里。想取消？直接关掉那个窗口。
4. 如果供应商发来一次性验证码，回到同一个对话框输入，点 **提交验证码**。

登录成功后会提示：**登录完成，凭据已写入 magpie。**

> 卡片上没有"添加账号"按钮？卡片上会写清原因——通常是这家还没在 magpie 里装对应插件，或者它的插件没有提供可驱动的登录方式。

### 第 4 步：确认它真的干净

切到 **账号** 标签页，你会看到刚登进去的账号、它固定的指纹、上次登录用的出口。

账号多了以后，用 **按供应商查看** 只看某一家的账号：主行是最常用的几家，其余全部收在 **更多供应商** 里，展开后可以按名称或标识搜索。它和状态筛选、搜索、排序可以叠加使用，右边的 **清除筛选** 一次全部复位。

想再确认一下，点这一行的 **检测**，再点 **开始检测**。插件会通过这个账号的出口去访问第三方站点 `who.1ms.dog`，让它给出一个 A/B/C/D 判定。

![账号页：按供应商筛选、A/B/C/D 判定图例、每个账号固定的指纹、上次登录的地区与出口](assets/screenshot-accounts.png)

- **A 干净·可以用** / **B 可用·有痕迹** / **C 建议换出口** / **D 不要用这个出口**
- 拿到 C 或 D，说明这条出口不太干净，换一条代理重新登录即可。
- 想让这个账号**真的变成另一台电脑**（而不是换出口），点这一行的 **更换指纹**：它会用一套新抽的指纹重新登录同一个账号，并删掉旧的浏览器配置，账号和凭据都留着。普通的「重新登录」是沿用旧指纹的，两者别搞混。

> **这是第三方站点 who.1ms.dog 的判定，不等于供应商风控结论，也不是我们自建的指纹评分。** 它只是给你一个第二意见。

<a id="tabs"></a>

## 四个标签页

**供应商** —— 你能登录哪些服务。卡片来自你已安装的插件和 magpie 市场目录，每张卡上直接开始登录。顶部搜索框支持按名称、ID 或插件名找。

**代理 IP** —— 管理登录和后续请求走的出口，并测试它们。可按地区、延迟区间、名字里的标签（家宽 / 静态）筛选。详见上面第 2 步。

**账号** —— 每个登录过的账号、它锁定的浏览器指纹，以及第三方站点对这个身份的判定。详见上面第 4 步。

**使用说明** —— 页内自带一份写给第一次使用者的说明书，十一节讲清为什么要开发这个插件、准备浏览器、加代理、登录账号、看懂身份检测结论、续期托管，以及不会用时怎么直接交给你的 agent。四种语言各写一份，不是把英文句子机翻过去。纯文字页面，不联网、不下载、不执行任何东西。

![使用说明页：页内十一节说明书的第一节，讲清为什么要开发这个插件](assets/screenshot-guide.png)

> **关于这些截图：** 全部由本仓库当前的代码在真实 Chrome 里渲染，没有手绘、没有拼接、没有替换任何页面元素。其中有四样是演示数据，因为它们会把生成截图那台机器的信息发到公开仓库：**账号与代理记录**用文档保留段 IP（`203.0.113.x`、`198.51.100.x`、`192.0.2.x`）和虚构账号名；**登录浏览器面板里的安装位置与可用磁盘**也是中性值（`C:\Users\Public\…` 与一个整数 256 GB），因为不这么做的话那张图里就会出现这台机器的账户名和磁盘水位。徽标状态、下载大小与需求空间是 shipped 代码真的算出来的。供应商卡片、logo、界面文案都是真的。生成脚本是 [`scripts/shoot-readme-screenshots.mjs`](scripts/shoot-readme-screenshots.mjs)，跑 `bun scripts/shoot-readme-screenshots.mjs` 就能重出这四张图。

<a id="features"></a>

## 功能

**登录**

- 读你已安装的供应商插件，只要其中暴露了可运行的登录方式（登录页、表单、一次性验证码），就给出 **添加账号**。一个插件暴露多家供应商时，每家一张卡。
- magpie 自带的供应商没有插件可读，入口改为走 magpie 自己的登录。magpie 的登录页被关掉时，那条登录会把链接打印出来，由干净登录替你打开。
- 一家供应商提供多条路径时（按站点登录、团队版、复用桌面端会话、粘贴密钥），由你来选，每条路径开始前都标好了类型。
- 卡片上的 **报告问题** 会打开一个 GitHub issue，标题和正文都替你写好了，你只需要点 **Create**（[它是怎么工作的](docs/reporting.md)）。

**续期托管（默认关闭）**

- 在账号页点某一行的 **托管续期**，再点 **开通托管**，这一个账号才会被托管。**默认全部关闭**，装好插件不会开通任何东西，也没有「全部开通」。
- 开通后，这个账号的续期就**交给干净登录接管**：在凭据**到期前**主动在后台静默重跑一次它自己的登录 —— 用这个账号登录时固化的**同一套浏览器指纹**（同一个 `identity.json` 与同一个持久 profile）、**同一条出口**（登录时记下的那条代理；当时是直连就仍然直连），headless，不弹窗口。新凭据经与手动登录完全相同的写回路径回到 magpie。
- **提前续是安全的**：续期走的是一次完整登录（authorize → callback），**不使用 refresh token**，所以不存在和 magpie 抢一次性令牌的问题；两边唯一共享的是 `plugin-auth.json` 里那条凭据，而那由 magpie 自己的锁与写回路径保证。凭据提前续好之后，magpie 自己的到期续期自然不会再触发；万一 magpie 先续上了，托管会读到新的到期时间并顺延，不会重复续。
- **提前量按凭据寿命走**：一小时期的提前 15 分钟，一天期的提前约 72 分钟，半月和月期的**提前 5 天**就开始续 —— 长会话值得早点续，这样一次临时失败还有好几天可以重试，而不是直接过期。续期成功后会记住这次签发了多久，下一次就按真实寿命排程。
- 同一时刻只跑一个续期，也不会和你手动发起的登录或身份检测同时进行。两次尝试至少间隔 30 分钟，**不设每日上限** —— 有效期短的凭据一天本来就要续很多次，设了上限等于把托管掐死。临时失败不会因为「连续两次」就关掉托管：只要凭据还没过期，就在续期窗口里一直按退避重试；只有**过了到期时间仍然连续失败**才判定这个账号真的下线。
- 反复失败，或者这次登录**需要你本人回答**（验证码、设备码、一次性代码），托管会**自动关闭**并把原因写在对话框里 —— 要再开得你自己重新点一次。页面顶部会同时出现一条提示，不用特意去账号页找。续期拿到的账号与这套指纹固化的账号不一致时，一律拒绝写回。
- 对话框里能随时 **立即续期**（忽略到期时钟，但保留上面所有护栏）、**停止这次续期**、**关闭托管**，并看到最近 10 次续期记录。

![续期托管对话框：已开通的账号、凭据到期时间、使用的出口与指纹，以及续期记录](assets/screenshot-hosting.png)

**出口与身份**

- 添加账号时选定的代理，整次登录都用它：浏览器窗口，以及插件用来生成链接、交换验证码的那些请求。**SOCKS 出口只能带浏览器窗口**，带不了插件自己的请求——运行时的代理支持只认 HTTP/HTTPS。
- 出口下拉显示每条出口的实测延迟，并把这家供应商还没用过的排在前面。
- 可以选择通过这条代理去取 Claude 信任分（`ip.net.coffee/claude`，0–100）并留在行上。
- 测速目标选到某家供应商时，测的是到它 API 主机的往返；只完成 TLS 握手而没拿到 HTTP 响应时，那个数字会明确标成握手耗时（`~`），不冒充请求延迟。
- 把账号退出登录不会丢掉它的浏览器身份，再次登录复用同一个。确实要换一台机器时用账号行的 **更换指纹**：新指纹重新登录、旧配置删除、账号与凭据不变。

**日常使用**

- 每张供应商卡片都带着 magpie 自己发布的那个品牌标，并按主题重新上色。画它们不需要任何网络拉取：这一套已经拷进 `assets/icons/`，取自哪里写在 `assets/icons/index.json`，归属声明写在 `assets/icons/NOTICES.md`。
- **四种语言**：English、简体中文、繁體中文、日本語，跟随 magpie 的语言设置。
- 界面深浅色跟随 magpie 的主题设置，页面开着的时候切换也会立即跟上。
- 一切都留在这台电脑上：没有账号，没有遥测，也不会为了画一个 logo 向外发请求。

<a id="cli"></a>

## 命令行与 agent

**不会用？没关系，告诉你的 agent，让它替你操作。**

这一页是给拿鼠标的人做的，但插件同时自带一套命令行和 agent 接口。你平时对话的那个 agent 可以直接驱动同一个服务：

```sh
bun bin/clean-login.mjs agent       # 整个服务的一份紧凑 JSON 摘要
bun bin/clean-login.mjs providers   # 只看供应商卡片
bun bin/clean-login.mjs proxies     # 只看出口，不含凭据
bun bin/clean-login.mjs accounts    # 只看账号
bun bin/clean-login.mjs assets      # 只看已登记的资产（邮箱、手机号、Apple ID）
```

账号、出口和资产登记都能在命令行完成，不用开页面：

```sh
bun bin/clean-login.mjs proxies add 家宽01 http 127.0.0.1 7102   # 存一条出口
bun bin/clean-login.mjs accounts import plan                     # 预览 magpie 已有的账号
bun bin/clean-login.mjs accounts import run --only <provider>#<recordId>
bun bin/clean-login.mjs accounts exit <provider>#<recordId> --mode custom --proxy <proxyId>
bun bin/clean-login.mjs accounts note <provider>#<recordId> 备用号
bun bin/clean-login.mjs accounts delete <provider>#<recordId>
bun bin/clean-login.mjs assets add google-mail a@b.com --note 主邮箱   # 登记一条资产
bun bin/clean-login.mjs assets get <id>                                 # 按 id 取一条
bun bin/clean-login.mjs assets update <id> --note 备用                  # 改类型/账号/备注
bun bin/clean-login.mjs assets delete <id>                              # 删掉一条
```

`accounts import` 只读预览与真导入走的是同一个函数，所以预览与实际导入不可能对不上；不带 `--only` 时导入整份计划。`assets add` 的 `<type>` 取 `google-mail`、`microsoft-mail`、`cn-phone` 或 `apple-id`，格式校验由服务端负责。

CLI 默认在 `127.0.0.1:3492` 找服务（用 `--port` 或 `--url` 覆盖），从服务自己送出的页面里读取每进程一份的页面 token，并且从不把这个 token 打印出来。除了运行时的 `fetch` 它没有任何依赖，所以毫秒级启动，也不会加载浏览器模块。

有两件事让程序不必轮询：

- **`GET /api/agent`** 返回一份紧凑、自描述的摘要：版本、服务端口、命令目录，以及合并后的供应商卡片、代理、账号和正在跑的任务状态。它不带页面需要的四语言描述，也从不带密码。
- 异步状态路由上的 **`?wait=<ms>`**（`/api/signin`、`/api/native-signin`、`/api/proxy-score`、`/api/environment/job`、`/api/accounts/:provider/:key/check`）会在服务内部阻塞，直到任务落定或时限用完。一个请求就替掉了轮询循环。需要调用方动手的状态（一次性验证码、要粘贴的值）会立刻结束等待。

```sh
bun bin/clean-login.mjs signin start --provider workbuddy --proxy hk-home-1 --wait
bun bin/clean-login.mjs signin code 123456
bun bin/clean-login.mjs proxy score hk-home-1 --wait
bun bin/clean-login.mjs accounts prune                # 扫掉不再持有凭据的账号目录
bun bin/clean-login.mjs accounts hosting              # 续期托管的开关与正在跑的任务
bun bin/clean-login.mjs env cancel                    # 停掉登录浏览器下载
bun bin/clean-login.mjs score cancel                  # 停掉信任度评分
```

完整命令列表跑 `bun bin/clean-login.mjs help`。远程服务（`magpie web`）没有回环页面可读，那里要显式传 `--token`。

<a id="troubleshooting"></a>

## 排查问题

| 现象 | 怎么办 |
| --- | --- |
| 某张供应商卡没有 **添加账号** | 卡片上写了原因。市场条目需要先在 magpie 里装上它的插件；只有插件的供应商需要一个暴露了浏览器登录方式的插件。 |
| 登录浏览器显示*未安装* / 下载失败 | 首次运行会取一个约 170 MB 的 Windows x64 压缩包。检查磁盘空间和网络，然后从供应商页重试。压缩包在解包前会做 sha256 校验。 |
| 登录失败，报 `no_url` 或 `method_input_required` | 插件要一个值（手机号、站点、密钥），而对话框没收集到。把那个字段填好再试；一直失败就用卡片上的 **报告问题**。 |
| 代理测试失败 | 测试是通过那条出口建立真实连接，绝不退回直连。检查主机、端口、凭据，以及这条出口是否允许访问目标。 |
| 延迟数字前面有个 `~` | 那是握手耗时，不是请求延迟：目标完成了 TLS 握手但没返回 HTTP 响应（常见于 WAF 拦截）。换一条出口再测。 |
| 已登录的账号看起来像一台新机器 | 到 **账号** 页看它固定的指纹。再次登录会复用同一个身份；删掉账号数据才会把它移除。 |
| 想让某个账号真的换一台机器 | 在 **账号** 页已登录的那一行点 **更换指纹**：用新指纹重新登录同一个账号，旧的浏览器配置会被清掉，账号与凭据保持不变。普通的「重新登录」沿用旧指纹。 |
| 身份检测拿到 C 或 D | 这条出口不干净。换一条代理，重新登录这个账号。 |
| 其他情况 | 提一个 [issue](https://github.com/Gruu6y/magpie-clean-login/issues)，写清你预期什么、实际发生了什么、涉及哪家供应商或哪条代理。一张报错截图很有价值。**请永远不要把真实 token 或代理密码贴进 issue。** |

<a id="privacy"></a>

## 隐私与数据存放位置

- 没有遥测，也没有账号。唯一的网络调用就是你自己发起的那些：代理测试、信任分页面、身份检测页面、运行时下载，以及供应商自己的登录。
- 代理、账号、指纹和浏览器配置都在 `~/.config/magpie/magpie-clean-login/`（用 `MAGPIE_CLEAN_LOGIN_DATA` 覆盖；配置根本身用 `MAGPIE_CONFIG_DIR`）。市场目录从 `~/.cache/magpie/` 读取（`MAGPIE_CACHE_DIR`）。续期托管的开通状态与最近记录在同一个目录下的 `renew-hosting.json`，里面只有开关、时间和结果，没有任何凭据。
- 登录浏览器在 Windows 上解包到 `%LOCALAPPDATA%/magpie-clean-login/camoufox`（`MAGPIE_CLEAN_LOGIN_BROWSER_DIR`）。
- 存下来的代理密码不会到达页面，也不会写进日志。页面 token 每进程一份，只存在于服务送出的页面里。

<a id="contributing"></a>

## 参与贡献

欢迎 pull request。测试套件就是契约：`bun test` 跑全部，一个没有测试的改动就是以后没人敢信的改动。改 `lib/`、`ui/`、`page/` 或 `index.mjs` **不需要自己升版本号**——版本由合并方在合并点分配；`node scripts/check-version-bump.mjs` 仍会拒绝降级或等于已发布的版本号。动手前先读 [AGENTS.md](AGENTS.md) 与 [docs/releasing.md](docs/releasing.md)。

<a id="license"></a>

## 许可

[MIT](LICENSE) © 2026 Gruu6y. [tag 列表 / 版本历史](https://github.com/Gruu6y/magpie-clean-login/tags) · [反馈问题](docs/reporting.md) · [CI](https://github.com/Gruu6y/magpie-clean-login/actions/workflows/ci.yml)
