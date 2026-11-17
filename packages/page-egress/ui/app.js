const query = (selector) => document.querySelector(selector);
const token = query('meta[name="egress-token"]').content;
let current;
let loading = false;
let confirmAction = null;
const statusNames = { ok: "连接正常", failed: "检测失败", missing: "代理丢失", changed: "IP 已变化", unchecked: "尚未检测", unmeasured: "未检测" };
const escapeHTML = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const time = (value) => value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "尚未检测";

async function api(route, body) {
  const response = await fetch(new URL(`api/${route}`, location.href), {
    method: body === undefined ? "GET" : "POST",
    headers: { "X-Egress-Token": token, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error || "请求失败");
  return data;
}

function notice(message, error = false) {
  query("#notice").hidden = !message;
  query("#notice").className = error ? "error" : "";
  query("#notice").textContent = message;
}

function badge(state) {
  return `<span class="badge ${escapeHTML(state)}">${statusNames[state] || "未检测"}</span>`;
}

function exitInfo(exit) {
  const address = exit.ip || exit.address || (exit.kind === "direct" ? "出口以 VPS 当前网络为准" : "等待检测");
  return `<div class="exit-info"><span>${escapeHTML(exit.label)}</span><span>·</span><span>${escapeHTML(address)}</span>${badge(exit.state)}</div>`;
}

function proxyCard(proxy) {
  const state = !proxy.check ? "unchecked" : !proxy.check.ok ? "failed" : proxy.changed ? "changed" : "ok";
  const previous = proxy.lastGood && !proxy.check?.ok ? "上次成功出口" : "实测出口";
  return `<article class="proxy-card ${proxy.changed || proxy.check?.ok === false ? "alert" : ""}">
    <div class="proxy-title"><h3>${escapeHTML(proxy.name)}</h3>${badge(state)}</div>
    <div class="proxy-address">${escapeHTML(proxy.url)}</div>
    <div class="proxy-ip">${escapeHTML(proxy.lastGood?.ip || "等待检测")}</div>
    <div class="muted small">${previous}${proxy.lastGood?.loc ? ` · ${escapeHTML(proxy.lastGood.loc)}` : ""}${proxy.check?.ok ? ` · ${proxy.check.ms} ms` : ""}</div>
    <div class="proxy-meta">检测于 ${time(proxy.check?.at)}<br>绑定位置 ${proxy.uses.length} 处 · ${proxy.hasPass || proxy.user ? "账号认证" : "无账号认证 / 白名单"}</div>
    ${proxy.changed ? `<p class="alert-text">原确认 IP：${escapeHTML(proxy.expectedIp)}。代理出口已发生变化。</p>` : ""}
    ${proxy.check?.error ? `<p class="alert-text">${escapeHTML(proxy.check.error)}</p>` : ""}
    <div class="buttons">
      <button class="secondary" data-action="check" data-id="${escapeHTML(proxy.id)}">检测 IP</button>
      <button class="secondary" data-action="edit" data-id="${escapeHTML(proxy.id)}">编辑</button>
      ${proxy.changed && proxy.check?.ok ? `<button class="secondary" data-action="acknowledge" data-id="${escapeHTML(proxy.id)}">认可新 IP</button>` : ""}
      ${!proxy.uses.length ? `<button class="secondary" data-action="delete" data-id="${escapeHTML(proxy.id)}">删除</button>` : ""}
    </div>
  </article>`;
}

function choices(value, kind) {
  const options = [
    ["", kind === "provider" ? "继承全局设置" : "继承供应商"],
    ["direct", "VPS 直连"],
    ...current.proxies.map((proxy) => [`@${proxy.id}`, `${proxy.name}${proxy.lastGood?.ip ? ` · ${proxy.lastGood.ip}` : ""}`])
  ];
  if (!options.some(([choice]) => choice === value)) options.push([value, value.startsWith("@") ? "当前：代理已丢失" : "当前：自定义代理"]);
  return options.map(([choice, label]) => `<option value="${escapeHTML(choice)}"${choice === value ? " selected" : ""}>${escapeHTML(label)}</option>`).join("");
}

function bindingForm(provider, account) {
  const kind = account?.kind || "provider";
  const choice = account?.choice ?? provider.choice;
  return `<div class="binding-form" data-provider="${escapeHTML(provider.id)}" data-kind="${kind}" data-account="${escapeHTML(account?.id || "")}" data-original="${escapeHTML(choice)}">
    <div class="binding-actions"><select aria-label="${escapeHTML(account?.name || provider.name)} 的代理出口"${provider.editable ? "" : " disabled"}>${choices(choice, kind)}</select><button type="button" data-action="save-binding" disabled>保存</button></div>
  </div>`;
}

function renderProviders() {
  const search = query("#search").value.trim().toLowerCase();
  const providers = current.providers.filter((provider) => JSON.stringify(provider).toLowerCase().includes(search));
  query("#provider-list").innerHTML = providers.map((provider) => `<article class="provider" data-id="${escapeHTML(provider.id)}">
    <div class="provider-head">
      <div><div class="provider-label"><h3>${escapeHTML(provider.name)}</h3>${provider.off ? '<span class="badge">已停用</span>' : ""}${provider.plugin ? '<span class="badge">社区认证插件</span>' : ""}</div><div class="provider-id">${escapeHTML(provider.id)}</div>${exitInfo(provider.exit)}</div>
      ${bindingForm(provider)}
    </div>
    ${!provider.editable ? '<p class="muted small">该供应商尚未保存配置，请先在 Magpie 供应商页面保存一次。</p>' : ""}
    ${provider.accounts.length ? `<div class="accounts">${provider.accounts.map((account) => `<div class="account">
      <div class="account-name-wrap"><div class="account-name">${escapeHTML(account.name)}${account.kind === "key" ? '<span class="badge">API Key</span>' : ""}${!account.on ? '<span class="badge">已停用</span>' : ""}</div>${exitInfo(account.exit)}</div>
      ${bindingForm(provider, account)}
    </div>`).join("")}</div>` : ""}
  </article>`).join("") || '<p class="empty">没有匹配的供应商或账号。</p>';
}

function eventText(event) {
  const proxy = current.proxies.find((item) => item.id === event.proxy);
  const name = proxy?.name || event.proxy || "";
  const provider = current.providers.find((item) => item.id === event.provider);
  const choice = event.choice?.startsWith("@") ? current.proxies.find((item) => item.id === event.choice.slice(1))?.name || "已删除的代理" :
    event.choice === "direct" ? "VPS 直连" : "继承设置";
  if (event.type === "ip-change") return `${name}：${event.before} → ${event.after}`;
  if (event.type === "failure") return `${name}：检测失败`;
  if (event.type === "acknowledge") return `${name}：已认可当前出口 IP`;
  if (event.type === "binding") return `${provider?.name || event.provider}${event.account ? ` / ${event.account}` : ""}：已绑定 ${choice}`;
  return "代理设置已更新";
}

function render() {
  query("#proxy-count").textContent = current.proxies.length;
  query("#provider-count").textContent = current.providers.length;
  query("#alert-count").textContent = current.proxies.filter((proxy) => proxy.changed || proxy.check?.ok === false).length;
  query("#default-exit").textContent = current.global.exit.label;
  query("#proxy-list").innerHTML = current.proxies.length ? current.proxies.map(proxyCard).join("") :
    '<div class="empty">尚未登记代理出口。添加后，可以在下面按供应商或账号选择。<br><button data-action="add">添加第一个出口</button></div>';
  renderProviders();
  query("#events").innerHTML = current.events.map((event) => `<div class="event"><span>${escapeHTML(eventText(event))}</span><time>${time(event.at)}</time></div>`).join("") || '<p class="muted">暂无事件。首次成功检测会记录代理的基准 IP。</p>';
  query("#updated-at").textContent = `更新于 ${time(current.checkedAt)}`;
}

async function load(quiet = false) {
  if (loading) return;
  loading = true;
  query("#refresh").disabled = true;
  try { current = await api("state"); render(); if (!quiet) notice(""); }
  catch (error) { notice(error.message, true); }
  finally { loading = false; query("#refresh").disabled = false; }
}

function openEditor(proxy) {
  for (const input of query("#proxy-form").querySelectorAll("input")) {
    if (input.type === "checkbox") input.checked = false;
    else input.value = "";
  }
  query("#form-error").textContent = "";
  query("#dialog-title").textContent = proxy ? "编辑出口" : "添加出口";
  query("#proxy-id").value = proxy?.id || "";
  query("#proxy-name").value = proxy?.name || "";
  query("#proxy-url").value = proxy?.url || "";
  query("#proxy-user").value = proxy?.user || "";
  query("#proxy-pass").placeholder = proxy?.hasPass ? "留空保留现有密码" : "白名单认证可留空";
  query("#clear-pass").closest("label").hidden = !proxy?.hasPass;
  query("#proxy-dialog").showModal();
  query("#proxy-name").focus();
}

function confirm(title, text, action) {
  query("#confirm-title").textContent = title;
  query("#confirm-text").textContent = text;
  confirmAction = action;
  query("#confirm-dialog").showModal();
}

async function perform(button, operation, success) {
  if (button) button.disabled = true;
  try { await operation(); await load(true); notice(success); }
  catch (error) { notice(error.message, true); }
  finally { if (button?.isConnected) button.disabled = false; }
}

query("#refresh").addEventListener("click", () => load());
query("#search").addEventListener("input", () => { if (current) renderProviders(); });
query("#add-proxy").addEventListener("click", () => openEditor());
query("#check-all").addEventListener("click", (event) => perform(event.target, async () => {
  const results = await api("check-all", {});
  if (results.some((result) => !result.ok)) throw new Error("部分出口检测失败，请刷新查看状态");
}, "所有出口已检测"));

query("#proxy-list").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const proxy = current.proxies.find((item) => item.id === button.dataset.id);
  const action = button.dataset.action;
  if (action === "add") return openEditor();
  if (!proxy) return;
  if (action === "edit") return openEditor(proxy);
  if (action === "check") return perform(button, async () => {
    const result = await api("check", { id: proxy.id });
    if (!result.ok) { await load(true); throw new Error(result.error || "代理检测失败"); }
  }, "出口 IP 已检测");
  if (action === "acknowledge") return confirm("认可新的出口 IP", `将 ${proxy.name} 的基准 IP 更新为 ${proxy.lastGood.ip}。账号绑定保持当前选择。`,
    () => perform(button, () => api("acknowledge", { id: proxy.id }), "已认可新的出口 IP"));
  if (action === "delete") return confirm("删除出口", `删除“${proxy.name}”。只有没有被使用的代理可以删除。`,
    () => perform(button, () => api("proxies/delete", { id: proxy.id }), "出口已删除"));
});

