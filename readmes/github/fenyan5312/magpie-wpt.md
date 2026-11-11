# magpie-wpt · 自用 wb 导入

在 WorkBuddy 的登录方式里加一个「粘贴凭据登录」——凭据已经在手上时，不走浏览器，粘进插件自己开的窗口就行（手动输入也可以，不依赖剪贴板）。

> **仅供交流学习与逆向研究使用。** 本项目只做本地凭据格式转换与登录，不含任何绕过、代理、共享或转售能力。
> 请只用于你自己的账号。使用产生的一切后果由使用者自负。

插件的独立说明（安装、支持的输入、行为约定）见 [`plugin/README.md`](plugin/README.md)。

## 入口在哪

magpie → **供应商** → **WorkBuddy** → 「**添加另一个 WorkBuddy (CodeBuddy) 账号**」→「**其他登录方式**」，列表里第四个就是。

```
用哪种方式登录 WorkBuddy (CodeBuddy)？
  WorkBuddy account (browser)
  WorkBuddy desktop's sign-in
  WorkBuddy API key
  粘贴凭据登录          ← 这个
```

命令行同一个入口：

```bash
magpie plugin login workbuddy 粘贴凭据登录
```

## 它怎么做到的（为什么不是自己注册一个插件）

magpie **一个供应商只能由一个插件提供服务（serving）**，而「其他登录方式」里列出来的，就是这个插件给出的全部方式。所以：

- 自己注册一个插件、接管 `workbuddy` → 社区插件原有的 browser / desktop / API key 三个方式**会整个消失**
- 不接管 → 自己的方式**调不出来**

两条路都是错的。所以这里不另起一个插件，而是**包在社区插件外面**：

```js
const hooks = await WorkBuddyAuthPlugin(ctx);        // 社区插件的 config / provider / auth
return {
  ...hooks,
  auth: { ...hooks.auth,
    methods: [...hooks.auth.methods, 粘贴凭据登录] }, // 在它后面追加，不替换
};
```

社区插件的三个方式原样保留，第四个追加在后面。两者是同一个插件交出去的，所以都在。

依赖：`@magpie-community/opencode-workbuddy-auth`（wb 的登录本来就要装它）。没装的话插件会明确报出来，并给出安装命令。

## 安装

```bash
git clone https://github.com/fenyan5312/magpie-wpt.git
cd magpie-wpt
magpie plugin add ./plugin
magpie plugin use ./plugin workbuddy
```

`plugin use` 那一步是必须的：它让这个包装插件来服务 `workbuddy`（从而把四种方式一起交出去）。已经装过社区插件的话，它仍然会被加载，只是不再由它来服务。

装好后 `magpie plugin list` 能看到，四种方式都在。

## 用法

点「粘贴凭据登录」之后，插件会在 `127.0.0.1` 上起一个临时页面并打开浏览器，长这样：

```
填入凭据
把凭据 JSON 粘进下面的框，点「导入」。成功后窗口会自己关掉。
┌──────────────────────────────────────────────────────┐
│ {"account":{…},"auth":{"accessToken":"…",…}}         │
└──────────────────────────────────────────────────────┘
[ 导入 ]  [ 取消 ]
```

把凭据 JSON 全文粘进去（手打也行，不依赖剪贴板），点「导入」（或 `Ctrl+Enter`）。

- **不会先说成功再失败。** 点「导入」后窗口显示「校验中…」，插件会真的拿 refresh token 去换一次新 token；换到了才关窗，换不到就把原因直接显示在框下面，窗口留着让你改完再点一次，不用重新开。
- 窗口只在本机回环地址上，带一次性 token（别的网页没法往这里提交），成功后立即关闭，最多存活 5 分钟。
- 凭据只在内存里过一遍，不落盘、不外发，只发一个刷新请求。

**为什么不是 magpie 自带的输入框：** magpie 的 provider 模型里只存 `{type, label}`，`prompts` 字段在保存时就被丢掉了——连官方插件的 `prompts` 也一样。所以声明了也不会出现输入框。这个窗口是插件自己开的。

**给脚本用：指定文件**（不走窗口，路径指向凭据 JSON）

```bash
# Windows
set "WPT_FILE=D:\cred.json"

# PowerShell
$env:WPT_FILE='D:\cred.json'

# macOS / Linux
WPT_FILE=/path/cred.json
```

设了 `WPT_FILE` 就优先读文件。窗口被关掉（取消）时才会退回去读剪贴板。

