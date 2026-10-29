import { DEFAULT_BASE_URL, TIMEOUT } from "./helpers.mjs"

export const SITE = new URL(DEFAULT_BASE_URL).origin

export async function accountRequest(path, { token, body } = {}) {
  const response = await fetch(`${SITE}/api/v1${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Accept: "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT),
  })
  const result = await response.json()
  if (!response.ok || result.code !== 0) {
    const error = new Error(`String AI: ${result.message || response.statusText}`)
    if (response.status === 401) error.signIn = "expired"
    throw error
  }
  return result.data
}

export function sessionAuth(session) {
  if (!session.access_token || !session.refresh_token || !(session.expires_in > 0)) {
    throw new Error("String AI 登录响应缺少登录凭据或有效期")
  }
  return {
    access: session.access_token,
    refresh: session.refresh_token,
    expires: Date.now() + session.expires_in * 1000,
  }
}

export async function readAccount(token) {
  const user = await accountRequest("/auth/me", { token })
  const keys = []
  const seen = new Set()
  let page = 1
  let pages
  do {
    const result = await accountRequest(`/keys?page=${page}&page_size=100`, { token })
    if (!Array.isArray(result.items) || !Number.isInteger(result.pages) || result.pages < 0) {
      throw new Error("String AI 密钥列表格式不正确")
    }
    pages = result.pages
    for (const item of result.items) {
      if (item.status !== "active" || item.is_hidden || (item.expires_at && Date.parse(item.expires_at) <= Date.now())) continue
      if (typeof item.key !== "string" || !item.key.startsWith("sk-") || item.key.includes("*")) {
        throw new Error("String AI 未返回完整 API Key，无法自动导入")
      }
      if (seen.has(item.key)) continue
      seen.add(item.key)
      keys.push({
        key: item.key,
        id: item.id,
        groupId: item.group_id,
        category: item.group?.platform,
        label: item.group?.name || item.name,
      })
    }
    page++
  } while (page <= pages)
  if (!keys.length) throw new Error("账号下没有可用 API Key，请先在 String AI 创建密钥")
  return { user, keys }
}
