// 本文由AI自动生成
// 面板前端。无框架、无依赖：数据来自 /api/board，一次请求喂满三个页签。
//
// 关于「跨源」：这个页面跑在 magpie 给的 sandbox 框架里，origin 是 opaque
// （浏览器发出去的 Origin 就是字面量 "null"），所以即使文档地址是 127.0.0.1:3488，
// 请求也算跨源。服务端为此放行了 null 并用 CORS 头回话，另外要一道口令 ——
// 口令在服务端发这份 HTML 时注入 <meta>，见 index.mjs 的 injectToken。
//
// 两条自我约束：
//   1) 排名用 magpie 自己写进日志的 pace 值，不改写、不重排成「我以为的顺序」之外的解读；
//      重排只按 pace 降序（策略的定义），并把「下一次会先用谁」单独标出来。
//   2) 任何数字都带时间。额度是缓存，快照是旧的，绝不把旧数画得像刚测出来。

const state = {
  data: null,
  tab: "rank",
  loading: false,
  error: "",
  refreshing: false,
  refreshNote: "",
  prefs: { version: 1, autoRefreshMs: 300000 },
  refreshTimer: null,
};

// 这个页面 origin 是 opaque，任何 Storage API 都会抛 SecurityError。
// 自动重载只用内存标志，每个文档生命周期最多一次。
let reloadTried = false;

const $ = (sel) => document.querySelector(sel);

const TOKEN = document.querySelector('meta[name="pace-token"]')?.content || "";

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function num(v, digits = 0) {
  if (v == null || !Number.isFinite(Number(v))) return "—";
  const n = Number(v);
  const abs = Math.abs(n);
  if (abs >= 1e6) return (n / 1e6).toFixed(abs >= 1e7 ? 0 : 1) + "M";
  const d = abs >= 100 ? 0 : abs >= 10 ? Math.max(digits, 1) : 2;
  return n.toLocaleString("zh-CN", { minimumFractionDigits: 0, maximumFractionDigits: d });
}

