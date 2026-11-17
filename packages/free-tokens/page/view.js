// 纯渲染逻辑（无 DOM/网络）。浏览器里作为 classic <script> 执行，挂到 window.FTView；
// Bun 单测 import 时挂到 globalThis.FTView（无导出，纯副作用）。
(function (root) {
  const KIND = { daily: "每天", monthly: "每月", once: "新人", limited: "限时", free: "免费" };
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const safeUrl = (u) => { try { const x = new URL(String(u || "")); return x.protocol === "https:" ? x.href : null; } catch { return null; } };
  const colorFor = (n) => { const P = ["#4f46e5", "#0d9488", "#b45309", "#7c3aed", "#be123c", "#0369a1", "#15803d", "#c2410c", "#9333ea", "#0f766e", "#b91c1c", "#1d4ed8"]; let h = 0; for (const c of String(n)) h = (h * 31 + c.codePointAt(0)) >>> 0; return P[h % P.length]; };
  const initials = (n) => { const s = String(n || "?").trim(); if (/^[\x00-\x7F]/.test(s)) { const w = s.split(/\s+/); return (w[0][0] + (w[1] ? w[1][0] : "")).toUpperCase(); } return s.slice(0, 1); };
  const fmtYuan = (y) => { const n = +y; if (!isFinite(n)) return ""; return n >= 100 ? String(Math.round(n)) : n.toFixed(2).replace(/\.?0+$/, ""); };
  function resolvePid(d, m) { const pid = m.pid; if (Array.isArray(pid)) { if (/qoder\.com/.test(d.url || "")) return "qoder"; if (/qoder\.cn/.test(d.url || "")) return "qoder-cn"; return pid[0]; } return pid; }
  function bucketOf(d, mapping, demoState) {
    const m = mapping[d.provider];
    if (!m) return { key: "none" };
    if (!demoState.configKnown) return { key: "setup", mode: "install", m, unknown: true };
    const st = demoState.installed[resolvePid(d, m)];
    if (!st) return { key: "setup", mode: "install", m };
    if (!st.signedIn) return { key: "setup", mode: "login", m };
    return { key: "ready", m, checkin: d.kind === "daily" ? st.checkin : null };
  }
  function counts(deals, mapping, demoState) { const c = { ready: 0, setup: 0, none: 0 }; for (const d of deals) c[bucketOf(d, mapping, demoState).key]++; return c; }
  function avatarHtml(provider, icons) { const src = icons[provider]; if (src) return `<div class="avatar logo" data-ini="${esc(initials(provider))}" data-col="${colorFor(provider)}"><img src="${esc(src)}" alt=""></div>`; return `<div class="avatar gen" style="background:${colorFor(provider)}">${esc(initials(provider))}</div>`; }
  function summaryHtml(meta, total, c) { return `今天还能领 <b>¥${esc(meta.todayClaimable)}</b><span class="sep">·</span>共 <b>${total}</b> 项羊毛<span class="sep">·</span>已配置可用 <b>${c.ready}</b> · 待配置 <b>${c.setup}</b> · 暂无插件 <b>${c.none}</b>`; }
  // 安装/登录气泡的文案（纯函数，便于单测：确保用完整 npm 包名，不用短名）
  function installSteps(npm) { return ["在 magpie「插件 → 发现」页最下方「已有想装的?」输入框，粘贴下面的包名，点「安装」", `（终端方式：magpie plugin add ${npm}）`]; }
  function loginSteps(name, pid) { return [`magpie →「插件 → 已安装」，找到「${name}」那一行`, "点该行「登录」，按提示完成（浏览器 / 设备码）"]; }
  function actionOf(ds) {
    if (!ds || !ds.act) return null;
    if (ds.act === "install") return { title: `安装插件：${ds.name}`, steps: installSteps(ds.npm), copyText: ds.npm };
    if (ds.act === "login") return { title: `登录：${ds.name}`, steps: loginSteps(ds.name, ds.pid), copyText: ds.pid ? `magpie plugin login ${ds.pid}` : "" };
    if (ds.act === "copy") { const url = safeUrl(ds.url); return url ? { title: "来源链接", steps: ["页面沙盒不能直接打开外链，复制后到浏览器打开。"], copyText: url } : null; }
    return null;
  }
  function rowHtml(d, ctx) {
    const { mapping, demoState, icons } = ctx;
    const b = bucketOf(d, mapping, demoState);
    const yuan = d.yuan != null ? `¥${fmtYuan(d.yuan)}` : (d.label || d.face || "");
    const yuanSub = d.yuan != null && (d.label || d.face) ? `<small>${esc(d.label || d.face)}</small>` : "";
    const url = safeUrl(d.url);
    let sub = "", act = "";
    if (b.key === "ready") {
      if (d.kind === "daily" && b.checkin != null) {
        if (b.checkin === "claimed" || b.checkin === "done") sub = `<span class="dot ok"></span>今日已领`;
        else if (b.checkin === "none") sub = `<span class="dot warn"></span>今日可领`;
        else sub = `<span class="dot ok"></span>可用`;
      } else sub = `<span class="dot ok"></span>可用`;
    } else if (b.key === "setup") {
      sub = `<span class="dot mut"></span>插件：${esc(b.m.name)}`;
      const pid = resolvePid(d, b.m);
      act = `<button class="cta primary" data-act="${b.mode}" data-name="${esc(b.m.name)}" data-npm="${esc(b.m.npm)}" data-pid="${esc(pid)}">${b.mode === "login" ? "去登录" : "安装插件"}</button>`;
    } else {
      sub = `<span class="dot mut"></span>暂无可用插件`;
      act = url ? `<button class="cta" data-act="copy" data-url="${esc(url)}">复制链接</button>` : "";
    }
    return `<div class="row">${avatarHtml(d.provider, icons)}<div class="rmain"><div class="rprov">${esc(d.provider)} <span class="tag">${esc(KIND[d.kind] || d.kind || "")}</span></div><div class="rtitle">${esc(d.title)}</div><div class="rsub">${sub}</div></div><div class="rright"><div class="rval">${esc(yuan)}${yuanSub}</div>${act}</div></div>`;
  }
  const api = { KIND, esc, safeUrl, colorFor, initials, fmtYuan, resolvePid, bucketOf, counts, avatarHtml, summaryHtml, installSteps, loginSteps, actionOf, rowHtml };
  root.FTView = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
