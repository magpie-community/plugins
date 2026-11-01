// Doubao (doubao.com) daily web check-in for experience credits.
//
// Ported from CreditDaddy's doubaoClient.js. The web campaign endpoints give
// a daily +200 experience-credit grant when the account's session cookie is
// valid; the server is idempotent (re-claiming returns idempotent:true).
//
// NOTE (verify before publishing): sign-in here captures the doubao.com
// session cookie through an `api`-type method whose text prompt stores the
// cookie in `auth.key`. Magpie's exact storage of a custom prompted value
// should be confirmed against the running host; the loader/checkin below
// read `auth.key` as the cookie. Doubao's web credits are NOT an agent API —
// the `provider.models` list is informational; point an agent at Volcengine
// Ark separately for real Doubao/Seed model access.

import { createHash } from "node:crypto"

const DETAIL_URL = "https://www.doubao.com/alice/ug/campaign/v3/detail/"
const CHECKIN_URL = "https://www.doubao.com/alice/ug/campaign/landing/checkin"
const CAMPAIGN_GROUP = "pc_incentive_task_mvp_v3"
const LOGIN_INVALID = 710012001

const CLIENT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) DoubaoDesktop/2.32.6 Chrome/147.0.7727.149 Safari/537.36"
const COMMON_PARAMS = {
  version_code: "20800",
  language: "zh",
  device_platform: "web",
  doubao_device_platform: "web",
  aid: "497858",
  real_aid: "497858",
  pkg_type: "release_version",
  pc_version: "2.32.6",
  doubao_pc_version: "5.72.66",
  samantha_web: "1",
  web_platform: "desktop",
  "use-olympus-account": "1",
  web_tab_id: "0",
}

function deviceIdsFor(uid) {
  const seed = createHash("sha256").update(`doubao-dev:${uid || "anonymous"}`).digest()
  const webId = "76" + [...seed.subarray(0, 8)].map((b) => b % 10).join("")
  const teaUuid = [...seed.subarray(8, 16)].map((b) => b % 10).join("").padEnd(16, "7")
  return { web_id: webId, tea_uuid: teaUuid }
}

function apiUrl(base, uid) {
  const params = new URLSearchParams({ ...COMMON_PARAMS, ...deviceIdsFor(uid), device_id: "", region: "", sys_region: "" })
  return base + "?" + params.toString()
}

async function postJson(url, cookie, body, uid, timeoutMs = 20000) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Cookie: String(cookie || ""),
        "Content-Type": "application/json",
        Accept: "application/json, text/plain, */*",
        Referer: "https://www.doubao.com/pc/agent-explore",
        Origin: "https://www.doubao.com",
        "User-Agent": CLIENT_UA,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    return res
  } finally {
    clearTimeout(t)
  }
}

function findCheckinTask(body) {
  const tasks = body?.data?.tasks
  if (!Array.isArray(tasks)) return null
  return tasks.find((t) => t && t.task_kind === "daily_signin") || null
}

async function fetchDoubaoStatus(cookie, uid) {
  const res = await postJson(apiUrl(DETAIL_URL, uid), cookie, { campaign_group_code: CAMPAIGN_GROUP }, uid)
  let body = null
  try {
    body = JSON.parse(await res.text())
  } catch {}
  if (!body || typeof body !== "object") return { auth: false, code: `HTTP ${res.status}`, checkin: null, totalAmount: null }
  const code = Number(body.code)
  if (code === LOGIN_INVALID) return { auth: false, code, checkin: null, totalAmount: null }
  const task = findCheckinTask(body)
  const c = task?.daily_checkin || {}
  return {
    auth: true,
    code,
    checkin: task
      ? {
          checkedIn: c.checked_in_today === true,
          continuousDays: Number(c.continuous_days) || 0,
          lastDate: typeof c.last_checkin_date === "string" ? c.last_checkin_date : null,
          rewardAmount: Number(c.reward?.reward_amount) || 0,
        }
      : null,
    totalAmount: Number(body.data?.progress?.total_amount) || 0,
  }
}

