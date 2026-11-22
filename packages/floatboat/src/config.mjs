// src/config.mjs —— 上游事实集中放这里，改版本只看这一个文件。
//
// 全部条目来自 0.6.7 桌面端的实测（解包 app.asar + 日志 + 接口探测，2026-11-20）：
//   · 登录：浏览器打开 https://floatboat.ai/desktop-sign-in?state=<uuid>
//           网页登录完回跳 aoe://...?code=&state=，客户端再换 token
//   · 业务后端：https://floatboat.ai        （/api/desktop/*、/api/v1/users/me/*）
//   · 模型网关：https://newapi.aoe.chat     （New API，OpenAI + Anthropic 双协议）
//   · 模型网关鉴权：/api/desktop/newapi/key 发的 sk-… key

/** magpie 里的 provider id（小写，全局唯一） */
export const PROVIDER = "floatboat"

/** 卡片上显示的名字 */
export const PROVIDER_NAME = "Floatboat"

/** 业务后端（账号、积分、newapi key） */
export const WEB_BASE = "https://floatboat.ai"

/** 模型网关（New API）。magpie 走 OpenAI 兼容协议，所以 baseURL 带 /v1 */
export const GATEWAY_BASE = "https://newapi.aoe.chat/v1"

/** 网页登录入口；真正要带 ?state=<uuid> */
export const SIGN_IN_PATH = "/desktop-sign-in"

/** ai-sdk 的 provider 包名 */
export const SDK = "@ai-sdk/openai-compatible"

/**
 * 上游客户端自报的身份。桌面端是 Electron，这里用一个等效的桌面 UA；
 * 业务接口不校验 UA，但网关/CDN 会看，别乱换成脚本 UA。
 */
export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Floatboat/0.6.7 Chrome/140.0.7339.133 Electron/39.4.0 Safari/537.36"

/** 业务接口超时 */
export const API_TIMEOUT_MS = 20_000

/** 聊天整轮墙钟 */
export const CHAT_TIMEOUT_MS = 600_000

/** newapi key 的内存缓存时长（key 基本不变，但换账号/换套餐时可能会换） */
export const KEY_TTL_MS = 30 * 60_000

/** 卡片的图标（SVG data URL，深底 + 琥珀色帆） */
export const ICON =
  "data:image/svg+xml;base64," +
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
<rect width="64" height="64" rx="14" fill="#141210"/>
<path d="M33 10 L33 42 L15 42 Z" fill="#F5A524"/>
<path d="M37 18 L37 42 L52 42 Z" fill="#C97B12"/>
<path d="M11 47 h42 l-6 8 H17 Z" fill="#F5A524"/>
</svg>`,
  ).toString("base64")
