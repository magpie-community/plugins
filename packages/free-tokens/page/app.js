// Token 羊毛 · 紧凑三档视图（classic script；只读；跟随 magpie 主题；无外链、无网络请求）。
// 依赖先加载的 view.js（window.FTView）。用 classic 而非 module：magpie 页面 frame 为 sandbox=allow-scripts，
// origin 为 null，module script 走 CORS 会被拒（见 review）。
(function () {
  "use strict";
  if (!window.FTView) { document.addEventListener("DOMContentLoaded", () => { const el = document.getElementById("list"); if (el) el.innerHTML = '<div class="empty">页面资源加载失败（view.js 未加载）</div>'; }); return; }
  const V = window.FTView;
  const { esc, bucketOf, counts, summaryHtml, rowHtml, actionOf } = V;

  const hasBridge = typeof window.magpie !== "undefined" && window.magpie && window.magpie.ready;
  function previewBridge() { const dark = window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches; return { ready: Promise.resolve({ dark }), theme: { dark }, options: { get: async () => ({}), set: async (o) => o }, read: async () => ({}), onTheme() {} }; }
  const MAG = hasBridge ? window.magpie : previewBridge();

  const TABS = [["ready", "已配置可用", "已装好并登录，可直接用"], ["setup", "有插件待配置", "有插件，还没装或没登录"], ["none", "暂无插件", "还没有对应的 magpie 插件"]];
  const TAB_HINT = {
    ready: "这些羊毛对应的供应商已在你的 magpie 里登录，可以直接使用；标「今日可领」的记得去签到。",
    setup: "点「安装插件」会给出可粘贴的包名；到 magpie「插件 → 发现 → 已有想装的?」粘贴添加（页面无法直接跳转安装）。",
    none: "这些还没有对应的 magpie 插件；「复制链接」可在浏览器打开来源。",
  };

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  let meta, deals, mapping, demoState, icons = {};
  let DATA_REF = null, wired = false;
  const state = { tab: "ready", q: "" };
  function applyData(d) { meta = d.meta || {}; deals = Array.isArray(d.deals) ? d.deals : []; mapping = d.mapping || {}; demoState = d.demoState || { installed: {}, configKnown: true, checkinKnown: true }; icons = d.icons || {}; DATA_REF = d; }
  function showUnavailable() { applyData({ meta: {}, deals: [], mapping: {}, demoState: { installed: {}, configKnown: true, checkinKnown: true } }); showMessage("数据源暂不可用（AIHOT 无法访问）。稍后重试。"); }

  function applyTheme(dark) { document.documentElement.dataset.theme = dark ? "dark" : "light"; }
  function renderSummary(c) { $("#summary").innerHTML = summaryHtml(meta, deals.length, c); }
  function renderBuckets(c) { const el = $("#buckets"); el.innerHTML = TABS.map(([k, label]) => `<button type="button" class="tile ${state.tab === k ? "on" : ""}" data-tab="${k}" aria-pressed="${state.tab === k}"><span class="k">${esc(label)}</span><span class="v">${c[k]}</span></button>`).join(""); $$(".tile", el).forEach((b) => (b.onclick = () => { state.tab = b.dataset.tab; render(); })); }
  function renderList() {
    const q = state.q.trim().toLowerCase();
    const rows = deals.filter((d) => bucketOf(d, mapping, demoState).key === state.tab)
      .filter((d) => !q || (d.provider + " " + d.title + " " + (d.tags || []).join(" ")).toLowerCase().includes(q))
      .sort((a, b) => (b.yuan || 0) - (a.yuan || 0) || a.provider.localeCompare(b.provider));
    const list = $("#list"); list.innerHTML = rows.map((d) => rowHtml(d, { mapping, demoState, icons })).join("");
    $("#empty").style.display = rows.length ? "none" : "block";
    $$(".avatar.logo img", list).forEach((img) => img.addEventListener("error", () => { const d = img.parentNode; d.className = "avatar gen"; d.style.background = d.getAttribute("data-col") || "#4f46e5"; d.textContent = d.getAttribute("data-ini") || "?"; }));
    $$("[data-act]", list).forEach((btn) => btn.addEventListener("click", (e) => { e.stopPropagation(); onAction(btn); }));
  }
  function render() {
    if (!deals) return;
    const c = counts(deals, mapping, demoState); renderSummary(c); renderBuckets(c);
    $("#tabhint").innerHTML = esc(TAB_HINT[state.tab] || ""); renderList();
    let when = ""; try { when = new Date(meta.generatedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }); } catch { when = String(meta.generatedAt); }
    const warn = demoState.configKnown ? "" : " · 读取本机 magpie 配置失败，档位可能不准";
    $("#footNote").textContent = `三档：已配置可用 / 有插件待配置 / 暂无插件；数据取自 AIHOT 实时 · ${when}（北京时间）${warn}。数据源：AIHOT · https://aihot.news/free-tokens`;
  }
  function showMessage(msg) { $("#list").innerHTML = `<div class="empty">${esc(msg)}</div>`; $("#empty").style.display = "none"; }

  function onAction(btn) { const a = actionOf(btn.dataset); if (a) popover(a); }

  async function copyText(txt) { try { if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(txt); return true; } } catch {} try { const ta = document.createElement("textarea"); ta.value = txt; ta.style.position = "fixed"; ta.style.top = "-1000px"; document.body.appendChild(ta); ta.focus(); ta.select(); const ok = document.execCommand("copy"); ta.remove(); return ok; } catch { return false; } }
  function closePop() { const p = $("#pop-wrap"); if (p) p.remove(); }
  function popover({ title, steps, copyText: ct }) {
    closePop();
    const wrap = document.createElement("div"); wrap.id = "pop-wrap"; wrap.className = "pop-wrap";
    wrap.innerHTML = `<div class="pop"><div class="pop-h">${esc(title)}</div>${steps && steps.length ? `<ol class="pop-steps">${steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>` : ""}${ct ? `<div class="pop-copy"><input readonly value="${esc(ct)}" spellcheck="false"><button class="pop-btn" data-copy>复制</button></div><div class="pop-tip" data-tip></div>` : ""}<div class="pop-foot"><button class="pop-close">关闭</button></div></div>`;
    document.body.appendChild(wrap);
    const input = wrap.querySelector("input"), tip = wrap.querySelector("[data-tip]");
    if (input) { input.focus(); input.select(); const tryCopy = async () => { const ok = await copyText(ct); if (tip) tip.textContent = ok ? "已复制到剪贴板" : "已全选，请按 ⌘C / Ctrl+C 手动复制"; }; tryCopy(); wrap.querySelector("[data-copy]").onclick = async () => { await tryCopy(); input.focus(); input.select(); }; }
    wrap.querySelector(".pop-close").onclick = closePop;
    wrap.addEventListener("click", (e) => { if (e.target === wrap) closePop(); });
  }

  function wire() { if (wired) return; wired = true; $("#q").addEventListener("input", (e) => { state.q = e.target.value; renderList(); }); }
  function boot() { const d = window.__FREE_TOKENS__; if (!d) return false; if (d.error) { showUnavailable(); return true; } applyData(d); render(); return true; }
  let tick = 0, tried = 0;
  function inject() {
    if (!hasBridge) return;
    const s = document.createElement("script"); s.src = "data.js?t=" + Date.now() + "-" + (tick++);
    s.onload = () => { const d = window.__FREE_TOKENS__; if (!d || d === DATA_REF) return; if (d.error) { showUnavailable(); } else { applyData(d); render(); } };
    s.onerror = () => {};
    document.head.appendChild(s);
  }

  MAG.ready.then((theme) => {
    applyTheme(!!(theme && theme.dark));
    if (MAG.onTheme) MAG.onTheme((t) => applyTheme(!!(t && t.dark)));
    wire();
    if (hasBridge) {
      inject();
      // 仅在有需要时重试几次（宿主可能稍后才写 data.js），不无限轮询
      const timer = setInterval(() => {
        const d = window.__FREE_TOKENS__;
        if (DATA_REF || (d && d.error) || ++tried >= 8) { clearInterval(timer); return; }
        inject();
      }, 2000);
    }
    if (!boot()) { showMessage("数据准备中…"); setTimeout(() => { if (!DATA_REF) { const d = window.__FREE_TOKENS__; if (d && d.error) showUnavailable(); else showMessage("数据未就绪（请确认 AIHOT 可访问后重新打开此页）。"); } }, 16000); }
  });
})();
