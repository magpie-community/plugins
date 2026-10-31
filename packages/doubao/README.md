# 豆包生图中转（tools-doubao）

Magpie 工具插件：让**任意 Agent** 通过**你自己的豆包账号**（网页版登录态，与豆包桌面端同账号同后端）生成图片。工具经 Magpie 内置 MCP 服务器 `/mcp/magpie/tools` 注册进所有智能体，工具名为 `doubao_generate_image` / `doubao_check_login`。

- **文生图**：prompt + 画幅比例（1:1 / 16:9 / 9:16 / 4:3 / 3:4 / auto）+ 模型档位（免费档 Seedream 5.0 Flash / 4.5 / 4.0）
- **图生图**：传本地图片路径或图片 URL 作参考图
- **去水印**（可选）：扩图裁剪法 —— 提示词追加"往下扩图四分之一"再生成一次，裁掉底部扩出区，右下角"豆包AI生成"标识随之消失（多花一次生成额度）
- **多账号轮换**：登录失效自动换号；图片自动落盘并返回绝对路径

原理：用豆包网页版的 `sessionid` Cookie 免签名直调豆包内部接口（优先 web `chat_ability` 新协议，失败自动降级旧 `samantha` 客户端通道；图生图固定走 samantha 通道）。逆向接口属个人自用性质，**不稳定且存在账号风控风险**，商用请走[火山引擎官方 API](https://www.volcengine.com/product/doubao)。

## 登录

任选其一：

```sh
magpie plugin login doubao   # Magpie 内触发，弹出二维码
```

或本地克隆本仓库后：

```sh
node packages/doubao/scripts/login.mjs   # 弹出二维码 + 终端 ASCII 渲染
```

弹出二维码 → 手机豆包 App 扫码并确认 → 登录态自动写入插件目录 `config.json`。Cookie 有效期约 30 天，过期重新扫码即可。

## 配置凭证（三选一）

1. **扫码登录**（见上节，推荐）
2. **手动**：复制 `config.example.json` 为 `config.json`，填入 `sessionid`（浏览器登录 doubao.com → F12 → Application → Cookies → `https://www.doubao.com` → 复制 `sessionid`；`ttwid`、`passport_csrf_token` 可选，带上更稳）
3. **环境变量**：`DOUBAO_ACCOUNTS="主号:sessionid=xxx,ttwid=yyy;小号:sessionid=zzz"`

多账号把 `accounts` 数组填多条，登录失效自动轮换。生成的图默认保存在调用方工作目录的 `generated-images/`（config.json 里 `outDir` 可改）。

## 配置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `accounts` | `[]` | `{name, sessionid, ttwid?, passport_csrf_token?}` 数组 |
| `model` | `Seedream 5.0 Flash` | 默认模型档位；Pro 档需订阅，会自动回退免费档 |
| `ratio` | `1:1` | 默认画幅比例 |
| `channel` | `auto` | `web`=chat_ability 新协议（模型/比例精确）；`pc`=samantha 旧通道（稳定、支持图生图）；`auto`=先 web 后 pc |
| `outDir` | 空 | 图片保存目录，空=跟随调用方工作目录 |
| `timeoutSeconds` | `180` | 单次请求超时 |
| `ratioHint` | `true` | web 通道把比例追加进自然语言（web 端 ratio 字段实测不生效） |
| `removeWatermark` | `false` | 去右下角"豆包AI生成"水印（扩图裁剪法） |
| `watermarkExtend` | `"1/4"` | 去水印的扩图比例，裁剪保留 1/(1+该值) |

## 故障排查

| 现象 | 处理 |
|---|---|
| 提示登录态失效 | `sessionid` 过期（约 30 天），重新扫码；多账号时会自动轮换 |
| `710022002 / 710022004` 风控 | 等约 30 分钟冷却 / 换网络（手机热点最快）/ 浏览器过一次滑块验证 |
| 提示需要订阅 | 免费账号只能用免费档（Seedream 5.0 Flash / 4.5 / 4.0），点名 Pro 档会自动回退 |
| 生图很慢 | 单张通常数秒到一两分钟；超时可调大 `timeoutSeconds` |

## 测试

```sh
node scripts/test-offline.mjs     # 离线单测：SSE 解析 / PNG 编解码 / 扫码 / 插件结构
node scripts/test-protocol.mjs --check                      # 各账号登录态
node scripts/test-protocol.mjs "一只柴犬在樱花树下" --ratio 16:9
node scripts/test-protocol.mjs "一朵红玫瑰特写" --wm          # 文生图 + 去水印
```

## 参考实现

协议字段移植自开源抓包项目（Apache-2.0）：[wangchuxiaoji-oss/doubao2api](https://github.com/wangchuxiaoji-oss/doubao2api)（samantha 通道、上传两步流、SSE 解析、扫码登录）、[sanshidi/doubao-web-mcp](https://glama.ai/mcp/servers/sanshidi/doubao-web-mcp)（web chat_ability 协议笔记，2026-10-19 抓包结论）。

上游开发仓库：[Zeppeli777/doubao-image-plugin](https://github.com/Zeppeli777/doubao-image-plugin)。