function ago(hours) {
  if (hours == null || !Number.isFinite(hours)) return "时间未知";
  if (hours < 0) return hours > -0.05 ? "刚刚" : `时间超前 ${Math.abs(hours * 60).toFixed(0)} 分钟`;
  if (hours < 1 / 60) return "刚刚";
  if (hours < 1) return `${Math.round(hours * 60)} 分钟前`;
  if (hours < 48) return `${hours.toFixed(1)} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

function daysText(d) {
  if (d == null || !Number.isFinite(d)) return "无到期日";
  if (d <= 0) return "已到期";
  if (d < 1) return `${(d * 24).toFixed(1)} 小时后`;
  return `${d.toFixed(1)} 天后`;
}

function md(iso) {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ── 主题与页签 ─────────────────────────────── */
function applyTheme() {
  const q = new URLSearchParams(location.search);
  const t = q.get("theme");
  if (t === "dark" || t === "light") document.documentElement.dataset.theme = t;
  else if (window.matchMedia?.("(prefers-color-scheme: dark)").matches)
    document.documentElement.dataset.theme = "dark";
}

function switchTab(name) {
  state.tab = name;
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("is-on", b.dataset.tab === name));
  document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("is-on", p.id === `panel-${name}`));
}

/* ── 数据 ───────────────────────────────────── */
async function load() {
  if (state.loading) return;
  state.loading = true;
  try {
    const res = await fetch("/api/board", {
      cache: "no-store",
      credentials: "omit",
      headers: TOKEN ? { "x-pace-token": TOKEN } : {},
    });
    if (res.status === 401) {
      if (!reloadTried) {
        reloadTried = true;
        location.reload();
        return;
      }
      throw new Error("口令对不上：请关掉页签，从插件侧栏重新打开 Pace Board");
    }
    if (res.status === 403) throw new Error("被服务端挡在门外（Host/Origin 不是本机回环）");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.data = await res.json();
    state.error = "";
  } catch (err) {
    // WebKit 把「连接失败 / 跨源被拒」统一说成 Load failed，光这一句没法排查，
    // 所以把可能的成因一起摆出来（真正的原因看 magpie 日志里的 [pace-board] 行）。
    const raw = err?.message || String(err);
    state.error = /insecure|securityerror|storage/i.test(raw)
      ? "浏览器限制了本地存储，已改用内存状态；请重开页签"
      : raw === "Load failed" || raw === "Failed to fetch"
        ? "取数失败（浏览器只说 Load failed）。检查 magpie 日志里 [pace-board] 那几行，或点「重试」。"
        : raw;
  } finally {
    state.loading = false;
    render();
  }
}

/* ── 自动刷新 ───────────────────────────────── */
async function api(path, { method = "GET", body, headers = {} } = {}) {
  const res = await fetch(path, {
    method,
    cache: "no-store",
    credentials: "omit",
    headers: { ...(TOKEN ? { "x-pace-token": TOKEN } : {}), ...headers },
    body,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function rebuildTimer() {
  if (state.refreshTimer) {
    clearInterval(state.refreshTimer);
    state.refreshTimer = null;
  }
  const ms = Number($("#autoRefresh")?.value || 0);
  if (ms > 0) state.refreshTimer = setInterval(() => doRefresh(false), ms);
}

async function loadPrefs() {
  try {
    state.prefs = await api("/api/prefs");
  } catch {
    state.prefs = { version: 1, autoRefreshMs: 300000 };
  }
  const sel = $("#autoRefresh");
  if (sel) sel.value = String(state.prefs.autoRefreshMs);
  rebuildTimer();
}

async function doRefresh() {
  if (state.refreshing) return;
  state.refreshing = true;
  let unavailable = false;
  const btn = $("#refreshBtn");
  if (btn) {
    btn.classList.add("is-busy");
    btn.disabled = true;
  }
  try {
    const group = state.data?.group?.id || "";
    const result = await api(`/api/refresh?group=${encodeURIComponent(group)}`, { method: "POST" });
    if (result.board) {
      state.data = result.board;
      state.error = "";
    }
    state.refreshNote = result.note || "";
    if (result.status === "unavailable") {
      unavailable = true;
      if (state.refreshTimer) {
        clearInterval(state.refreshTimer);
        state.refreshTimer = null;
      }
      if (btn) btn.disabled = true;
      const sel = $("#autoRefresh");
      if (sel) sel.disabled = true;
    }
    render();
  } catch (err) {
    state.refreshNote = `刷新失败：${err?.message || String(err)}`;
    render();
  } finally {
    state.refreshing = false;
    if (btn) {
      btn.classList.remove("is-busy");
      btn.disabled = unavailable;
    }
  }
}

/* ── 渲染入口 ───────────────────────────────── */
function render() {
  const note = $("#refreshNote");
  if (note) note.textContent = state.refreshNote || "";
  if (state.error) {
    $("#sub").innerHTML =
      `<span style="color:var(--red)">连不上本地服务：${esc(state.error)}</span> ` +
      `<button id="retry" class="btn" type="button" style="padding:2px 9px;font-size:12px;vertical-align:1px">重试</button>`;
    $("#retry")?.addEventListener("click", () => {
      state.error = "";
      load();
    });
    return;
  }
  const d = state.data;
  if (!d) return;

  renderHead(d);
  renderWarnings(d);
  renderRank(d);
  renderWaste(d);
  renderAll(d);
  renderFoot(d);

  $("#cRank").textContent = d.rows.length;
  $("#cWaste").textContent = d.waste.length;
  $("#cAll").textContent = d.accounts.length;
}

function renderHead(d) {
  const g = d.group;
  const sn = d.snapshot || {};
  const bits = [];
  if (g) bits.push(`<b>${esc(g.name)}</b> · <span class="mono">routing=${esc(g.routing || "?")}</span>`);
  if (g && g.members) bits.push(`${g.members} 个成员模型`);
  if (sn.at) bits.push(`决策快照 ${md(sn.at)}（${ago((sn.ageMin ?? 0) / 60)}）`);
  else if (sn.error) bits.push(`无决策快照`);
  const f = d.fresh || {};
  if (f.accountCount) {
    const age = [];
    if (f.quotaNewestHours != null) age.push(`最新 ${ago(f.quotaNewestHours)}`);
    if (f.quotaOldestHours != null && f.quotaOldestHours > (f.quotaNewestHours ?? 0) + 0.25) {
      age.push(`最旧 ${ago(f.quotaOldestHours)}`);
    }
    bits.push(`额度读数 ${age.join(" / ") || "未知"}`);
  }
  $("#sub").innerHTML = bits.join(" · ");

  $("#formula").hidden = false;

  const nu = d.nextUp;
  $("#nextup").innerHTML = nu
    ? `<span class="tag">下一次请求会先试</span>
       <span><b>${esc(nu.name)}</b>${nu.who ? ` / ${esc(nu.who)}` : ""}${
         nu.model ? ` · <span class="mono">${esc(nu.model)}</span>` : ""
       }${nu.pace != null ? ` · pace <span class="mono">${nu.pace.toFixed(3)}</span>` : ""}</span>
       <span class="hint">（决策快照里第一个不在冷却的候选）</span>`
    : `<span class="hint">暂无可用候选——这个组最近没有请求，或者所有成员都在冷却。</span>`;
}

function renderWarnings(d) {
  const box = $("#warnings");
  if (!d.warnings || !d.warnings.length) {
    box.innerHTML = "";
    return;
  }
  box.innerHTML = d.warnings
    .map(
      (w) => `<div class="warn ${w.level === "error" ? "error" : ""}">
        <span class="ico">${w.level === "error" ? "!" : "!"}</span>
        <span>${esc(w.text)}</span>
      </div>`,
    )
    .join("");
}

/* ── 排名 ───────────────────────────────────── */
function renderRank(d) {
  const box = $("#panel-rank");
  const rows = d.rows || [];
  if (!rows.length) {
    box.innerHTML = `<div class="empty">
      这个组还没有路由快照。<br />
      magpie 只在有请求经过时才记一次排序，发一条消息后重开本页就能看到新的。
    </div>`;
    return;
  }
  const maxPace = Math.max(...rows.map((r) => r.pace || 0), 1e-9);

  const note = `<div class="rank-note">
    按 <b>pace 降序</b>回放 magpie 最近一次真实决策。pace 的分子是<b>模型限流窗口</b>的已用百分比，
    右边那列是<b>账号额度包</b>余额——两套口径，数字不必对得上。
    没有到期窗口的候选按 <span class="mono">100 ÷ 168h</span> 兜底，分数不随时间变，所以标「无窗口 · 兜底」；
    有窗口的候选会拿最新读数重算一遍，变了就标出重算值。
  </div>`;

  box.innerHTML =
    note +
    rows
    .map((r, i) => {
      const width = Math.max(2, ((r.pace || 0) / maxPace) * 100);
      // 分母从 pace 反推，而不是用「此刻到期还有几小时」：
      // magpie 的 pace 是快照那一刻算的，拿现在的小时数去配它，式子和数值会差出零点几个百分点。
      const impliedHours = r.pace > 0 ? (100 - r.used) / r.pace : null;
      const expr =
        r.assumedDue || impliedHours == null
          ? `(100 − ${r.used.toFixed(1)}%) ÷ 168h · 无窗口，固定兜底`
          : `(100 − ${r.used.toFixed(1)}%) ÷ ${Math.round(impliedHours)}h`;
      const q = r.quota;
      let amountMain = "额度未上报";
      let amountSub = "";
      let amountWarn = "";
      if (q) {
        const w = pickMainWindow(q.windows);
        if (w) {
          const unit = w.unit ? ` ${esc(w.unit)}` : "";
          if (w.limit != null && w.amount != null) {
            amountMain = `剩 ${num(w.limit - w.amount)} / ${num(w.limit)}${unit}`;
          } else if (w.remaining != null) {
            amountMain = `剩 ${w.remaining.toFixed(1)}%`;
          }
          const dueIso = w.runsOutAt || w.resetsAt;
          if (dueIso) {
            const dl = (Date.parse(dueIso) - Date.now()) / 86400000;
            amountSub = `${w.runsOutAt ? "包到期" : "重置"} ${md(dueIso)} · ${daysText(dl)}`;
          } else {
            amountSub = "无到期日";
          }
          // 「剩多少」和「其中多少会白扔」是两件事，分两行说，别挤成一行被省略号吃掉
          if (w.runsOut != null && w.runsOut > 0.005) {
            amountWarn = `其中 ${num(w.runsOut)}${unit} 到期失效`;
          }
        } else {
          amountMain = q.plan || "无窗口";
        }
        // 读数只在真的旧了才占位置：平时它不该抢走「什么时候到期」这一格的注意力
        if (q.ageHours != null && q.ageHours > 24) {
          amountSub += ` · <span class="stale">读数 ${ago(q.ageHours)}</span>`;
        }
      }

      const restBadge = r.rest
        ? `<span class="rest-badge">${r.rest.status ? `冷却 ${r.rest.status}` : "冷却中"}</span>`
        : "";

      // pace 标签三态：magpie 原值 / 按最新读数重算 / 无窗口兜底。
      // 旧版只区分 magpie 与 computed，但 computed 用的仍是快照里的 used，
      // 标「按额度重算」会让人以为已经吃到了最新额度 —— 这里改成说实话。
      const lv = r.live || null;
      let paceTag = r.paceSource === "magpie" ? "magpie 实算" : "按快照重算";
      let paceTagCls = "";
      let paceTagTitle = "magpie 路由时写入的快照值";
      if (lv?.status === "repriced") {
        if (lv.changed) {
          paceTag = `现 ${(lv.pace || 0).toFixed(3)}`;
          paceTagCls = " is-changed";
          paceTagTitle = `按 ${lv.window || "对应窗口"} 的最新读数重算；左侧主数字仍是决策快照值`;
        } else {
          paceTag = "重算持平";
          paceTagTitle = "已用最新读数重算，与快照一致";
        }
      } else if (lv?.status === "no-window") {
        paceTag = "无窗口 · 兜底";
        paceTagCls = " is-fallback";
        paceTagTitle = "该候选没有到期窗口，pace 是固定兜底常数，重算不会变";
      } else if (lv?.status === "unmatched") {
        paceTag = "窗口未匹配";
        paceTagCls = " is-fallback";
        paceTagTitle = "有到期时间，但最新额度里找不到同一窗口；未重算";
      }

      return `<div class="rank-row ${i === 0 ? "is-first" : ""} ${r.rest ? "is-rest" : ""}">
        <div class="rank-no">${r.shownRank}</div>
        <div>
          <div class="who-name">${esc(r.who || r.name || r.id)}${restBadge}</div>
          <div class="who-meta">${esc(r.name)}${r.plan ? ` · ${esc(r.plan)}` : ""}${
            r.model ? ` · ${esc(r.model)}` : ""
          }</div>
        </div>
        <div class="pace-cell">
          <div class="pace-top">
            <span class="pace-val">${(r.pace || 0).toFixed(3)}</span>
            <span class="pace-tag${paceTagCls}" title="${esc(paceTagTitle)}">${esc(paceTag)}</span>
          </div>
          <div class="bar"><i style="width:${width.toFixed(1)}%"></i></div>
          <div class="pace-expr">${expr}</div>
        </div>
        <div class="right-cell">
          <div class="right-main">${amountMain}</div>
          <div class="right-sub">${amountSub}</div>
          ${amountWarn ? `<div class="right-warn">${amountWarn}</div>` : ""}
        </div>
      </div>`;
    })
    .join("");
}

function pickMainWindow(windows) {
  if (!windows || !windows.length) return null;
  const score = (w) => {
    let s = 0;
    if (w.runsOut != null && w.runsOut > 0) s += 40; // 会失效的最要紧
    if (w.limit != null && w.amount != null) s += 20;
    if (w.resetsAt || w.runsOutAt) s += 8;
    if (w.used != null && w.used > 90) s += 4;
    if (/签到|checkin/i.test(w.name)) s -= 30;
    return s;
  };
  return [...windows].sort((a, b) => score(b) - score(a))[0];
}

/* ── 到期账 ─────────────────────────────────── */
function renderWaste(d) {
  const box = $("#panel-waste");
  const list = d.waste || [];
  if (!list.length) {
    box.innerHTML = `<div class="empty">没有带到期日的额度窗口。</div>`;
    return;
  }

  const lapse = list.filter((w) => w.kind === "lapse" && w.verdict === "waste");
  const reset = list.filter((w) => w.kind === "reset" && w.verdict === "waste");
  const other = list.filter((w) => !lapse.includes(w) && !reset.includes(w));

  const card = (w) => {
    const official = w.wasteSource === "official";
    const unit = w.unit ? ` ${esc(w.unit)}` : "";
    const amtCls =
      w.verdict === "waste" ? (w.kind === "lapse" ? "lapse" : "reset") : w.verdict === "burnable" ? "ok" : "thin";
    let numText;
    if (w.verdict === "waste") {
      numText = `≈ ${num(w.waste)}${unit}`;
    } else if (w.verdict === "burnable") {
      numText = "能烧完";
    } else if (w.verdict === "spent") {
      numText = "已用尽";
    } else {
      numText = "算不出";
    }
    const note =
      w.verdict === "waste"
        ? official
          ? w.kind === "lapse"
            ? "magpie 给出的到期失效量"
            : "magpie 给出的本期剩余"
          : w.note
        : w.verdict === "burnable"
          ? official
            ? "magpie 判断能烧完"
            : w.note
          : w.note || "";

    return `<div class="wcard ${amtCls}">
      <span class="dot"></span>
      <div style="min-width:0">
        <div class="w-title">${esc(w.user || w.providerName)} · ${esc(w.name)}</div>
        <div class="w-note">${esc(w.providerName)}${w.plan ? ` · ${esc(w.plan)}` : ""} · ${esc(note)}${
          w.mergedNote ? ` · ${esc(w.mergedNote)}` : ""
        }</div>
      </div>
      <div class="w-amt">
        <div class="w-num">${numText}</div>
        <div class="w-when">${w.daysLeft != null ? daysText(w.daysLeft) : "—"}${
          w.due ? ` · ${md(w.due)}` : ""
        }</div>
      </div>
    </div>`;
  };

  const sec = (title, arr) => (arr.length ? `<div class="sec-title">${title}</div>${arr.map(card).join("")}` : "");

  box.innerHTML = [
    sec(`会真失效 · ${lapse.length} 项`, lapse),
    sec(`本期用不完，下期重置 · ${reset.length} 项`, reset),
    sec(`其余（推算不出或已能烧完）· ${other.length} 项`, other),
  ].join("");
}

/* ── 全部账号 ───────────────────────────────── */
function renderAll(d) {
  const box = $("#panel-all");
  const accs = d.accounts || [];
  if (!accs.length) {
    box.innerHTML = `<div class="empty">网关没有上报任何账号额度。</div>`;
    return;
  }
  box.innerHTML = accs
    .map((a) => {
      const staleCls = a.ageHours != null && a.ageHours > 24 ? "stale" : "";
      const wins = (a.windows || []).length
        ? a.windows
            .map((w) => {
              const pct =
                w.remaining != null ? Math.max(0, Math.min(100, w.remaining)) : w.used != null ? 100 - w.used : 0;
              const unit = w.unit ? ` ${esc(w.unit)}` : "";
              const amt =
                w.limit != null && w.amount != null ? `${num(w.limit - w.amount)} / ${num(w.limit)}${unit}` : w.display ? esc(w.display) : "—";
              const dueIso = w.runsOutAt || w.resetsAt;
              const dl = dueIso ? (Date.parse(dueIso) - Date.now()) / 86400000 : null;
              return `<div class="win">
                <div class="win-name">${esc(w.name)}${w.runsOut ? ` <span style="color:var(--red)">失效 ${num(w.runsOut)}</span>` : ""}</div>
                <div class="win-bar"><i style="width:${pct.toFixed(1)}%"></i></div>
                <div class="win-num">${amt}</div>
                <div class="win-when">${dueIso ? `${md(dueIso)} · ${daysText(dl)}` : "无到期日"}</div>
              </div>`;
            })
            .join("")
        : `<div class="win"><div class="win-name" style="color:var(--faint)">没有额度窗口</div></div>`;

      return `<div class="acc">
        <div class="acc-head">
          <span class="acc-name">${esc(a.user || a.providerName)}</span>
          <span class="acc-meta">${esc(a.providerName)}${a.plan ? ` · ${esc(a.plan)}` : ""} · <span class="${staleCls}">读数 ${ago(a.ageHours)}</span></span>
        </div>
        <div class="acc-wins">${wins}</div>
      </div>`;
    })
    .join("");
}

/* ── 页脚 ───────────────────────────────────── */
function renderFoot(d) {
  const sn = d.snapshot || {};
  const gw = d.gateway || {};
  $("#foot").innerHTML = `
    数据口径：排名与 pace 直接取自 magpie 写进 <code>routing/*.jsonl</code> 的 <code>order[]</code>（${
      sn.at ? `决策快照 ${md(sn.at)}` : "暂无快照"
    }）${sn.entries ? `，共 ${sn.entries} 条候选记录` : ""}。面板不改写这个值，只对「能对上同一限流窗口」的候选做重算校验，差异标在行内。<br />
    额度取自网关 <code>${esc(gw.base || "/v1/magpie/quotas")}</code>，每个账号各自标了读数时间。<br />    
    到期账优先用窗口自带的 <code>runsOut</code>（magpie 自己算的失效量）；没有才用最近 7 个完整自然日的日均消耗推，
    样本不足 3 天就明说推不出来。<br />
    本面板不写 providers.json、不碰凭证文件；右上角可手动或定时触发额度重读（经 magpie CLI 向厂商查询，不消耗模型 token，受 magpie 每张卡 30 秒防重限制）。生成于 ${md(d.generatedAt)}。
  `;
}

/* ── 启动 ───────────────────────────────────── */
applyTheme();
document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));
$("#refreshBtn")?.addEventListener("click", () => doRefresh());
$("#autoRefresh")?.addEventListener("change", async () => {
  const sel = $("#autoRefresh");
  const ms = Number(sel.value);
  try {
    state.prefs = await api("/api/prefs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ autoRefreshMs: ms }),
    });
    state.refreshNote = ms ? `自动刷新已设为 ${sel.selectedOptions[0]?.textContent || `${ms} 毫秒`}` : "自动刷新已关闭";
  } catch (err) {
    sel.value = String(state.prefs.autoRefreshMs);
    state.refreshNote = `保存刷新周期失败：${err?.message || String(err)}`;
  }
  rebuildTimer();
  render();
});

// ?tab=waste|all 直接落在某一页，方便截图和转发
try {
  const want = new URLSearchParams(location.search).get("tab");
  if (want && ["rank", "waste", "all"].includes(want)) switchTab(want);
} catch {
  /* 没有 search 就留在排名页 */
}

loadPrefs();
load();
// 只重读、更新「读数多久以前」；主动刷新由上面的周期定时器负责。
setInterval(load, 60_000);
