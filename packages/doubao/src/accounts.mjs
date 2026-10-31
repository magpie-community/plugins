// 多账号轮换与登录态检测。
import { BASE_URL, baseHeaders, DoubaoError } from "./http.mjs";

let cursor = 0;

/**
 * 生成尝试顺序：preferred（如指定）最优先，然后从轮换游标开始铺满全部账号。
 * 同一进程内游标自增，多次调用自动分摊额度。
 */
export function accountOrder(accounts, preferred) {
  if (!accounts.length) {
    throw new DoubaoError(
      "未配置豆包账号。",
      "把 doubao.com 网页版 Cookie 里的 sessionid 写入插件目录 config.json（参考 config.example.json），或设置环境变量 DOUBAO_ACCOUNTS=\"主号:sessionid=xxx\"。",
    );
  }
  const rest = accounts.slice();
  const ordered = [];
  if (preferred) {
    const idx = rest.findIndex((a) => a.name === preferred || a.sessionid === preferred);
    if (idx >= 0) ordered.push(...rest.splice(idx, 1));
  }
  for (let i = 0; i < rest.length; i++) {
    ordered.push(rest[(cursor + i) % rest.length]);
  }
  cursor += 1;
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
