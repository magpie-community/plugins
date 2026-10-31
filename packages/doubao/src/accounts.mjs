// 多账号管理：固定使用第一个账号，仅在登录失效时切换到下一个（不做额度摊薄式轮换）。
import { BASE_URL, baseHeaders, DoubaoError } from "./http.mjs";

/**
 * 生成尝试顺序：配置顺序即优先级（第一个账号始终优先），不做游标轮换。
 * preferred 只按账号名匹配。
 */
export function accountOrder(accounts, preferred) {
  if (!accounts.length) {
    throw new DoubaoError(
      "未配置豆包账号。",
      "运行 magpie plugin login doubao 扫码登录，或设置环境变量 DOUBAO_ACCOUNTS=\"主号:sessionid=xxx\"。",
    );
  }
  const rest = accounts.slice();
  const ordered = [];
  if (preferred) {
    const idx = rest.findIndex((a) => a.name === preferred);
    if (idx >= 0) ordered.push(...rest.splice(idx, 1));
  }
  ordered.push(...rest);
  return ordered;
}

/** 检测单个账号登录态：/passport/account/info/v2 返回 user_id 即存活。 */
export async function checkAccount(account) {
  try {
    const resp = await fetch(`${BASE_URL}/passport/account/info/v2`, {
      method: "POST",
      headers: baseHeaders(account, { "Content-Type": "application/x-www-form-urlencoded" }),
      body: "",
      signal: AbortSignal.timeout(15_000),
    });
    const text = await resp.text();
    let userId = "";
    let userName = "";
    try {
      const body = JSON.parse(text);
      const data = body.data || body;
      userId = String(data.user_id ?? "");
      userName = String(data.name ?? data.user_name ?? "");
    } catch {
      // 非 JSON 响应视为失效
    }
    return { name: account.name || "(未命名)", live: Boolean(userId), userId, userName };
  } catch (err) {
    return { name: account.name || "(未命名)", live: false, error: err.message };
  }
}

export async function checkAllAccounts(accounts) {
  return Promise.all(accounts.map(checkAccount));
}