query("#provider-list").addEventListener("change", (event) => {
  const form = event.target.closest(".binding-form");
  if (!form) return;
  const dirty = form.querySelector("select").value !== form.dataset.original;
  form.classList.toggle("dirty", dirty);
  form.querySelector("button").disabled = !dirty;
});

query("#provider-list").addEventListener("click", (event) => {
  if (!event.target.closest('button[data-action="save-binding"]')) return;
  event.preventDefault();
  const form = event.target.closest(".binding-form");
  if (!form) return;
  const provider = current.providers.find((item) => item.id === form.dataset.provider);
  const select = form.querySelector("select");
  const account = provider.accounts.find((item) => item.id === form.dataset.account && item.kind === form.dataset.kind);
  confirm("更改出口绑定", `将 ${provider.name}${account ? ` / ${account.name}` : " 的默认出口"} 设置为“${select.selectedOptions[0].textContent}”。后续请求使用新设置，已经发出的请求继续完成。`,
    () => perform(form.querySelector("button"), () => api("binding", {
      provider: provider.id, kind: form.dataset.kind, account: form.dataset.account,
      choice: select.value, revision: provider.revision
    }), "出口绑定已保存"));
});

query("#save-proxy").addEventListener("click", async (event) => {
  event.preventDefault();
  const button = query("#save-proxy");
  button.disabled = true;
  query("#form-error").textContent = "";
  for (const input of query("#proxy-form").querySelectorAll("input[required]")) {
    if (!input.reportValidity()) { button.disabled = false; return; }
  }
  const body = {
    id: query("#proxy-id").value || undefined, name: query("#proxy-name").value,
    url: query("#proxy-url").value, user: query("#proxy-user").value
  };
  if (query("#clear-pass").checked) body.pass = "";
  else if (query("#proxy-pass").value) body.pass = query("#proxy-pass").value;
  try {
    await api("proxies/save", body);
    query("#proxy-pass").value = "";
    query("#proxy-dialog").close();
    await load(true);
    notice("出口已保存，可以检测 IP 并为账号选择此出口");
  } catch (error) { query("#form-error").textContent = error.message; }
  finally { button.disabled = false; }
});

for (const selector of ["#close-dialog", "#cancel-dialog"]) query(selector).addEventListener("click", () => query("#proxy-dialog").close());
query("#proxy-dialog").addEventListener("close", () => { query("#proxy-pass").value = ""; });
query("#confirm-cancel").addEventListener("click", () => { confirmAction = null; query("#confirm-dialog").close(); });
query("#confirm-submit").addEventListener("click", (event) => {
  event.preventDefault();
  const action = confirmAction;
  confirmAction = null;
  query("#confirm-dialog").close();
  action?.();
});
query("#proxy-form").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && event.target.matches("input")) {
    event.preventDefault();
    query("#save-proxy").click();
  }
});
setInterval(() => {
  if (!document.hidden && !document.querySelector("dialog[open]") && !document.querySelector(".binding-form.dirty")) load(true);
}, 30000);
load();
