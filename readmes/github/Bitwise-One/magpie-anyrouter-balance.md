# AnyRouter 余额、今日消耗与签到插件

适用于 [magpie](https://usemagpie.ai/docs/zh/plugins) 的余额、北京时间今日消耗与可选每日签到供应商。首次导入浏览器 Cookie 和用户 ID，之后直接读取保存的登录状态，无需每次填写 Cookie。

余额查询读取 `GET /api/user/self`；今日消耗优先读取 `GET /api/log/self/stat?type=2`，该路径被 WAF 拦时自动回退到 `GET /api/log/self` 的消费日志分页汇总；用户在 magpie 中开启签到后，签到钩子调用 `POST /api/user/sign_in`。不注册模型、不需要模型 API Key，不能作为聊天模型供应商。登录验证、余额查询和今日消耗统计都不会触发签到。

## 安装

先在插件目录安装依赖：

```powershell
cd D:\github\magpie-anyrouter-balance
bun install --ignore-scripts
```

然后在 magpie 的「插件 → 添加插件」中填写文件夹路径：

```text
D:\github\magpie-anyrouter-balance
```

如果将插件复制到其他机器，先在插件目录执行：

```powershell
bun install --ignore-scripts
```

也可使用 magpie CLI：

```powershell
magpie plugin add "D:\github\magpie-anyrouter-balance"
magpie plugin login anyrouter-balance
magpie quota
```

应用内修改插件源码后，关闭再开启该插件以重载。CLI 每次启动都会读取当前文件夹代码。

## 首次登录

1. 先在 magpie 中设置全局代理或该供应商的代理，例如 `http://127.0.0.1:10808`。插件不写死端口，也不自行覆盖账号代理。
2. 浏览器使用相同代理出口，登录 `https://anyrouter.top` 并完成网站验证。
3. F12 → Network → `/api/user/self` 请求 → Request Headers，复制 `Cookie` 的值和 `New-Api-User` 用户 ID。
4. 在「AnyRouter 余额与签到」选择「导入登录 Cookie（只读验证）」。Cookie 输入为密码型，不会回显。
5. 输入用户 ID；浏览器 User-Agent 可填写同一请求的值，或留空使用插件默认值。

完整 Cookie 包含 `session`，并建议包含浏览器现有的 `acw_tc`、`cdn_sec_tc` 等风控 Cookie。只复制请求头的值，不复制 `Set-Cookie` 的 `Path`、`HttpOnly`、`Expires` 等属性。一个账号填写一次；再次登录可添加其他账号。用户 ID 不是青龙环境变量 ID。

登录流程使用 magpie 的交互式回调机制，但不虚构 OAuth、刷新令牌或自动登录接口。回调真实查询余额、确认 Cookie 与用户 ID 一致后，才保存凭据。需要更新过期 Cookie 时，在该账号上重新登录。

## 显示及状态

- 余额：`quota / 500000` 美元；今日消耗：当天消费日志 `quota / 500000` 美元；累计消耗：`used_quota / 500000` 美元。保留最低一个 quota 的精度。
- 不推测充值总额、套餐百分比或重置时间；缺少有效额度时显示错误，不显示假零余额。
- 每账号保存独立 CookieJar，包含作用域及失效时间；接收服务器的 Cookie 更新，处理已知 `arg1` JavaScript 挑战，最多重试两次只读 GET。
- 余额查询中，网络故障、未知风控页面和非 JSON 响应保持登录标记不变，JSON `401` 才标记需要重新登录；签到的 `401` 返回 `failed` 并提示重新导入 Cookie。
- 登录 `session` 真正过期或被撤销仍需重新导入。交互验证码需要在浏览器完成，插件不保证绕过所有风控。
- 同一账号的余额查询和签到共享队列，使用最近保存的 Cookie；同类并发操作合并为一次请求。旧请求不会覆盖查询期间新导入的登录信息。

## 今日消耗

卡片顶部只显示独立美元余额，今日消耗显示在单独一行（附日期、北京时间及日志汇总来源），「累计消耗」仍是账号历史总用量，两者互不混用。余额另外通过数值钱包窗口返回，支持新版 magpie 的余额历史趋势和多账号「全部 N 个账号」总余额汇总；汇总由宿主完成，至少两个账号成功读取余额时显示。读取失败的账号不按零余额计入。卡片样式、折叠及趋势图由 magpie 控制，插件不能覆盖宿主 CSS，也不伪造历史曲线。余额没有已知额度上限，因此不会显示图二中的额度百分比和进度条。

- 统计口径：以北京时间 00:00:00 到当前秒为窗口，`type=2` 仅计消费日志。优先用统计接口的 `sum(quota)`；不使用余额差值、首次读取基线或累计消耗差值推算，因此签到赠送、充值、其他账号不会污染今日消耗。
- 自动绕路：该站 `/api/log/self/stat` 使用独立的 `http_security_level_rule` WAF 规则，虚拟 Cookie 实测返回 HTTP 200 的 HTML 拦截页（无 `arg1`，Cookie 握手重试无效）。这**不是登录失效，重输同一份 Cookie 不会解决**。插件遇到该路径被拦或统计失效时，自动改用 `/api/log/self` 分页消费日志求和：100 条/页、最多 20 页，仅累加落在今日时间范围内、类型有效的 `quota`。汇总成功时标记「消费日志汇总」，余额与签到完全不受影响。日志超过 2000 条或分页不完整时明确显示不可用，绝不显示部分汇总值。
- 边界与日期：服务端时间过滤包含起止秒。日期在用户信息请求返回后重新计算，慢请求跨过北京时间午夜时切到新的一天；年界、闰日已覆盖测试。
- 可靠性：统计与日志两条路径都失败时，保留余额并明确显示「今日消耗 不可用：…（仅影响今日消耗；余额与签到不受影响，可稍后重试）」，绝不把未知消耗显示成 `$0.00`；真正的 `401` 才标记登录失效。零消耗必须是明确的空日志页或 `quota: 0`。


## 每日签到

1. 更新文件夹插件后，在 magpie 中将插件关闭再开启，加载新增的 `auth.checkin` 钩子。
2. 在该供应商的设置中打开签到开关。无需添加 `--checkin`、`--cookie` 等命令行参数，直接复用已保存的 Cookie、用户 ID 和账号代理。
3. magpie 按每个北京日为已登录账号调度签到；失败后可能在当天稍后再次调度。插件本身不创建定时器，不在登录或查余额时偷偷签到。

| 结果 | 含义 |
| --- | --- |
| `claimed` | 服务端确认领取成功；奖励金额仅在响应明确给出时填写，不根据余额差值推算。 |
| `done` | 今日已签到，或成功响应为空、没有可领取奖励；不重复计算奖励。 |
| `captcha` | 验证码或风控拦截；请在原站浏览器完成验证或签到。 |
| `failed` | 登录失效、服务端拒绝、网络失败或响应格式不正确。 |

签到先通过只读用户信息请求验证账号并预热风控状态，再发送一次 POST。只读 GET 可处理已知 JavaScript 挑战；签到 POST 绝不自动重试，也不跟随重定向。服务端已经确认成功时，即使本地凭据保存失败也保留成功结果，并附带警告，避免误把已确认操作标记为失败。

供应商 ID 仍为 `anyrouter-balance`，已有账号和代理配置继续使用；无需删除账号或重新导入 Cookie，除非登录本身已失效。关闭签到开关后仍可正常查询余额。


## 配置

非秘密插件选项：

```json
{
  "baseURL": "https://anyrouter.top",
  "userAgent": "浏览器的实际 User-Agent（可省略）"
}
```

`baseURL` 默认为原站。远程地址必须使用 HTTPS；仅回环地址允许 HTTP 用于本地测试。改变服务地址后必须重新导入 Cookie，已有账号的凭据不会自动发送给新地址。不要填写未经验证的第三方博客代理。

不要将 Cookie 放入普通插件选项。magpie 登录、余额查询和签到使用当前账号/供应商的代理；回环地址按 magpie 规则直连。

## 凭据与安全

CookieJar 作为不透明 API 类型凭据保存在 magpie 的 `plugin-auth.json` 的 `key` 字段。它不是模型 API Key。账号元数据保存服务地址、用户 ID 和 User-Agent；Cookie 不重复放在普通选项或元数据中。

服务器更新登录或风控 Cookie 后，插件通过账号作用域的 `client.auth.set` 保存完整对象，保留其他已有字段。Unix 下 magpie 文档规定认证文件权限为 `600`；Windows 还需依赖本机文件 ACL。这不代表凭据经过加密。

插件不打印 Cookie、挑战 HTML 或可能包含凭据的原始异常。但插件宿主有本机权限，其他已安装插件也需可信。不要分享认证文件、完整 cURL 命令或 Cookie。

## 验证

```powershell
bun test
```

已运行 31 项行为回归，并在独立目录、空环境及虚拟凭据下运行官方 magpie Bun 宿主：验证登录、多账号、Cookie 更新、重启恢复、余额、完整北京时间今日消耗（排除昨日、未来、充值、其他账号）、stat 被路径 WAF 拦截时自动分页汇总 3 页日志、stat 可用时优先使用、签到奖励不抬高今日消耗，以及各路径不可用时保留余额且不伪造零。真实站点的 stat 路径与日志分页路径均经账号代理用虚拟 Cookie 探测：前者固定被 WAF 拦，后者可到达后端；未读取真实账号的消耗数据。

未使用真实账号查询余额或今日消耗，未向真实 AnyRouter 发送签到 POST，未修改现有 magpie 登录文件；当前机器未定位到可运行的 magpie CLI，因此没有应用界面的视觉验证。

## 实现依据

- [magpie 插件、认证、代理与用量协议](https://usemagpie.ai/docs/zh/plugins)
- [官方插件宿主](https://github.com/yetone/magpie/blob/main/internal/plugin/host.js)
- [new-api 日志统计接口与消费类型](https://github.com/QuantumNous/new-api-docs/blob/main/docs/api/fei-log.md)
- [new-api 日志分页、统计类型与 SumUsedQuota 实现](https://github.com/QuantumNous/new-api/blob/main/model/log.go)
- [公开的 AnyRouter JavaScript 挑战算法](https://github.com/paceaitian/anyrouter-balance/blob/master/app.py)

0.3.1：stat 路径被独立 WAF 规则拦时自动回退到消费日志分页汇总，无需手动重输 Cookie；失败文案明确仅影响今日消耗。0.3.0：新增北京时间今日消耗统计及其独立失败降级；通用 WAF 报错改为按请求方法区分。0.2.0：新增可选每日签到、已签到与验证码状态映射、奖励金额读取、签到凭据更新，以及余额/签到共享的账号队列；保留原供应商 ID 和已保存账号。不提供模型，也不使用第三方转发。
