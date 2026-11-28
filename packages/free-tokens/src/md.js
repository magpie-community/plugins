// AIHOT 开放入口 https://aihot.news/free-tokens.md 的解析器（零依赖）。
// 结构（2026-11-28 实测）：
//   # 标题 / 「- 更新：…」「- 折价：…（1 美元约合 6.65 元）…」
//   ## 每天都能领（15 个） / ## 每周都能领 / ## 每月都能领 / ## 其他福利 / ## 回答提示
//   ### <羊毛标题>，下面每行一个「- 键：值」：提供方 / 能领多少 / 怎么领 / 能用在 / 门槛 / 有效期 / 截止 / 核实 / 去领
// 产出与原 free-tokens.data 解码后同形的 { deals, basis, updatedAt }，交给 classify.buildPayload。

const SECTION_KIND = [[/每天/, "daily"], [/每周/, "weekly"], [/每月/, "monthly"]];
const ONCE = /新用户|新人|新客|新账号|首次|首月|注册|在读学生|试用|体验卡|升级礼|报名/;
const LIMITED = /限时|限免|活动期间/;

// 「2026-11-23 22:06（北京时间）；官方页面」→ ISO（+08:00）；认不出就 null
export function bjTime(s) {
  const m = /(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{2}):(\d{2}))?/.exec(String(s || ""));
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4] || "23"}:${m[5] || "59"}:00+08:00`;
}

// 「≈¥333（每月 · 50 美元，按模型榜汇率）」→ { yuan: 333, face: "50 美元", label: "" }
// 「100 积分（每天 · 暂无…，暂不折价）」→ { yuan: null, face: "", label: "100 积分" }
export function amountOf(s) {
  const str = String(s || "").trim();
  const i = str.indexOf("（");
  const main = (i >= 0 ? str.slice(0, i) : str).trim();
  const paren = i >= 0 ? str.slice(i + 1).replace(/）\s*$/, "") : "";
  const m = /^≈?\s*¥\s*([\d.]+)/.exec(main);
  if (!m || !isFinite(+m[1])) return { yuan: null, face: "", label: main };
  // 括号里第一段（去掉「每天 / 每月」和「面值」）是原始面额
  const parts = paren.split("·").map((x) => x.trim()).filter((x) => x && !/^每[天周月]$/.test(x));
  const face = parts.length ? parts[0].split("，")[0].trim() : "";
  return { yuan: +m[1], face: face === "面值" ? "" : face, label: "" };
}

function kindOf(section, d) {
  for (const [re, k] of SECTION_KIND) if (re.test(section)) return k;
  // 新人福利看标题（门槛里常有「无需注册」，不能拿来判断）
  if (ONCE.test(d.title)) return "once";
  if (LIMITED.test(d.title + " " + (d.fields["门槛"] || "") + " " + (d.fields["能领多少"] || "")) || d.fields["截止"]) return "limited";
  if (/^免费/.test(d.fields["能领多少"] || "")) return "free";
  return "once";
}

function toDeal(section, d) {
  const f = d.fields;
  const amt = amountOf(f["能领多少"]);
  const tags = String(f["门槛"] || "").split("、").map((x) => x.trim()).filter(Boolean);
  return {
    id: d.title,
    kind: kindOf(section, d),
    title: d.title,
    provider: String(f["提供方"] || "").trim(),
    detail: f["怎么领"] || "",
    scope: f["能用在"] || "",
    url: (String(f["去领"] || "").match(/https:\/\/\S+/) || [null])[0],
    tags,
    endsAt: bjTime(f["截止"]),
    validity: f["有效期"] || "",
    verifiedAt: bjTime(f["核实"]),
    yuan: amt.yuan,
    label: amt.label,
    face: amt.face,
    counted: amt.yuan != null,
  };
}

export function parseFreeTokensMd(text) {
  const src = String(text == null ? "" : text).replace(/\r\n?/g, "\n");
  if (!/^#\s/m.test(src) || !/^##\s/m.test(src)) throw new Error("free-tokens.md 内容异常（没有标题或分区）");
  const sections = []; // { name, declared, deals: [] }
  let sec = null, deal = null, last = null;
  const head = {};
  for (const line of src.split("\n")) {
    let m;
    if ((m = /^##\s+(.+?)\s*$/.exec(line))) {
      const c = /（(\d+)\s*个）/.exec(m[1]);
      sec = { name: m[1], declared: c ? +c[1] : null, deals: [] };
      sections.push(sec); deal = null; last = null; continue;
    }
    if ((m = /^###\s+(.+?)\s*$/.exec(line))) {
      deal = { title: m[1], fields: {} }; last = null;
      if (sec) sec.deals.push(deal);
      continue;
    }
    if ((m = /^-\s+([^：\s]{1,8})：\s*(.*)$/.exec(line))) {
      const tgt = deal ? deal.fields : (sec ? null : head);
      if (tgt) { tgt[m[1]] = m[2].trim(); last = { tgt, k: m[1] }; }
      continue;
    }
    // 续行（值折到下一行）接在上一个字段后面
    if (line.trim() && last && !/^[#-]/.test(line.trim())) last.tgt[last.k] += " " + line.trim();
  }
  const dealSecs = sections.filter((s) => s.deals.length || s.declared != null);
  // 声明的条数对不上 = 正文被截断（或格式变了）：宁可报错保留上次的数据，也不显示残缺的列表
  for (const s of dealSecs) {
    if (s.declared != null && s.deals.length !== s.declared) throw new Error(`free-tokens.md 不完整：「${s.name}」应有 ${s.declared} 条，读到 ${s.deals.length} 条`);
  }
  const all = dealSecs.flatMap((s) => s.deals.map((d) => [s.name, d]));
  if (!all.length) throw new Error("free-tokens.md 里没有羊毛（deals 未找到）");
  const tail = all[all.length - 1][1];
  if (!tail.fields["去领"] && sections[sections.length - 1].deals.includes(tail)) throw new Error("free-tokens.md 不完整：最后一条在中途断了");
  const usd = /1\s*美元约合\s*([\d.]+)\s*元/.exec(head["折价"] || "");
  return {
    deals: all.map(([name, d]) => toDeal(name, d)),
    basis: usd ? { usdCny: +usd[1] } : null,
    updatedAt: bjTime(head["更新"]),
  };
}