## 支持的凭据格式

这几个来源的字段拼法不一样，插件全都读：

| 来源 | 形态 |
|---|---|
| `workbuddy-<uid>.json` | `{"account": {uid, nickname}, "auth": {accessToken, refreshToken, expiresAt, domain}}` |
| sub2api / cockpit 扁平数组 | `[{uid, nickname, domain, expires_at, access_token, refresh_token}]` |
| `workbuddy-desktop.info` | 桌面端导出，`account` + `auth` + `accounts[]`，字段驼峰 |
| magpie 存储备份 | `plugin-auth.json` 里的单条，用 `access` / `refresh` / `expires` |
| 裸对象 | 顶层直接放上述任一拼法 |
| **WorkBuddy API key** | `ck_…` / `pt_…`，或任意一个单独的 key；也可以放在 `{"key": "…"}` / `{"apiKey": "…"}` / `{"ck": "…"}` 里 |
| **Cookie / 请求头** | `access_token=…; refresh_token=…`、`Cookie: …`、`authorization: Bearer …`、`x-refresh-token: …`、`k=v&k=v`、curl 的 `-H '…'`、浏览器扩展导出的 `[{name,value}]` |

**API key 与登录凭据是两种账号。** 粘贴 `ck_…` 这类 key 时，插件按 magpie 的 `{type:"api", key}` 存，和「WorkBuddy API key」登录方式存的是同一种账号；key 不会过期，也不会续期，插件不在这里联网校验它（WorkBuddy 的 `/v3/config` 对任何 key 都回 200，验不出来），第一次真实请求被拒时才会暴露。

**Cookie 必须带着 token 才有用。** 只有会话值的 Cookie（`sessionid=…` 之类）换不到 token，窗口会直接说清；请在 WorkBuddy 网页登录后从站点数据里复制 `accessToken` 与 `refreshToken`，或改用 API key。

**字段拼法都能读**（大小写、驼峰/下划线、有无 Token 后缀）：

| 含义 | 认得的写法 |
|---|---|
| access | `accessToken` `access_token` `access` `token` |
| refresh | `refreshToken` `refresh_token` `refresh` |
| 到期 | `expiresAt` `expires_at` `expires` `expiry` `expiration`；或时长 `expiresIn` `expires_in` |
| refresh 到期 | 同上，`refreshExpiresAt` / `refresh_expires_at` / `refreshExpiresIn` … |

时间戳 **秒和毫秒都认**（10 位 / 13 位自动判断）。`expiresIn` 是时长不是时间点，会换算。
同时有 `expiresAt` 和 `expiresIn` 时以 `expiresAt` 为准。

字段缺失时会从 JWT 里补 `uid`（`sub`）和 `domain`（`iss`）。
一份凭据里含多个账号时只导入第一个，并且会先告诉你里面有几个。

## 行为约定

- **登录凭据必须带 refresh token。** 只有 access token 的凭据会被拒绝——它一小时就死了。API key（`ck_…`）是另一回事：它没有 refresh，也不续期，直接按 API key 账号导入。
- **登录前会真的刷新一次。** 凭据失效在窗口里当场报错，不会存进去一个连不上的账号，窗口也不会先报成功。
- **重复账号会被拒绝。** magpie 本身不去重，同一个文件粘两次会列出两个账号，而且第二份的 refresh token 已经被第一份花掉了。登录前会检查 uid，已有的直接拒绝；如果 magpie 里那份比粘的还新，会顺便告诉你，因为覆盖等于降级。
- **refresh token 是一次性的。** 每次登录都会轮换。不要把同一个账号的同一份凭据同时喂给两个程序。

## 账号名字

按这个顺序取：`nickname` → 打码后的手机号（`176****1852`）→ uid 前 8 位。

一定不会是空的——magpie 把空的 `accountId` 显示成字面量 `Signed in`，看着像没登录成功。

## 网络

只发一个请求：

```
POST https://copilot.tencent.com/v2/plugin/auth/token/refresh
```

没有遥测，没有回传，凭据不出本机。窗口本身是 `127.0.0.1` 上的本地页面，加载不访问任何外部资源。

## 卸载

```bash
magpie plugin rm ./plugin
```

如果想让社区插件重新服务 `workbuddy`：

```bash
magpie plugin use @magpie-community/opencode-workbuddy-auth@latest workbuddy
```

已登录的账号都还在，不受影响。

## 许可

MIT，见 [LICENSE](LICENSE)。
