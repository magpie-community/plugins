# Doubao Image（豆包生图）

Magpie 工具插件：让**任意 Agent** 通过**你自己的豆包账号**（网页版登录态，与豆包桌面端同账号同后端）生成图片。工具经 Magpie 内置 MCP 服务器 `/mcp/magpie/tools` 注册进所有智能体，工具名为 `doubao_generate_image` / `doubao_check_login`。非官方接口，仅供个人自用。

- **文生图**：prompt + 画幅比例（1:1 / 16:9 / 9:16 / 4:3 / 3:4 / auto）+ 模型档位（免费档 Seedream 5.0 Flash / 4.5 / 4.0；Pro 档需订阅，会自动回退免费档并说明）
- **图生图**：传本地图片文件（png/jpg/webp/gif）或公网图片 URL 作参考图；仅接受真实图片（扩展名 + 魔数 + 20MB 上限），URL 拒绝回环/内网地址
- **账号管理**：固定使用第一个账号，登录失效时自动切换到下一个；图片按响应字节原样落盘并返回绝对路径

原理：用豆包网页版的 `sessionid` Cookie 免签名直调豆包内部接口（优先 web `chat_ability` 新协议，失败自动降级旧 `samantha` 客户端通道；图生图固定走 samantha 通道）。**非官方接口不稳定且存在账号风控风险**，商用请走[火山引擎官方 API](https://www.volcengine.com/product/doubao)。

## 登录

推荐在 **Magpie 插件页点「登录」**（或 `magpie plugin login doubao`）：弹出豆包登录二维码 → 手机豆包 App 扫码确认 → 登录态由 magpie 保管（`plugin-auth.json`，0600 权限），插件不另存凭证文件。Cookie 有效期约 30 天，过期重新扫码即可。

远程（`magpie web`）或无桌面环境的机器上看不到弹出的二维码，请改用下面的环境变量方式。

## 配置账号（三选一）

1. **扫码登录**（见上节，推荐）
2. **环境变量**：`DOUBAO_ACCOUNTS="主号:sessionid=xxx,ttwid=yyy;小号:sessionid=zzz"`
3. **手动配置文件**：复制 `config.example.json` 为本包目录下的 `config.json`，填入 `sessionid`（浏览器登录 doubao.com → F12 → Application → Cookies → `https://www.doubao.com`；`ttwid`、`passport_csrf_token` 可选，带上更稳）。请把文件权限设为仅本人可读。

生成的图默认保存在调用方工作目录的 `generated-images/`（config 里 `outDir` 可改）。

## 配置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `accounts` | `[]` | `{name, sessionid, ttwid?, passport_csrf_token?, deviceId?, webId?}` 数组 |
| `model` | `Seedream 5.0 Flash` | 默认模型档位；Pro 档需订阅，会自动回退免费档 |
| `ratio` | `1:1` | 默认画幅比例 |
| `channel` | `auto` | `web`=chat_ability 新协议（模型/比例精确）；`pc`=samantha 旧通道（稳定、支持图生图）；`auto`=先 web 后 pc |
| `outDir` | 空 | 图片保存目录，空=跟随调用方工作目录 |
| `timeoutSeconds` | `180` | 单次请求超时 |
| `ratioHint` | `true` | web 通道把比例追加进自然语言（web 端 ratio 字段实测不生效） |

## 故障排查

| 现象 | 处理 |
|---|---|
| 提示登录态失效 | `sessionid` 过期（约 30 天），重新扫码；多账号时自动切换到下一个 |
| `710022002 / 710022004` 风控 | 稍后再试；或在浏览器里打开 doubao.com 自行完成一次人机验证 |
| 提示需要订阅 | 免费账号只能用免费档（Seedream 5.0 Flash / 4.5 / 4.0），点名 Pro 档会自动回退 |
| 生图很慢 | 单张通常数秒到一两分钟；超时可调大 `timeoutSeconds` |

本插件不绕过、不规避豆包的风控与人机验证；设备遥测参数（device_id/web_id）在扫码登录时随机生成并随账号保存，不共用任何第三方设备的指纹。

## 测试

```sh
bun test doubao.test.mjs     # 单元测试（SSE 解析 / PNG 解码 / 出网安全 / 插件结构）
node scripts/test-protocol.mjs --check                                 # 各账号登录态
node scripts/test-protocol.mjs "一只柴犬在樱花树下" --ratio 16:9
node scripts/test-protocol.mjs "改成赛博朋克风格" --ref 照片.jpg         # 图生图
```

## 参考实现

协议字段移植自开源抓包项目（Apache-2.0）：[wangchuxiaoji-oss/doubao2api](https://github.com/wangchuxiaoji-oss/doubao2api)（samantha 通道、上传两步流、SSE 解析、扫码登录）、[sanshidi/doubao-web-mcp](https://glama.ai/mcp/servers/sanshidi/doubao-web-mcp)（web chat_ability 协议笔记，2026-10-19 抓包结论）。

上游开发仓库：[Zeppeli777/doubao-image-plugin](https://github.com/Zeppeli777/doubao-image-plugin)。
