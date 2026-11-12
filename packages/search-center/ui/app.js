const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const token = $('meta[name="search-center-token"]').content;
const uiVersion = $('meta[name="search-center-version"]').content;
let state, filter = "ready", historyFilter = "all", currentTab = "channels", editing, draft, running = false, dragId, drawerFocus, saving = false;
let drawerEpoch = 0;
let keyEditor = null;
function reloadBlocked() { return editing || running || $("#models-dialog").open || $("#replay-dialog").open; }
const labels = { quick: "快速", balanced: "一般", deep: "深入" };
const statusLabels = { ok: "成功", no_sources: "没有来源", timeout: "超时", unavailable: "不可用", error: "失败", disabled: "已停用" };
const toolNames = {web_search:"网页",x_search:"X"};
function searchToolSummary(item) {
  const info = item.search;
  if (!info) return "";
  const enabled = (info.tools_requested || []).map(t=>toolNames[t] || t).join(" + ");
  const used = [...new Set((info.tool_calls || []).filter(t=>t.status==="completed").map(t=>toolNames[t.type] || t.type))].join(" + ");
  return `已启用：${enabled}；${used ? `接口报告已调用：${used}` : "接口未报告已完成的工具调用"}`;
}
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
function button(text, cls, action) { const b = el("button", cls, text); b.type = "button"; b.onclick = action; return b; }
// Magpie's allow-scripts iframe deliberately has no allow-forms permission.
// Invoke our JSON API actions directly; native submit is blocked before onsubmit.
function bindFormAction(formSelector, buttonSelector, action) {
  const form = $(formSelector);
  const run = () => { if (form.reportValidity()) void action(); };
  $(buttonSelector).onclick = run;
  form.onsubmit = event => { event.preventDefault(); };
  form.addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.isComposing && event.target.matches("input")) {
      event.preventDefault(); run();
    }
  });
}
const brandFiles = {}; // Preview uses text marks, not third-party brand assets.
function logo(id) {
  const tile = el("span", "tile"), files = brandFiles[id];
  if (files) {
    const image = el("img"); image.alt = ""; image.draggable = false; image.dataset.brand = id;
    image.src = "vendor/dsh/logos/" + (document.body.dataset.theme === "dark" ? files[1] || files[0] : files[0]);
    tile.dataset.fit = id === "grok" || id === "tavily" ? "cover" : "contain"; tile.append(image);
  } else { tile.classList.add("tile-fallback"); tile.textContent = state?.capabilities.channels[id]?.mark || "A"; }
  return tile;
}
function toast(message) { $("#toast").textContent = message; $("#toast").classList.remove("hidden"); clearTimeout(toast.timer); toast.timer = setTimeout(() => $("#toast").classList.add("hidden"), 3500); }
function error(message) { $("#notice").textContent = message; $("#notice").classList.remove("hidden"); }
async function api(path, body) {
  const response = await fetch(`api/${path}`, { method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", "X-Search-Center": token },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json();
  if (!response.ok) {
    if (data.code === "TOKEN_REQUIRED" && !reloadBlocked()) location.reload();
    throw Object.assign(new Error(data.error || "请求失败"), {code:data.code});
  }
  return data;
}
async function load() {
  try {
    const next = await api("state");
    if (next.sessionExpired || next.uiVersion && next.uiVersion !== uiVersion) {
      if (reloadBlocked()) { error("搜索中心已更新，结束当前操作后会自动刷新。"); return; }
      location.reload(); return;
    }
    state = next;
    $("#notice").classList.add("hidden"); render();
  }
  catch (e) { error(e.message); }
}
async function save(policy) {
  const saved = await api("policy", policy);
  state.policy = saved;
  await load();
  toast("设置已保存");
}
function changeTab(name) {
  currentTab = name;
  $$(".tab").forEach(b => b.classList.toggle("active", b.dataset.tab === name));
  $$(".panel").forEach(p => p.classList.toggle("hidden", p.id !== `${name}-panel`));
  if (name === "channels") requestAnimationFrame(drawRoutes);
}
function render() {
  const caps = state.capabilities.channels;
  const ids = state.policy.order;
  $("#summary").textContent = `${ids.filter(id => caps[id].available).length} 可用 / ${ids.length} 渠道`;
  $("#agent-summary").textContent = `${state.agents.filter(a => a.selected).length} 个 Agent 共用配置`;
  const ready = ids.filter(id => caps[id].available);
  $("#route-status").textContent = `${ready.length} / ${ids.length} 已就绪`;
  $("#hub-policy").textContent = "按需调用";
  const recent = state.history[0], failures = recent ? Object.entries(recent.routing?.channel_results || {}).filter(([, v]) => v.status !== "ok" && !v.models?.some(m => m.status === "ok")) : [];
  $("#route-banner").dataset.tone = failures.length ? "warn" : "info";
  $("#route-banner strong").textContent = failures.length ? "最近一次调用有渠道未成功" : "已读取现有配置，可直接选择渠道";
  $("#route-banner-text").textContent = failures.length ? failures.map(([id, v]) => `${caps[id]?.name || id}：${statusLabels[v.status] || v.status}${v.http_status ? ` HTTP ${v.http_status}` : ""}`).join(" · ") + "。展开最近搜索查看详情。"
    : `${ready.map(id => caps[id].name).join(" · ")}。关闭渠道后，本插件的调用会跳过它。`;
  renderChannels(); renderTestChoices(); renderHistory(); renderAgents();
  $("#model-list").replaceChildren(...(state.capabilities.models?.available_models || []).map(id => {
    const o = document.createElement("option"); o.value = id; return o;
  }));
}
function renderChannels() {
  const list = $("#channel-list"); list.replaceChildren();
  const query = $("#channel-filter").value.toLowerCase();
  const ids = state.policy.order.filter(id => {
    const cap = state.capabilities.channels[id];
    return (id + cap.name).toLowerCase().includes(query) &&
      (filter === "all" || filter === "ready" && cap.configured || filter === "missing" && !cap.configured || filter === "special" && cap.kind === "专业来源");
  });
  const groups = [
    ["模型搜索", ids.filter(id => id === "grok"), "按档位选择模型"],
    ["搜索与网页来源", ids.filter(id => id !== "grok" && state.capabilities.channels[id].kind !== "专业来源"), "拖动调整优先级"],
    ["专业来源", ids.filter(id => state.capabilities.channels[id].kind === "专业来源"), "明确选择时调用"],
  ];
  for (const [name, members, hint] of groups) {
    if (!members.length) continue;
    const group = el("div", "rgroup"), heading = el("div", "rg-label", name), rows = el("div", "rg-rows");
    heading.append(el("span", "rg-hint", hint)); group.append(heading, rows); list.append(group);
    for (const id of members) {
    const c = state.policy.channels[id], cap = state.capabilities.channels[id];
    const card = el("article", "row channel-card");
    card.dataset.st = !cap.configured ? "unset" : c.enabled ? "on" : "off";
    card.dataset.channel = id; card.draggable = true; card.title = cap.description;
    card.ondragstart = e => { dragId = id; e.dataTransfer.setData("text/plain", id); card.classList.add("dragging"); };
    card.ondragend = () => { dragId = null; card.classList.remove("dragging"); $$(".drag-over").forEach(x => x.classList.remove("drag-over")); };
    card.ondragover = e => { if (dragId && dragId !== id) { e.preventDefault(); card.classList.add("drag-over"); } };
    card.ondragleave = () => card.classList.remove("drag-over");
    card.ondrop = async e => {
      e.preventDefault(); card.classList.remove("drag-over");
      if (!dragId || dragId === id) return;
      const p = structuredClone(state.policy), from = p.order.indexOf(dragId), to = p.order.indexOf(id);
      p.order.splice(from, 1); p.order.splice(to, 0, dragId); dragId = null;
      try { await save(p); } catch (e) { error(e.message); }
    };
    const title = button("", "row-main", () => openDrawer(id));
    const subtitle = !cap.configured ? "待配置" : !c.enabled ? "已关闭" : c.keys.length ? `${c.keys.filter(k => k.enabled).length} 条凭据 · ${c.strategy === "rotate" ? "轮换" : "按顺序"}` : cap.keyEnv ? "沿用现有配置" : "公开来源";
    title.setAttribute("aria-label", `配置 ${cap.name}`);
    title.title = `${cap.description} · ${subtitle}`;
    const names = el("span", "channel-labels"); names.append(el("span", "row-name", cap.name));
    if (id === "grok") {
      card.classList.add("grok-model-row");
      for (const profile of ["quick", "balanced", "deep"]) {
        const model = effectiveModel(profile);
        const line = el("small", "channel-model", `${labels[profile]} · ${model || "自动选择"}`);
        line.title = model; names.append(line);
      }
    }
    if (cap.effectiveBaseUrl) names.append(el("small", "channel-endpoint", cap.effectiveBaseUrl));
    title.append(logo(id), names);
    const toggle = button("", "switch" + (c.enabled ? " on" : ""), async () => {
      toggle.disabled = true;
      try { const p = structuredClone(state.policy); p.channels[id].enabled = !c.enabled; await save(p); }
      catch (e) { error(e.message); toggle.disabled = false; }
    });
    toggle.setAttribute("role", "switch"); toggle.setAttribute("aria-checked", c.enabled);
    toggle.setAttribute("aria-label", `启用 ${cap.name}`);
    toggle.append(el("i"));
    const actions = el("div", "reorder-controls");
    actions.append(button("↑", "order-button", () => move(id, -1)), button("↓", "order-button", () => move(id, 1)));
    actions.children[0].setAttribute("aria-label", `上移 ${cap.name}`);
    actions.children[1].setAttribute("aria-label", `下移 ${cap.name}`);
    card.append(title, actions, toggle);
    const latest = state.history.find(r => r.routing?.channel_results?.[id])?.routing.channel_results[id];
    if (c.enabled && latest && latest.status !== "ok" && !latest.models?.some(m => m.status === "ok")) {
      card.classList.add("has-fault");
      card.append(el("div", "row-fault", `上次调用 · ${statusLabels[latest.status] || latest.status}${latest.http_status ? ` · HTTP ${latest.http_status}` : ""}`));
    }
    rows.append(card);
    }
  }
  if (!ids.length) list.append(el("div", "loading", "没有符合条件的渠道"));
  requestAnimationFrame(drawRoutes);
}
function drawRoutes() {
  const stage = $("#route-stage"), svg = $("#route-lines");
  if (!stage?.offsetWidth) return;
  const bounds = stage.getBoundingClientRect(), narrow = matchMedia("(max-width:720px)").matches;
  const point = (node, side) => { const r = node.getBoundingClientRect(); return { x: (side === "left" ? r.left : side === "bottom" ? r.left + r.width / 2 : r.right) - bounds.left, y: (side === "bottom" ? r.bottom : r.top + r.height / 2) - bounds.top }; };
  const part = (tag, attrs) => { const n = document.createElementNS("http://www.w3.org/2000/svg", tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); svg.append(n); };
  const path = (from, to, active, branch = false) => {
    const d = narrow && branch ? `M ${from.x} ${from.y} V ${from.y + 16} H ${to.x - 17} V ${to.y - 9} Q ${to.x - 17} ${to.y} ${to.x} ${to.y}`
      : `M ${from.x} ${from.y} C ${from.x + (to.x - from.x) * .55} ${from.y}, ${to.x - (to.x - from.x) * .55} ${to.y}, ${to.x} ${to.y}`;
    part("path", { d, class: `route-wire ${active ? "active" : "inactive"}` });
    part("circle", { cx: to.x, cy: to.y, r: 4, class: `route-dot ${active ? "" : "inactive"}` });
  };
  svg.replaceChildren(); svg.setAttribute("viewBox", `0 0 ${bounds.width} ${bounds.height}`);
  const origin = point($("#agent-node"), "right"), hubIn = point($("#hub-node"), "left"), hubOut = point($("#hub-node"), narrow ? "bottom" : "right");
  path(origin, hubIn, true);
  for (const card of $$(".channel-card")) path(hubOut, point(card, "left"), state.capabilities.channels[card.dataset.channel].available, true);
  for (const p of [origin, hubOut]) part("circle", { cx: p.x, cy: p.y, r: 4, class: "route-dot" });
}
async function move(id, direction) {
  const p = structuredClone(state.policy), i = p.order.indexOf(id), next = i + direction;
  if (next < 0 || next >= p.order.length) return;
  [p.order[i], p.order[next]] = [p.order[next], p.order[i]];
  try { await save(p); } catch (e) { error(e.message); }
}
function testChannel(id) {
  closeDrawer(); changeTab("test"); $$('#test-channels input').forEach(c => c.checked = c.value === id);
  $("#test-model").value = "";
  $("#grok-search-mode").value = "both";
  $("#query").focus();
}
function renderTestChoices() {
  const checked = new Set($$('#test-channels input:checked').map(c => c.value));
  $("#test-channels").replaceChildren();
  for (const id of state.policy.order) {
    const c = state.capabilities.channels[id];
    const label = el("label", "check-chip"), input = document.createElement("input");
    input.type = "checkbox"; input.value = id; input.checked = checked.has(id); input.disabled = !c.enabled;
    label.append(input, document.createTextNode(c.name)); $("#test-channels").append(label);
  }
}
function statusRows(routing, container) {
  for (const [id, data] of Object.entries(routing?.channel_results || {})) {
    const name = state.capabilities.channels[id]?.name || id;
    const items = data.models || [data];
    for (const item of items) {
      const row = el("div", "status-row" + (item.status === "ok" ? "" : " bad"));
      row.textContent = [name, item.model, statusLabels[item.status] || item.status,
        item.elapsed_ms != null ? `${(item.elapsed_ms / 1000).toFixed(1)} 秒` : "",
        data.keyLabel, item.reason || data.reason, item.http_status ? `HTTP ${item.http_status}` : "", searchToolSummary(item)].filter(Boolean).join(" · ");
      container.append(row);
    }
  }
}
function sourceNode(source, index) {
  const row = el("div", "source"), a = el("a", "", `${index + 1}. ${source.title || source.url}`);
  try { const u = new URL(source.url); if (["http:", "https:"].includes(u.protocol)) { a.href = u.href; a.target = "_blank"; a.rel = "noopener noreferrer"; } } catch {}
  row.append(a, el("small", "", source.url));
  if (source.text) row.append(el("p", "", source.text.slice(0, 420)));
  return row;
}
function showResult(result, elapsed) {
  const out = $("#test-output"); out.replaceChildren();
  const head = el("div", "result-head"); head.append(el("strong", "", result.results.length ? "已返回搜索结果" : "本次没有可用来源"),
    el("span", "badge " + (result.results.length ? "ready" : "missing"), `${(elapsed / 1000).toFixed(1)} 秒`));
  out.append(head);
  const metrics = el("div", "result-metrics");
  metrics.append(el("span", "badge neutral", `${result.results.length} 条来源`),
    el("span", "badge neutral", `${result.routing.selected_channels.length} 个渠道`),
    el("span", "badge neutral", labels[result.routing.profile]));
  out.append(metrics); statusRows(result.routing, out);
  if (result.content) { const details = document.createElement("details"); details.append(el("summary", "text-button", "查看模型回答"), el("div", "result-answer", result.content)); out.append(details); }
  result.results.forEach((source, i) => out.append(sourceNode(source, i)));
}
async function runSearchTest() {
  if (running) return;
  const channels = $$('#test-channels input:checked').map(c => c.value);
  const body = { query: $("#query").value, profile: $("#profile").value, count: Number($("#count").value), grok_search_mode:$("#grok-search-mode").value,
    ...(channels.length ? { channels } : {}), ...($("#test-model").value.trim() ? { model: $("#test-model").value.trim() } : {}) };
  running = true; $("#run-test").disabled = true; $("#run-test").textContent = "搜索中…";
  const out = $("#test-output"); out.replaceChildren(el("div", "empty", "正在调用所选渠道，请稍候…"));
  const started = Date.now();
  try { showResult(await api("test", body), Date.now() - started); await load(); }
  catch (e) { out.replaceChildren(el("div", "empty", e.message)); }
  finally { running = false; $("#run-test").disabled = false; $("#run-test").textContent = "开始真实搜索 ↗"; }
}
bindFormAction("#test-form", "#run-test", runSearchTest);
function recordStatus(record) {
  if (!record.sourcesCount) return "failed";
  return Object.values(record.routing?.channel_results || {}).some(v => v.models ? v.models.some(m => m.status !== "ok") : v.status !== "ok") ? "partial" : "success";
}
function renderHistory() {
  const expanded = new Set($$(".log-entry details[open]").map(d=>d.dataset.record));
  $("#log-count").textContent = state.history.length;
  for (const [selector, records] of [["#history-list", state.history.filter(r => historyFilter === "all" || recordStatus(r) === historyFilter)]]) {
    const list = $(selector); list.replaceChildren();
    if (!records.length) { list.append(el("div", "empty", "暂无调用记录。完成一次测试或让 Agent 调用后，这里会显示执行情况。")); continue; }
    for (const record of records) {
      const article = el("article", "log-entry"), d = el("details", ""), summary = el("summary", "le-head"), top = el("div", "le-top");
      d.dataset.record = record.id; d.open = expanded.has(record.id);
      const status = recordStatus(record), channelResults = record.routing?.channel_results || {};
      const chip = el("span", "le-chip", { success: "已返回来源", partial: "部分成功", failed: "无可用来源" }[status]); chip.dataset.t = {success:"ok",partial:"warn",failed:"err"}[status];
      top.append(el("time", "le-time", new Date(record.at).toLocaleTimeString("zh-CN", { hour12: false })),
        el("span", "le-query", record.query), chip,
        el("span", "le-dur", `${(record.elapsedMs / 1000).toFixed(1)} 秒`), el("span", "le-chevron", "›"));
      summary.append(top);
      summary.title = new Date(record.at).toLocaleString("zh-CN", { hour12: false });
      const band = el("div", "lband"), route = el("div", "lroute"), targets = el("div", "history-targets");
      const node = (text, good=true, id) => { const n = el("span", "lnode"); n.dataset.s = good ? "hit" : "fail"; if(id)n.append(logo(id)); n.append(el("span", "ln-name", text)); return n; };
      const arrow = () => { const n=el("span", "lwire"); n.dataset.s="flow";return n; };
      route.append(node(record.origin), arrow(), node("搜索中心"), arrow());
      for (const id of record.channels) {
        const entry = channelResults[id];
        targets.append(node(state.capabilities.channels[id]?.name || id, entry?.status === "ok" || entry?.models?.some(m => m.status === "ok"), id));
      }
      route.append(targets); route.title = "所选渠道并行调用，图示不表示依次回退";
      band.append(route, button("↻ 再次测试", "lr-replay", () => {
        changeTab("test"); $("#query").value = record.query; $("#profile").value = record.profile;
        $("#count").value = record.request?.count || Math.max(record.sourcesCount, 3);
        $("#test-model").value = record.channels.includes("grok") ? record.request?.model || "" : "";
        $("#grok-search-mode").value = record.request?.grok_search_mode || "both";
        $$('#test-channels input').forEach(c => c.checked = record.channels.includes(c.value));
        toast("已填入原查询，点击开始真实搜索执行"); $("#query").focus();
      }));
      const actions=el("div","history-actions-local");
      actions.append(button("▶ 回放","lr-replay",()=>openReplay(record)),band.lastElementChild);
      band.append(actions);
      const body = el("div", "history-detail"), table = el("table", "history-table"), head = el("tr");
      for (const title of ["渠道 / 凭据", "结果", "耗时", "模型 / 详情"]) head.append(el("th", "", title));
      const thead = el("thead"); thead.append(head); table.append(thead);
      const tbody = el("tbody");
      for (const [id, entry] of Object.entries(channelResults)) {
        for (const item of entry.models || [entry]) {
          const tr = el("tr"), name = el("td", "", state.capabilities.channels[id]?.name || id);
          name.append(el("div", "cell-model", entry.keyLabel || ""));
          tr.append(name, el("td", item.status === "ok" ? "cell-ok" : "cell-bad", (statusLabels[item.status] || item.status) + (item.http_status ? ` · ${item.http_status}` : "")),
            el("td", "", item.elapsed_ms != null ? `${(item.elapsed_ms / 1000).toFixed(1)} 秒` : "—"),
            el("td", "cell-model", [item.model, item.reason || entry.reason, searchToolSummary(item)].filter(Boolean).join(" · ") || "—"));
          tbody.append(tr);
        }
        if (entry.attempts?.length > 1) {
          const tr = el("tr"), td = el("td", "cell-model", "凭据尝试：" + entry.attempts.map(a => `${a.label} (${statusLabels[a.status] || a.status})`).join(" → "));
          td.colSpan = 4; tr.append(td); tbody.append(tr);
        }
      }
      table.append(tbody); body.append(table, el("p", "usage-note", `${record.sourcesCount} 条来源 · ${labels[record.profile]}档。费用未由接口统一报告，未估算消费。`));
      record.sources.forEach((s, i) => body.append(sourceNode(s, i)));
      body.hidden = !d.open;
      d.addEventListener("toggle", () => { body.hidden = !d.open; });
      d.append(summary); article.append(d, band, body); list.append(article);
    }
  }
}
function renderAgents() {
  $("#agents-list").replaceChildren();
  for (const agent of state.agents) {
    const label = el("label", "agent-card"), checkbox = document.createElement("input"), text = document.createElement("div");
    checkbox.type = "checkbox"; checkbox.value = agent.id; checkbox.checked = agent.selected;
    text.append(el("strong", "", agent.name), el("small", "", agent.detected ? "喜鹊已识别" : "可分配 · 安装后连接"));
    label.append(checkbox, text); $("#agents-list").append(label);
  }
}
function openDrawer(id) {
  drawerEpoch++;
  keyEditor = null;
  $("#channel-save-status").textContent = "";
  drawerFocus = document.activeElement;
  editing = id; draft = structuredClone(state.policy.channels[id]); const cap = state.capabilities.channels[id];
  $("#drawer-title").textContent = cap.name; $("#drawer-description").textContent = cap.description;
  $("#base-url").value = cap.effectiveBaseUrl || draft.baseUrl;
  $("#base-url").dataset.initial = $("#base-url").value;
  $("#endpoint-field").classList.toggle("hidden", !cap.urlEnv);
  $("#add-key").classList.toggle("hidden", !cap.keyEnv);
  $("#key-strategy-field").classList.toggle("hidden", !cap.keyEnv);
  $("#key-helper").textContent = cap.keyEnv ? "勾选要使用的密钥；请求如何分配由下方路由决定。修改后点击底部保存。" : "此渠道无需凭据。";
  $("#grok-model-settings").classList.toggle("hidden", id !== "grok");
  if (id === "grok") {
    $("#grok-default-profile").value = state.policy.defaultProfile;
    paintModelFields($("#grok-model-fields"));
    const models = state.capabilities.models.available_models || [];
    $("#grok-model-count").textContent = state.capabilities.models.model_list_status === "refresh_required" ? "请获取当前接口模型" : `${models.length} 个公布模型`;
    $("#grok-model-candidates").replaceChildren(...models.map(model => el("code", "model-candidate", model)));
  }
  paintKeys(); $("#drawer").classList.remove("hidden"); $("#drawer-backdrop").classList.remove("hidden");
  $(".shell").inert = true;
  $("#close-drawer").focus();
}
function closeDrawer() { drawerEpoch++; keyEditor = null; $("#drawer").classList.add("hidden"); $("#drawer-backdrop").classList.add("hidden"); $("#key-list").replaceChildren(); draft = null; $(".shell").inert = false; editing = null; if (drawerFocus?.isConnected) drawerFocus.focus(); }
function collectKeys() {
  if (!keyEditor) return true;
  const label = $("#key-list .key-label"), value = $("#key-list .key-value");
  const key = draft.keys.find(k => k.id === keyEditor.id);
  if (!key && !value?.value.trim()) { value?.focus(); toast("请填写 API Key，或取消添加"); return false; }
  if (key) {
    if (label) key.label = label.value.trim() || key.label;
    if (value) key.value = value.value.trim();
  } else draft.keys.push({ id: keyEditor.id, label: label.value.trim() || `Key ${draft.keys.length + 1}`, value: value.value.trim(), enabled: true });
  keyEditor = null;
  return true;
}
function startKeyEditor(id, field) {
  if (!collectKeys()) return;
  keyEditor = { id, field }; paintKeys();
  $("#key-list .key-editor input")?.focus();
}
function paintKeyEditor(row, key) {
  const box = el("div", "key-editor");
  const addInput = (className, text, value = "") => {
    const input = el("input", className); input.value = value; input.placeholder = text; input.setAttribute("aria-label", text);
    input.autocomplete = "off";
    if (className === "key-value") input.type = ["pass", "word"].join("");
    input.onkeydown = e => {
      if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); if (collectKeys()) paintKeys(); }
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); keyEditor = null; paintKeys(); }
    };
    box.append(input);
  };
  if (!key || keyEditor.field === "name") addInput("key-label", "名称，例如：个人账户", key?.label);
  if (!key || keyEditor.field === "value") addInput("key-value", key?.ref ? "粘贴新 Key，留空保留原值" : "粘贴 API Key", key?.value);
  const actions = el("div", "key-editor-actions");
  actions.append(button("取消", "account-action", () => { keyEditor = null; paintKeys(); }),
    button(key ? "完成" : "添加", "account-action primary", () => { if (collectKeys()) paintKeys(); }));
  box.append(actions); row.append(box);
}
function paintKeyStrategy() {
  $$("[data-strategy]").forEach(b => { b.classList.toggle("active", b.dataset.strategy === draft.strategy); b.setAttribute("aria-pressed", String(b.dataset.strategy === draft.strategy)); });
  $("#key-strategy-hint").textContent = draft.strategy === "rotate"
    ? "每次搜索轮流使用下一条已启用密钥；限流或认证失败时，跳过冷却中的密钥。"
    : "优先使用首选密钥；限流、额度或认证错误时，按列表顺序尝试下一条已启用密钥。";
}
function paintKeys() {
  const list = $("#key-list"); list.replaceChildren();
  paintQuota(); paintKeyStrategy();
  const first = draft.keys.find(k => k.enabled)?.id;
  for (const key of draft.keys) {
    const row = el("div", "account-row" + (key.enabled ? " in-use" : " off")); row.dataset.keyId = key.id;
    const toggle = button(key.enabled ? "✓" : "", "account-check", () => { if (!collectKeys()) return; key.enabled = !key.enabled; paintKeys(); });
    toggle.setAttribute("role", "checkbox"); toggle.setAttribute("aria-checked", String(key.enabled)); toggle.setAttribute("aria-label", `启用 ${key.label}`);
    const name = button(key.label, "account-name", () => startKeyEditor(key.id, "name")); name.title = "点击修改名称";
    const masked = el("span", "account-mask", key.value ? "•••••• 待保存" : "•••••• 已保存");
    const edit = button("", "account-edit", () => startKeyEditor(key.id, "value"));
    edit.setAttribute("aria-label", `替换 ${key.label} 的密钥`); edit.title = "替换密钥";
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(svg.namespaceURI, "path"); path.setAttribute("d", "M14 5l5 5M4 20l5-1L20 8a2 2 0 0 0-5-5L4 14z"); svg.append(path); edit.append(svg);
    row.append(toggle, name, masked, edit);
    const actions = el("div", "account-actions");
    actions.append(button("移除", "account-action quiet", () => { if (!collectKeys()) return; draft.keys = draft.keys.filter(k => k.id !== key.id); paintKeys(); }));
    if (key.id === first) actions.append(el("span", "account-first", "首选"));
    else if (key.enabled) actions.append(button("设为首选", "account-action", () => { if (!collectKeys()) return; draft.keys = [key, ...draft.keys.filter(k => k.id !== key.id)]; paintKeys(); }));
    else actions.append(el("span", "account-disabled", "已停用"));
    row.append(actions);
    const health = state.health[key.id];
    if (health?.retryAt > Date.now()) row.append(el("small", "account-rest", `冷却至 ${new Date(health.retryAt).toLocaleTimeString()}`));
    if (keyEditor?.id === key.id) paintKeyEditor(row, key);
    list.append(row);
  }
  const adding = keyEditor && !draft.keys.some(k => k.id === keyEditor.id);
  $("#add-key").hidden = !!adding;
  if (adding) { const row = el("div", "account-row adding"); paintKeyEditor(row); list.append(row); }
  if (!draft.keys.length && !adding) list.append(el("div", "empty-keys", state.capabilities.channels[editing].keyEnv ? "尚未添加密钥" : "公开来源，无需填写密钥"));
}
function paintQuota() {
  const supported=["tavily","firecrawl"].includes(editing);
  $("#quota-panel").classList.toggle("hidden", !supported && editing!=="exa");
  const selected=$("#quota-key").value;
  $("#quota-key").replaceChildren(...draft.keys.filter(k=>k.ref && k.enabled).map(k=>{const o=el("option","",k.label);o.value=k.id;return o;}));
  if([...$("#quota-key").options].some(o=>o.value===selected))$("#quota-key").value=selected;
  $("#quota-key").closest("label").classList.toggle("hidden",!supported);
  $("#quota-refresh").classList.toggle("hidden",!supported);
  $("#quota-refresh").disabled=!$("#quota-key").value;
  renderQuota(state.quotas?.[editing]?.[$("#quota-key").value]);
}
function renderQuota(data) {
  const out=$("#quota-output");out.replaceChildren();
  if(editing==="exa") {out.append(el("p","hint","Exa 搜索 Key 不提供团队余额权限。需单独的管理权限接入；这里不按 Key 数量估算余额。"));return;}
  if(!data){out.append(el("p","hint", "点击查询读取已保存接口的额度，不发起搜索。号池返回的是最近同步快照。"));return;}
  if(data.status!=="ok"){out.append(el("p","quota-warning",`查询未成功${data.httpStatus?`（HTTP ${data.httpStatus}）`:""}。该接口可能不支持额度查询，或当前 Key 无查询权限。`));return;}
  const scope={pool:"启用号池 · 已同步余额估计",account:"账户套餐余额",team:"团队余额"}[data.scope]||"余额";
  out.append(el("p","hint",scope),el("strong","quota-number",data.remaining==null?"未知":Number(data.remaining).toLocaleString("zh-CN")),el("span","muted"," credits"));
  if(data.scope==="pool")out.append(el("p","hint",`已同步 ${data.syncedKeys??"—"} / ${data.totalKeys??"—"} 条启用密钥 · 同步失败 ${data.errorKeys??"—"} 条`));
  if(data.keyRemaining!=null)out.append(el("p","hint",`当前 Key 限额剩余：${data.keyRemaining} credits（与账户余额不相加）`));
  const timestamp=data.scope==="pool"?data.sourceUpdatedAt:data.queriedAt;
  out.append(el("p","hint",`${data.scope==="pool"?"号池同步时间":"接口查询时间"}：${timestamp?new Date(timestamp).toLocaleString("zh-CN",{hour12:false}):"尚未同步"}`));
  if(data.stale||data.cachedStale)out.append(el("p","quota-warning","数据已过期，请以服务端最新统计为准。查询本页不会触发号池上游同步。"));
  if(data.scope!=="pool")out.append(el("p","hint","可能包含其他应用的消费；同账户多条 Key 的余额不可重复相加。"));
}
$("#quota-key").onchange=()=>{renderQuota(state.quotas?.[editing]?.[$("#quota-key").value]);$("#quota-refresh").disabled=!$("#quota-key").value;};
$("#quota-refresh").onclick=async()=>{
  if (!collectKeys()) return;
  paintKeys();
  if($("#base-url").value.trim()!==$("#base-url").dataset.initial || draft.keys.some(k=>k.value||!k.ref)){toast("请先保存修改，再查询额度");return;}
  const channel=editing,keyId=$("#quota-key").value,epoch=drawerEpoch;
  const isCurrent=()=>drawerEpoch===epoch && editing===channel && $("#quota-key").value===keyId;
  $("#quota-refresh").disabled=true;$("#quota-output").replaceChildren(el("p","hint","正在查询…"));
  try{const value=await api("quota",{channel,keyId});state.quotas??={};state.quotas[channel]??={};state.quotas[channel][keyId]=value;if(isCurrent())renderQuota(value);}
  catch(e){if(isCurrent())$("#quota-output").replaceChildren(el("p","quota-warning",e.message));}
  finally{if(isCurrent())$("#quota-refresh").disabled=false;}
};
let replayRecord,replayTimers=[];
function stopReplay(){replayTimers.forEach(clearTimeout);replayTimers=[];$("#replay-status").textContent="动画已停止，可重新回放。";}
function openReplay(record){
  stopReplay();replayRecord=record;$("#replay-query").textContent=record.query;
  const path=$("#replay-path");path.replaceChildren();
  const origin=el("div","replay-origin",record.origin||"Agent"),hub=el("div","replay-hub","搜索中心"),branches=el("div","replay-branches");
  path.append(origin,el("span","replay-arrow","→"),hub,el("span","replay-arrow","→"),branches);
  for(const id of record.channels){
    const entry=record.routing?.channel_results?.[id]||{};
    const ok=entry.status==="ok"||entry.models?.some(m=>m.status==="ok");
    const branch=el("div","replay-branch");branch.dataset.result=ok?"ok":"error";
    branch.append(logo(id),el("span","",state.capabilities.channels[id]?.name||id));
    branch.append(el("small","",ok?"返回来源":statusLabels[entry.status]||"未成功"));
    if(entry.models)branch.append(el("small","",entry.models.map(m=>`${m.model||""} · ${statusLabels[m.status]||m.status}`).join(" / ")));
    branches.append(branch);
  }
  $("#replay-status").textContent="Agent 选择渠道，所选渠道并行执行。";
  if(!$("#replay-dialog").open)$("#replay-dialog").showModal();
  const reduced=matchMedia("(prefers-reduced-motion: reduce)").matches;
  const schedule=(ms,fn)=>replayTimers.push(setTimeout(fn,reduced?0:ms));
  origin.classList.add("lit");schedule(450,()=>hub.classList.add("lit"));
  schedule(950,()=>branches.classList.add("lit"));
  schedule(1800,()=>{$("#replay-status").textContent=`回放完成 · ${record.sourcesCount} 条来源 · 实际耗时 ${(record.elapsedMs/1000).toFixed(1)} 秒`;});
}
$("#close-replay").onclick=()=>$("#replay-dialog").close();
$("#replay-dialog").addEventListener("close",stopReplay);
$("#restart-replay").onclick=()=>replayRecord&&openReplay(replayRecord);
$("#stop-replay").onclick=stopReplay;
$("#add-key").onclick = () => startKeyEditor(crypto.randomUUID(), "new");
$$("[data-strategy]").forEach(b => b.onclick = () => { draft.strategy = b.dataset.strategy; paintKeyStrategy(); });
async function saveDrawer(testAfter = false) {
  if (saving) return;
  const channel = editing;
  if (!collectKeys()) return;
  draft.baseUrl = $("#base-url").value.trim();
  if (draft.baseUrl !== $("#base-url").dataset.initial || draft.keys.length) draft.endpointSource = "custom";
  const request = {channel,revision:state.policy.revision,baseUrl:draft.baseUrl,strategy:draft.strategy,
    ...(channel === "grok" ? { models: Object.fromEntries($$("#grok-model-fields input").map(i=>[i.dataset.profile,i.value.trim()])), defaultProfile:$("#grok-default-profile").value } : {}),
    keys:draft.keys.map(({id,label,enabled,value})=>({id,label,enabled,value:value||""}))};
  saving = true; $$("#channel-form button").forEach(b=>b.disabled=true);
  $("#channel-save-status").textContent = "正在保存…"; $("#save-channel").textContent = "保存中…";
  try {
    state.policy = await api("channel", request);
    draft = null; closeDrawer(); await load(); toast("密钥与接口已保存");
    if (testAfter) {testChannel(channel);$("#profile").value=state.policy.defaultProfile;}
  } catch (error) { $("#channel-save-status").textContent = error.message; toast(error.message); }
  finally {saving=false;$$("#channel-form button").forEach(b=>b.disabled=false);$("#save-channel").textContent="保存配置";}
}
bindFormAction("#channel-form", "#save-channel", saveDrawer);
$("#drawer-test").textContent = "保存并去测试";
$("#drawer-test").onclick = () => saveDrawer(true);
$("#refresh-models").onclick = async () => {
  if (!collectKeys()) return;
  paintKeys();
  if ($("#base-url").value.trim() !== $("#base-url").dataset.initial || draft.keys.some(k=>k.value || !k.ref)) {toast("请先保存接口或密钥修改，再获取模型列表");return;}
  $("#refresh-models").disabled=true;
  try {
    const result=await api("models",{});
    state.capabilities.models.available_models=result.available_models;
    state.capabilities.models.model_list_status="advertised";
    $("#grok-model-count").textContent=`${result.available_models.length} 个公布模型`;
    $("#grok-model-candidates").replaceChildren(...result.available_models.map(m=>el("code","model-candidate",m)));
    $("#model-list").replaceChildren(...result.available_models.map(m=>{const o=el("option");o.value=m;return o;}));
    toast("已从当前 Grok 接口获取模型");
  } catch(e){toast(e.message);} finally {$("#refresh-models").disabled=false;}
};
$("#close-drawer").onclick = closeDrawer; $("#drawer-backdrop").onclick = closeDrawer;
function effectiveModel(profile) {
  return state.policy.models[profile] || state.capabilities.models[`${profile}_model`] || (profile === "deep" ? state.capabilities.models.deep_models?.join(", ") : "") || "";
}
function paintModelFields(container) {
  container.replaceChildren();
  for (const profile of ["quick", "balanced", "deep"]) {
    const label = el("label", "label", `${labels[profile]}档模型`);
    const input = document.createElement("input"); input.dataset.profile = profile; input.setAttribute("list", "model-list");
    input.value = state.policy.models[profile]; input.placeholder = effectiveModel(profile) || "填写模型 ID";
    input.setAttribute("aria-label", `${labels[profile]}档模型`);
    label.append(input); container.append(label);
  }
}
$("#models-button").onclick = () => {
  $("#models-save-status").textContent = "";
  $("#default-profile").value = state.policy.defaultProfile; paintModelFields($("#model-fields"));
  if (state.capabilities.models.originalModel) $("#model-fields").append(el("p", "hint", `原配置模型：${state.capabilities.models.originalModel}。档位模型如下，按实际选择执行。`));
  $("#models-dialog").showModal();
};
async function saveModels() {
  if ($("#save-models").disabled) return;
  const p = structuredClone(state.policy); p.defaultProfile = $("#default-profile").value;
  $$("#model-fields input").forEach(i => p.models[i.dataset.profile] = i.value.trim());
  $("#save-models").disabled = true; $("#models-save-status").textContent = "正在保存…";
  try { await save(p); $("#models-dialog").close(); }
  catch (error) { $("#models-save-status").textContent = error.message; toast(error.message); }
  finally { $("#save-models").disabled = false; }
}
bindFormAction("#models-form", "#save-models", saveModels);
$("#close-models").onclick = () => $("#models-dialog").close();
$("#apply-agents").onclick = async () => {
  $("#apply-agents").disabled = true;
  try { state.agents = await api("agents", { ids: $$('#agents-list input:checked').map(x => x.value) }); await load(); toast("应用范围已更新"); }
  catch (e) { error(e.message); } finally { $("#apply-agents").disabled = false; }
};
$("#clear-selection").onclick = () => $$('#test-channels input').forEach(c => c.checked = false);
$("#refresh").onclick = async () => { $("#refresh").disabled = true; try { await api("refresh", {}); await load(); toast("状态已刷新"); } catch (e) { error(e.message); } finally { $("#refresh").disabled = false; } };
$("#history-refresh").onclick = load;
$("#sync-config").onclick = async () => {
  $("#sync-config").disabled = true;
  try { await api("sync", {}); await load(); toast("已同步未覆盖的原配置；本页管理的密钥保持不变"); }
  catch (e) { error(e.message); } finally { $("#sync-config").disabled = false; }
};
$("#channel-filter").oninput = () => state && renderChannels();
$$("[data-filter]").forEach(b => b.onclick = () => { filter = b.dataset.filter; $$("[data-filter]").forEach(x => { x.classList.toggle("active", x === b); x.setAttribute("aria-checked", x===b); }); if (state) renderChannels(); });
$$("[data-tab]").forEach(b => b.onclick = () => changeTab(b.dataset.tab));
$("#route-test").onclick = () => changeTab("test");
$("#agent-node").onclick = () => changeTab("agents");
$("#hub-node").onclick = () => $("#models-button").click();
$$("[data-history]").forEach(b => b.onclick = () => { historyFilter = b.dataset.history; $$("[data-history]").forEach(x => { x.classList.toggle("active", x === b); x.setAttribute("aria-checked", x===b); }); if (state) renderHistory(); });
$$("[data-back]").forEach(b => b.onclick = () => changeTab("channels"));
// The service navigates inside the original Magpie iframe. Rejoin its theme
// bridge after navigation; the host authenticates the existing frame by source.
function applyHostTheme(theme) {
  if (typeof theme?.dark !== "boolean") return;
  const root = document.body;
  root.dataset.theme = theme.dark ? "dark" : "light";
  const map = { bg: "page", card: "surface", fg: "text", muted: "text-2", line: "line",
    accent: "agent", "accent-soft": "agent-soft", green: "ok", red: "err", amber: "warn", font: "font" };
  for (const [host, local] of Object.entries(map)) {
    if (typeof theme.tokens?.[host] === "string") root.style.setProperty(`--${local}`, theme.tokens[host]);
  }
  $$("img[data-brand]").forEach(img => { const files = brandFiles[img.dataset.brand]; img.src = "vendor/dsh/logos/" + (theme.dark ? files[1] || files[0] : files[0]); });
}
if (window.parent !== window) {
  const helloId = `search-center-theme-${Date.now()}`;
  addEventListener("message", event => {
    if (event.source !== window.parent || event.data?.magpie !== 1) return;
    if (event.data.event === "theme") applyHostTheme(event.data.data);
    else if (event.data.id === helloId) applyHostTheme(event.data.result);
  });
  window.parent.postMessage({ magpie: 1, id: helloId, method: "hello" }, "*");
} else {
  // Standalone development preview only; no separate user preference.
  const system = matchMedia("(prefers-color-scheme: dark)");
  const update = () => applyHostTheme({ dark: system.matches });
  update(); system.addEventListener("change", update);
}
new ResizeObserver(() => requestAnimationFrame(drawRoutes)).observe($("#route-stage"));
document.addEventListener("keydown", e => {
  if (e.key === "Escape") closeDrawer();
  if (e.key === "Tab" && editing) {
    const targets = [...$("#drawer").querySelectorAll("button,input,select")].filter(x => !x.disabled && x.getClientRects().length);
    if (e.shiftKey && document.activeElement === targets[0]) { e.preventDefault(); targets.at(-1).focus(); }
    else if (!e.shiftKey && document.activeElement === targets.at(-1)) { e.preventDefault(); targets[0].focus(); }
  }
});
load();
setInterval(() => {
  if (document.visibilityState === "visible" && currentTab === "channels" && !reloadBlocked())
    void load();
}, 10000);
