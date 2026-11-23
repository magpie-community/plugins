// src/auth.mjs —— 登录编排：拼登录页 → 等回调 → 换 token → 抓 newapi key
//
// 流程照抄桌面端（0.6.7 实测）：
//   1. 生成 state（uuid），打开 https://floatboat.ai/desktop-sign-in?state=<uuid>
//   2. 网页登录后回跳 aoe://…?code=&state=（自定义协议）
//   3. POST /api/desktop/auth/exchange {code,state,deviceId} → access_token + refresh_token
//   4. GET  /api/desktop/user/me     → 账号 + 积分
//   5. GET  /api/desktop/newapi/key  → 模型网关的 sk- key

import { randomUUID } from "node:crypto"
import { SIGN_IN_PATH, WEB_BASE } from "./config.mjs"
import { exchangeCode, fetchNewApiKey, fetchUser, newDeviceId } from "./desktop-api.mjs"

/** 拼登录页地址 */
export function buildSignInUrl(state) {
  const url = new URL(`${WEB_BASE}${SIGN_IN_PATH}`)
  url.searchParams.set("state", state)
  return url.toString()
}

/** 会话里的 access token：api 类型登录只有 key，没有 access */
export function tokenOf(auth) {
  return String(auth?.access || auth?.key || "").trim()
}

/** 新的 state（uuid，和桌面端一致） */
export function newState() {
  return randomUUID()
}

/**
 * 账号显示名：邮箱 > 昵称 > 客户端里那串数字 id。
 * ⚠ 必须是字符串：宿主 `whoOf` 拿它当账号的「名字」去比对同一个账号
 * （settle / 同名合并），给个数字会让比较悄悄失配。
 */
export function accountLabelOf(user) {
  return String(user?.email || user?.name || user?.id || "Floatboat 账号")
}

/**
 * 用 token 补齐账号信息 + newapi key，拼成 magpie 的登录成功结果。
 * @param {{accessToken:string, refreshToken:string, expiresIn:number}} tokens
 * @param {{signal?:AbortSignal}} [o]
 */
async function completeLogin(tokens, { signal } = {}) {
  const user = await fetchUser(tokens.accessToken, { signal }).catch(() => null)

  let newapiKey = ""
  try {
    newapiKey = await fetchNewApiKey(tokens.accessToken, { signal })
  } catch {
    // 没有 key 也能登录（账号卡先出现），第一次对话时会再取一次
  }

  // uid 是厂商侧的账号身份（宿主只认 string，见契约 uidOf）
  const uid = String(user?.id || user?.email || "").trim() || randomUUID()

  return {
    type: "success",
    access: tokens.accessToken,
    refresh: tokens.refreshToken,
    // expires_in 是秒；magpie 要**毫秒时间戳**。
    // ⚠ 0 = 没有到期时间 → 宿主 `renewAt` 返回 0，这个账号永远不续期，
    //   只能等 401 触发重新登录。上游没给 expires_in 就是这种降级，别瞎填。
    expires: tokens.expiresIn ? Date.now() + tokens.expiresIn * 1000 : 0,
    accountId: accountLabelOf(user),
    uid,
    metadata: {
      // 只存插件真正会读回的那一个字段（gateway.mjs 的 keyFromAuth）
      newapiKey,
    },
  }
}

/** 用 code/state 完成一次登录 */
export async function loginWithCode({ code, state, deviceId, signal }) {
  const tokens = await exchangeCode({ code, state, deviceId: deviceId || newDeviceId(), signal })
  return completeLogin(tokens, { signal })
}
