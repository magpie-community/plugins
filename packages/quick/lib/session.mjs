// The Quick account: the cookie session imported from a browser, the
// account id and CSRF token (mbtc) discovered from it, and the /profile/usage
// probe that says whether the cookie still works.
//
// The session rides on Quick's browser-level cookies (verified: a bare
// quick.aws.com URL in a fresh tab auto-signs-in). The session cookies are
// httpOnly, so they cannot be read from page JavaScript — an import takes
// the Cookie header from the browser's DevTools (Network tab → any
// quick.aws.com request → Cookie) or a cookie-export extension.
//
// A pasted value is accepted as:
//   - a full Cookie header string (the fastest path: everything up to the
//     first line that isn't a cookie), or
//   - JSON {cookie, accountId, mbtc} for a hand-assembled account, or
//   - several accounts at once for the pool: a JSON array of those objects,
//     or one account per line (a line holds a Cookie header, optionally
//     followed by its accountId and mbtc).
// The account id and mbtc are then confirmed against the live account.

import { usageOf } from "./usage.mjs"

export const ORIGIN = "https://quick.aws.com"

// parseAccounts splits a paste into every account it holds: a JSON array of
// account objects, or one account per line for a pool. A plain single
// account — a Cookie header that may run over several lines, or one JSON
// object — stays one account: a paste is only a pool when its lines are
// independently cookie-like AND at least two of them are. Duplicated
// account ids keep their first occurrence — re-pasting the same pool must
// not double it.
export function parseAccounts(text) {
  const s = String(text ?? "").trim()
  if (!s) return []
  const seen = new Set()
  const push = (list, acct) => {
    if (!acct?.cookie) return
    const id = acct.accountId ?? ""
    const key = id || acct.cookie
    if (seen.has(key)) return
    seen.add(key)
    list.push(acct)
  }
  // a JSON array of accounts
  try {
    const j = JSON.parse(s)
    if (Array.isArray(j)) {
      const out = []
      for (const item of j) push(out, parseCookie(typeof item === "string" ? item : JSON.stringify(item)))
      return out
    }
  } catch {}
  // one account per line, but only when at least two lines hold an account
  // of their own — a single Cookie header with a URL line after it is one
  // account (the URL line carries the accountId/mbtc the header lacks).
  // A line that parses only because it contains a URL does not count as an
  // account on its own: URLs are not Cookie headers.
  const lines = s.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
  const perLine = []
  for (const l of lines) {
    if (/^https?:\/\//i.test(l)) continue
    push(perLine, parseCookie(l))
  }
  if (perLine.length > 1) return perLine
  const one = parseCookie(s)
  return one ? [one] : perLine
}

// parseCookie extracts a Cookie header from pasted text: either a JSON
// object with a cookie field, or a string that contains one. Returns
// {cookie, accountId?, mbtc?} or null when nothing cookie-like is found.
export function parseCookie(text) {
  const s = String(text ?? "").trim()
  if (!s) return null
  try {
    const j = JSON.parse(s)
    if (j && typeof j === "object") {
      const cookie = [j.cookie, j.Cookie, j.cookies].find((v) => typeof v === "string" && v.includes("="))
      if (cookie) return { cookie: cookie.trim(), accountId: j.accountId ?? j.account_id, mbtc: j.mbtc ?? j.csrf }
    }
  } catch {}
  // a cookie header: name=value pairs separated by "; " — a URL or URL
  // fragment line is not a Cookie header (its accountId/mbtc only add to a
  // cookie line)
  if (s.includes("=") && !s.includes("<") && !/^(https?:\/\/|[^;=\s]*\/)/.test(s)) {
    const cookie = s.split(/\r?\n/).find((l) => l.includes("="))?.trim() ?? ""
    if (cookie) {
      const acct = /account\/([0-9A-Za-z-]+)/.exec(s)?.[1]
      const mbtc = /[?&]mbtc=([^&\s]+)/.exec(s)?.[1]
      return { cookie, accountId: acct, mbtc }
    }
  }
  return null
}

// quickFetch does a qbsproxy call the way the web bridge does: POST with a
// _method override, the mbtc on the query, and the api target headers.
export async function quickFetch(account, path, { method = "GET", body } = {}) {
  const q = new URLSearchParams({ _method: method, surfaceType: "WEB_EXPERIENCE", appVersion: "qbiz-web-bridge", mbtc: account.mbtc })
  const res = await fetch(`${ORIGIN}/sn/account/${account.accountId}/qbsproxy${path}?${q}`, {
    method: "POST",
    headers: {
      Cookie: account.cookie,
      "content-type": "application/json",
      "x-amzn-target": "api",
      "X-Amzn-Web-Client-Version": "qbiz-web-bridge",
      Origin: ORIGIN,
      Referer: `${ORIGIN}/sn/account/${account.accountId}/start/chat`,
    },
    body: body === undefined ? "{}" : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  return res
}

// pageConfigOf reads a Quick page's embedded config: the <div
// id="page-config"> block is JSON with its quotes HTML-escaped
// (encoding="HTML_ESCAPE", &quot;). The signed-out landing page carries
// "csrf":null — a signed-in page is what carries the token.
export function pageConfigOf(html) {
  const m = /id="page-config"[^>]*>([\s\S]*?)<\//.exec(String(html ?? ""))
  if (!m) return null
  try {
    return JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"))
  } catch {
    return null
  }
}

// discoverAccount fills in what a bare cookie header lacks: the browser
// session itself says which account it belongs to, and the signed-in page
// carries the csrf (mbtc) in its page config — the same page the web app
// reads window.quickwork.getMbtc() from. The origin itself serves the
// QuickSuiteLanding shell, whose config has "csrf":null, so the account
// page is fetched directly (redirect: "manual" — a signed-out cookie lands
// on the sign-in surface and must be refused, not followed into a page
// that has no account id either). Both values are then confirmed by the
// caller's usage probe, exactly like a pasted account.
export async function discoverAccount(cookie, { accountId } = {}) {
  let id = String(accountId ?? "").trim()
  if (!id) {
    // no id given: ask the origin where this session lives — the redirect
    // (or the landing page for a signed-out cookie) says which
    const res = await fetch(`${ORIGIN}/sn/start`, {
      headers: { Cookie: cookie, "X-Amzn-Web-Client-Version": "qbiz-web-bridge" },
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    })
    if (res.status >= 400) throw new Error(`Quick: the session was refused (${res.status}) — the cookie did not sign in`)
    const to = res.headers.get("location") ?? res.url ?? ""
    const html = res.status < 300 ? await res.text() : ""
    id =
      /\/sn\/account\/([0-9A-Za-z-]+)\//.exec(to)?.[1] ??
      (html ? /\/sn\/account\/([0-9A-Za-z-]+)\//.exec(html)?.[1] : undefined) ??
      pageConfigOf(html)?.urlAccountId ??
      ""
    if (!id) throw new Error("Quick: the session did not land on an account page — the cookie may not be a Quick session")
  }
  // the signed-in page's config carries the csrf token
  const page = await fetch(`${ORIGIN}/sn/account/${id}/start/chat`, {
    headers: { Cookie: cookie, "X-Amzn-Web-Client-Version": "qbiz-web-bridge" },
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  })
  if (page.status >= 400) throw new Error(`Quick: the account page was refused (${page.status}) — the cookie did not sign in`)
  const html = await page.text()
  const mbtc = pageConfigOf(html)?.csrf
  if (typeof mbtc !== "string" || !mbtc)
    throw new Error("Quick: the session page carried no csrf token (mbtc) — the cookie may not be signed in; try the paste sign-in instead")
  return { cookie, accountId: id, mbtc }
}

// verifyAccount asks /profile/usage — the lightest authenticated call — and
// returns the account with its id, mbtc and identity confirmed, or throws
// with a message that says what to fix. account is {cookie, accountId?,
// mbtc?}; a missing accountId or mbtc can be recovered from the usage
// reply's headers/body when the paste carried them.
export async function verifyAccount(account) {
  if (!account?.cookie) throw new Error("Quick: no cookie in what was pasted — copy the Cookie header from DevTools")
  if (!account.mbtc) throw new Error("Quick: no mbtc (CSRF) token — it is the mbtc= value on any quick.aws.com request's query string, or window.quickwork.getMbtc() from the console")
  if (!account.accountId) throw new Error("Quick: no account id — it is the account/<id>/ part of any quick.aws.com URL")
  const res = await quickFetch(account, "/quicksight/user-experience/profile/usage")
  if (res.status === 401 || res.status === 403) throw new Error("Quick: the cookie or mbtc was refused (401) — re-copy both from a signed-in tab")
  if (!res.ok) throw new Error(`Quick: the usage probe answered ${res.status}`)
  const usage = await res.json().catch(() => ({}))
  return { ...account, usage }
}

// importAccount is the sign-in method's authorize(): it takes the pasted
// cookie material — one account or a pool of them — verifies each, and
// reports success the way OpenCode's OAuth methods do. A pool is saved as
// one credential whose metadata.accounts carries every member; the plugin's
// pool rotates among them.
export async function importAccount(inputs) {
  const accounts = parseAccounts(inputs?.account)
  if (!accounts.length) return { type: "failed", error: "no cookie found in what was pasted — paste the Cookie header from DevTools, one per line for a pool, or a JSON {cookie, accountId, mbtc}" }
  const verified = []
  const failed = []
  for (const parsed of accounts) {
    try {
      verified.push(await verifyAccount(parsed))
    } catch (e) {
      failed.push(`${parsed.accountId || "account"}: ${e?.message ?? String(e)}`)
    }
  }
  if (!verified.length) return { type: "failed", error: failed.join("; ") }
  const first = verified[0]
  const labelOf = (a) => a.accountId || "quick"
  return {
    type: "success",
    access: first.mbtc,
    refresh: first.cookie,
    expires: 0,
    accountId: first.accountId,
    name: verified.length > 1 ? `Quick pool (${verified.length} accounts)` : labelOf(first),
    metadata: {
      cookie: first.cookie,
      mbtc: first.mbtc,
      usage: first.usage,
      // the whole pool, first account first — the pool rotates through these
      accounts: verified.map((a) => ({ cookie: a.cookie, accountId: a.accountId, mbtc: a.mbtc, label: labelOf(a) })),
      ...(failed.length ? { importErrors: failed } : {}),
    },
  }
}

// stateOf reads the plugin's auth record back into an account object
export function stateOf(auth) {
  const md = auth?.metadata ?? {}
  const cookie = typeof md.cookie === "string" && md.cookie ? md.cookie : typeof auth?.refresh === "string" ? auth.refresh : ""
  const mbtc = md.mbtc ?? auth?.access ?? ""
  const accountId = auth?.accountId ?? ""
  if (!cookie || !mbtc || !accountId) return null
  return { cookie, mbtc, accountId, timezone: md.timezone, locale: md.locale }
}

// poolOf reads every account a credential holds: the metadata.accounts list
// when the sign-in imported a pool, else the one account. Members without a
// full triple are dropped; the list keeps the import's order.
export function poolOf(auth) {
  const md = auth?.metadata ?? {}
  const list = Array.isArray(md.accounts) ? md.accounts : []
  const accounts = list
    .map((a) => {
      const cookie = typeof a?.cookie === "string" ? a.cookie : ""
      const mbtc = typeof a?.mbtc === "string" ? a.mbtc : ""
      const accountId = typeof a?.accountId === "string" ? a.accountId : ""
      if (!cookie || !mbtc || !accountId) return null
      return { cookie, mbtc, accountId, label: a.label, timezone: md.timezone, locale: md.locale }
    })
    .filter(Boolean)
  if (accounts.length) return accounts
  const one = stateOf(auth)
  return one ? [one] : []
}