async function checkinDoubao(cookie, uid) {
  const st = await fetchDoubaoStatus(cookie, uid)
  if (!st.auth) throw Object.assign(new Error("豆包会话已失效，请重新登录捕获"), { auth: true })
  if (st.checkin?.checkedIn) return { outcome: "already", message: "今天已签到" }
  if (!st.checkin) return { outcome: "ineligible", message: "当前账号无签到任务（活动未开放或企业账号不支持）" }
  const res = await postJson(apiUrl(CHECKIN_URL, uid), cookie, { scene: CAMPAIGN_GROUP }, uid)
  const body = JSON.parse(await res.text())
  const code = Number(body.code)
  if (code === LOGIN_INVALID) throw Object.assign(new Error("豆包会话已失效，请重新登录捕获"), { auth: true })
  if (code !== 0) return { outcome: "failed", message: `${body.msg || body.message || "签到失败"}（code ${code}）` }
  const d = body.data || {}
  if (d.idempotent === true) return { outcome: "already", message: "今天已签到（服务端幂等去重）" }
  const amount = Number(d.reward_amount) || st.checkin.rewardAmount || 200
  const days = Number(d.continuous_days) || st.checkin.continuousDays + 1
  return { outcome: "checked-in", message: `签到成功，+${amount} 额度（连续 ${days} 天）` }
}

const DOUBAO_MODELS = {
  "doubao-seed-1.6": { name: "Doubao Seed 1.6", context: 256000 },
  "doubao-1.5-pro": { name: "Doubao 1.5 Pro", context: 256000 },
  "doubao-1.5-lite": { name: "Doubao 1.5 Lite", context: 256000 },
  "doubao-pro-32k": { name: "Doubao Pro 32k", context: 32000 },
}

export const DoubaoAuthPlugin = async () => ({
  config: async (config) => {
    config.provider ??= {}
    config.provider.doubao ??= {}
    const p = config.provider.doubao
    p.name ??= "Doubao"
    p.npm ??= "@magpie-community/opencode-doubao-auth"
    p.api ??= "https://www.doubao.com"
    p.models = { ...(p.models ?? {}), ...DOUBAO_MODELS }
  },
  provider: {
    id: "doubao",
    // Doubao's web experience credits are not an agent API; this list is
    // informational. Use Volcengine Ark (api.volcengine.com) for real access.
    models: DOUBAO_MODELS,
  },
  auth: {
    provider: "doubao",
    methods: [
      {
        type: "api",
        label: "会话 Cookie",
        prompts: [{ type: "text", key: "cookie", message: "粘贴豆包（doubao.com）网页会话 Cookie" }],
      },
    ],
    async loader(getAuth) {
      const auth = await getAuth()
      if (auth?.type !== "api" || !auth.key) return {}
      return {
        baseURL: "",
        apiKey: "",
        headers: { Cookie: String(auth.key), "User-Agent": CLIENT_UA },
      }
    },
    async checkin(getAuth) {
      const auth = await getAuth()
      const cookie = auth?.key
      if (!cookie) return { outcome: "failed", message: "未提供豆包会话 Cookie" }
      try {
        return await checkinDoubao(cookie, auth?.uid || "")
      } catch (e) {
        if (e.auth) return { outcome: "failed", message: e.message }
        throw e
      }
    },
    async getInfo(auth) {
      const cookie = auth?.key
      if (!cookie) return { error: "not signed in", signIn: "kept" }
      try {
        const st = await fetchDoubaoStatus(cookie, auth?.uid || "")
        if (!st.auth) return { error: "会话已失效", signIn: "expired" }
        return {
          plan: "Web 体验额度",
          windows: st.checkin
            ? [
                {
                  name: "今日签到",
                  total: 100,
                  used: st.checkin.checkedIn ? 100 : 0,
                  remaining: st.checkin.checkedIn ? 0 : 100,
                  unit: "%",
                  recurring: true,
                },
              ]
            : [],
          signIn: "kept",
        }
      } catch (e) {
        return { error: e?.message ?? String(e), signIn: "kept" }
      }
    },
  },
})
