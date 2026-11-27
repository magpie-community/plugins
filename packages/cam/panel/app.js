const $ = (id) => document.getElementById(id);
let current = null;
let saving = false;
let observer = null;
let detailSequence = 0;
let live = { sessions: [], details: {} };
let refreshing = null;
let renderedSessions = null;
let cardSession = null;
const sessionRows = new Map();
const imageCards = new Map();

function toast(message, error = false) {
  const el = $("toast");
  el.textContent = message;
  el.className = "toast show" + (error ? " error" : "");
  clearTimeout(el.timer);
  el.timer = setTimeout(() => (el.className = "toast"), 2600);
}

function loadLive() {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    const timer = setTimeout(() => { script.remove(); reject(new Error("live.js 加载超时")); }, 5000);
    script.src = "live.js?" + Date.now();
    script.onload = () => {
      clearTimeout(timer);
      live = globalThis.__MAGPIE_CAM_LIVE__ || { sessions: [], details: {} };
      script.remove();
      resolve();
    };
    script.onerror = () => {
      clearTimeout(timer);
      script.remove();
      if (!live.sessions.length) resolve();
      else reject(new Error("live.js 加载失败"));
    };
    document.head.append(script);
  });
}

function effectivePolicy(detail, options) {
  const legacy = detail.legacyPolicy || { pinnedContentIds: [] };
  const base = { ...legacy, auto: typeof legacy.auto === "boolean" ? legacy.auto : options.auto !== false };
  const override = options.sessionPolicies?.[detail.session.key];
  if (!override || typeof override !== "object" || Array.isArray(override)) return base;
  const nativeTime = typeof override.updatedAt === "string" ? Date.parse(override.updatedAt) : NaN;
  if (override.version !== 2 && (Number.isFinite(nativeTime) ? Date.parse(base.updatedAt) >= nativeTime : base.overridesLegacyNative)) return base;
  return {
    auto: typeof override.auto === "boolean" ? override.auto : base.auto,
    pinnedContentIds: Array.isArray(override.pinnedContentIds)
      ? [...new Set(override.pinnedContentIds.filter((id) => typeof id === "string" && /^[0-9a-f]{64}$/.test(id)))]
      : base.pinnedContentIds,
  };
}

async function readHostOptions() {
  let timer;
  try {
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), 3000); });
    const options = await Promise.race([magpie.options.get(), timeout]);
    return options && typeof options === "object" && !Array.isArray(options) ? options : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function date(value) {
  try { return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
  catch { return ""; }
}

function reconcileChildren(root, nodes) {
  const wanted = new Set(nodes);
  for (const node of Array.from(root.children)) {
    if (!wanted.has(node)) node.remove();
  }
  nodes.forEach((node, index) => {
    const existing = root.children[index];
    if (existing !== node) root.insertBefore(node, existing ?? null);
  });
}

function renderSessions(selected) {
  const sessions = live.sessions;
  const root = $("sessions");
  const keys = new Set(sessions.map((item) => item.key));
  for (const key of sessionRows.keys()) if (!keys.has(key)) sessionRows.delete(key);
  if (!sessions.length) {
    const note = document.createElement("p");
    note.className = "rail-note";
    note.textContent = "还没有附件会话";
    reconcileChildren(root, [note]);
    return;
  }
  const nodes = sessions.map((item) => {
    let row = sessionRows.get(item.key);
    if (!row) {
      const button = document.createElement("button");
      button.dataset.key = item.key;
      const strong = document.createElement("strong");
      const small = document.createElement("small");
      button.append(strong, small);
      button.onclick = () => openSession(item.key);
      row = { button, strong, small };
      sessionRows.set(item.key, row);
    }
    row.button.className = "session" + (item.key === selected ? " active" : "");
    const title = item.title || item.platform + " · " + item.key.slice(0, 8);
    const subtitle = item.platform + " · " + date(item.lastSeen);
    if (row.strong.textContent !== title) row.strong.textContent = title;
    if (row.small.textContent !== subtitle) row.small.textContent = subtitle;
    return row.button;
  });
  reconcileChildren(root, nodes);
}

function loadSessions(background = false) {
  if (refreshing) return refreshing;
  if (saving || (background && (magpie.visible === false || document.hidden || !$("settings").hidden))) return;
  const sequence = detailSequence;
  refreshing = (async () => {
    try {
      await loadLive();
      if (saving || (background && !$("settings").hidden)) return;
      if (!$("settings").hidden) renderStorageUsage();
      const selected = location.hash.slice(1) || current?.session.key;
      const key = Object.hasOwn(live.details, selected) ? selected : live.sessions[0]?.key;
      const signature = JSON.stringify(live.sessions);
      if (signature !== renderedSessions) {
        renderSessions(key);
        renderedSessions = signature;
      }
      if (!key) {
        if (!background || current) renderEmpty("等待第一次请求", "Magpie 处理带附件的对话后，会在这里建立索引。");
        return;
      }
      const detail = live.details[key];
      if (background && sequence !== detailSequence) return;
      if (background && current?.session.key === key) {
        current.session = { ...current.session, lastRequest: detail.session.lastRequest, recentRequests: detail.session.recentRequests, lastSeen: detail.session.lastSeen };
        renderRequestStatus(current.session);
      }
      if (!background || current?.session.key !== key || current.session.title !== detail.session.title
          || JSON.stringify(current.images) !== JSON.stringify(detail.images)
          || JSON.stringify(current.legacyPolicy) !== JSON.stringify(detail.legacyPolicy)) await loadDetail(key, background);
    } catch (error) {
      if (!background && !current) renderEmpty("无法读取会话", error.message);
      else if (!background) toast(error.message, true);
    }
  })().finally(() => { refreshing = null; });
  return refreshing;
}

function gridEmpty(title, note) {
  imageCards.clear();
  observer?.disconnect();
  const grid = $("grid");
  grid.replaceChildren();
  const empty = document.createElement("div");
  empty.className = "empty";
  const strong = document.createElement("strong");
  strong.textContent = title;
  empty.append(strong, document.createTextNode(note));
  grid.append(empty);
}

function renderEmpty(title, note) {
  current = null;
  $("count").textContent = "0";
  $("pinned").textContent = "0";
  $("session-name").textContent = "—";
  renderRequestStatus(null);
  $("auto").checked = false;
  $("auto").indeterminate = false;
  $("auto").disabled = true;
  $("auto-help").textContent = "关闭后保留历史原图。新附件仍会被索引。";
  gridEmpty(title, note);
}

function renderRequestStatus(session) {
  const history = session?.recentRequests?.length ? session.recentRequests : session?.lastRequest ? [{ ...session.lastRequest, at: session.lastSeen }] : [];
  const labels = {
    "session-paused": "自动管理已关闭",
    "agent-paused": "Agent 已暂停",
    "tool-unavailable": "请求未提供可用的 CAM 取图工具",
    "tool-unconfirmed": "Codex 尚未验证取图，已保留原图",
    "over-budget": "有图片超出取图预算",
    "cache-unavailable": "有原图无法从缓存取回",
    "restore-unavailable": "有工具结果未能还原图片",
    "rewrite-skipped": "未执行附件改写",
  };
  $("request-status").textContent = history.map((status) => {
    const { originalBytes, rewrittenBytes } = status;
    const hasSizes = Number.isFinite(originalBytes) && originalBytes > 0 && Number.isFinite(rewrittenBytes);
    const saved = originalBytes - rewrittenBytes;
    return [ date(status.at), "省略原图 " + status.omitted, "固定发送 " + status.pinned,
        "成功解析取图 " + status.restored, ...(status.copiesOmitted ? ["省略历史取回副本 " + status.copiesOmitted] : []),
        ...(hasSizes ? ["原请求 " + formatBytes(originalBytes),
          (saved < 0 ? "净增加 " : "净节省 ") + formatBytes(Math.abs(saved)) + " (" + (Math.abs(saved) / originalBytes * 100).toFixed(1) + "%)"] : ["大小未记录"]),
        ...status.reasons.map((reason) => labels[reason]).filter(Boolean) ].join(" · ");
  }).join("\n") || "暂无处理记录";
}

async function loadDetail(key, background = false) {
  const sequence = ++detailSequence;
  try {
    const detail = live.details[key];
    const options = await readHostOptions();
    if (sequence !== detailSequence || (background && (saving || !$("settings").hidden))) return;
    if (!detail) throw new Error("会话不存在");
    current = { ...detail, policy: options ? effectivePolicy(detail, options) : null, agentPaused: options?.agentAuto?.[detail.session.platform] === false };
    location.hash = key;
    document.querySelectorAll(".session").forEach((el) => el.classList.toggle("active", el.dataset.key === key));
    renderDetail();
  } catch (error) {
    if (sequence === detailSequence) renderEmpty("会话不可用", error.message);
  }
}

function renderDetail() {
  if (!current) return;
  const { session, policy, images, agentPaused } = current;
  $("count").textContent = images.length;
  $("pinned").textContent = policy?.pinnedContentIds.length ?? "—";
  $("session-name").textContent = session.title || session.platform + " · " + session.key.slice(0, 8);
  renderRequestStatus(session);
  $("auto").checked = !agentPaused && (policy?.auto ?? false);
  $("auto").indeterminate = !policy;
  $("auto").disabled = !policy || saving || agentPaused;
  $("auto-help").textContent = agentPaused ? "此 Agent 已在插件设置中暂停自动省略。" : policy ? "关闭后保留历史原图。新附件仍会被索引。" : "无法读取 Magpie 策略，刷新后可重试。";
  const grid = $("grid");
  if (cardSession !== session.key) {
    observer?.disconnect();
    imageCards.clear();
    cardSession = session.key;
  }
  observer ??= new IntersectionObserver((entries) => {
    for (const entry of entries) if (entry.isIntersecting) {
      loadThumb(entry.target);
      observer.unobserve(entry.target);
    }
  }, { rootMargin: "150px" });
  if (!images.length) {
    gridEmpty("这个会话还没有附件", "发送图片后，附件会自动出现在这里。");
    return;
  }
  const keys = new Set(images.map((image) => image.contentId));
  for (const [key, entry] of imageCards) {
    if (keys.has(key)) continue;
    observer.unobserve(entry.thumb);
    imageCards.delete(key);
  }
  const added = [];
  const nodes = images.map((image) => {
    const signature = JSON.stringify(image);
    let entry = imageCards.get(image.contentId);
    if (!entry || entry.signature !== signature) {
      if (entry) observer.unobserve(entry.thumb);
    const card = document.createElement("article");
    card.className = "card";
    const thumb = document.createElement("div");
    thumb.className = "thumb";
    const showThumb = image.stored && image.thumbnail !== null;
    thumb.textContent = showThumb ? "等待载入" : image.stored ? "暂无缩略图" : "原图未缓存";
    thumb.dataset.image = image.id;
    thumb.dataset.session = session.key;
    if (image.thumbnail) thumb.dataset.thumbnail = image.thumbnail;
    const body = document.createElement("div");
    body.className = "card-body";
    const id = document.createElement("div");
    id.className = "id";
    id.textContent = image.id;
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = [image.kind, "第 " + image.turn + " 轮", image.width && image.height ? image.width + " × " + image.height : ""].filter(Boolean).join(" · ");
    const pin = document.createElement("button");
    pin.className = "pin";
    pin.dataset.content = image.contentId;
    pin.onclick = () => togglePin(image.contentId);
    body.append(id, meta, pin);
    card.append(thumb, body);
    entry = { card, thumb, pin, signature };
    imageCards.set(image.contentId, entry);
    if (showThumb) added.push(thumb);
    }
    const pinned = policy?.pinnedContentIds.includes(image.contentId);
    entry.pin.disabled = !policy || saving;
    if (policy) entry.pin.setAttribute("aria-pressed", String(pinned));
    const label = !policy ? "策略暂不可用" : pinned ? "已固定 · 点击取消" : "固定随请求发送";
    if (entry.pin.textContent !== label) entry.pin.textContent = label;
    return entry.card;
  });
  reconcileChildren(grid, nodes);
  added.forEach((thumb) => observer.observe(thumb));
}

function loadThumb(el) {
  const img = document.createElement("img");
  img.alt = el.dataset.image;
  img.onerror = () => { el.textContent = "缩略图不可用"; };
  const image = current?.images.find((item) => item.id === el.dataset.image);
  const extension = image?.mime === "image/jpeg" ? "jpg" : image?.mime === "image/gif" ? "gif" : image?.mime === "image/webp" ? "webp" : "png";
  img.src = el.dataset.thumbnail || `images/${el.dataset.session}/${el.dataset.image}.${extension}`;
  el.replaceChildren(img);
}

async function save(change) {
  if (!current?.policy) return;
  if (saving) {
    renderDetail();
    toast("上一项选择仍在保存，请稍候", true);
    return;
  }
  const detail = current;
  const key = detail.session.key;
  saving = true;
  $("auto").disabled = true;
  document.querySelectorAll(".pin").forEach((button) => (button.disabled = true));
  try {
    const latest = await readHostOptions();
    if (!latest) {
      if (current?.session.key === key) current.policy = null;
      throw new Error("无法读取 Magpie 策略，刷新后可重试。");
    }
    const next = { ...change(effectivePolicy(detail, latest)), version: 2 };
    const sessionPolicies = { ...(latest.sessionPolicies || {}), [key]: next };
    const saved = await magpie.options.set({ ...latest, sessionPolicies });
    if (!current || current.session.key !== key) return;
    current.policy = effectivePolicy(detail, saved ?? { ...latest, sessionPolicies });
    toast("选择已保存，下一次请求生效");
  } catch (error) {
    toast(error.message, true);
  } finally {
    saving = false;
    if (current) renderDetail();
  }
}

function togglePin(contentId) {
  return save((policy) => {
    const pinned = new Set(policy.pinnedContentIds);
    pinned.has(contentId) ? pinned.delete(contentId) : pinned.add(contentId);
    return { auto: policy.auto, pinnedContentIds: [...pinned] };
  });
}

$("auto").onchange = (event) => {
  const auto = event.target.checked;
  return save((policy) => ({ auto, pinnedContentIds: policy.pinnedContentIds }));
};
$("refresh").onclick = () => loadSessions();

function renderSettings(options) {
  $("settings-fields").disabled = !options;
  $("settings-status").textContent = options ? "" : "无法读取设置，请重新打开设置页重试。";
  if (!options) return;
  $("settings-language").value = options.language === "en" ? "en" : "zh";
  $("settings-codex-mode").value = options.codexMode === "compatible" ? "compatible" : "savings";
  $("settings-image-limit").value = Number.isInteger(options.maxFetchImages) ? Math.min(8, Math.max(1, options.maxFetchImages)) : 4;
  $("settings-size-limit").value = Number.isInteger(options.maxFetchBytes) ? Math.min(33554432, Math.max(1024, options.maxFetchBytes)) : 12582912;
  document.querySelectorAll("[data-agent]").forEach((input) => {
    input.checked = options.agentAuto?.[input.dataset.agent] !== false;
  });
}

function showSettings(visible) {
  $("attachments").hidden = visible;
  $("settings").hidden = !visible;
  $("show-attachments").setAttribute("aria-pressed", String(!visible));
  $("show-settings").setAttribute("aria-pressed", String(visible));
  if (visible) {
    renderStorageUsage();
    $("settings-fields").disabled = true;
    return readHostOptions().then(renderSettings);
  }
}

function formatBytes(bytes) {
  return bytes >= 1024 ** 2 ? (bytes / 1024 ** 2).toFixed(1) + " MiB"
    : bytes >= 1024 ? (bytes / 1024).toFixed(1) + " KiB" : bytes + " B";
}

function renderStorageUsage() {
  const totals = live.storage;
  $("storage-usage").textContent = totals
    ? ["原图缓存 " + formatBytes(totals.originals), "会话索引与策略 " + formatBytes(totals.indexes), "面板生成文件 " + formatBytes(totals.panel)].join(" · ")
    : "暂无用量记录";
}

function openSession(key) {
  showSettings(false);
  if (key) {
    location.hash = key;
    return loadDetail(key);
  }
}

async function saveSettings(event) {
  event.preventDefault();
  if (saving || $("settings-fields").disabled || !$("settings-form").reportValidity()) return;
  const agentChoices = Object.fromEntries([...document.querySelectorAll("[data-agent]")].map((input) => [input.dataset.agent, input.checked]));
  const language = $("settings-language").value;
  const codexMode = $("settings-codex-mode").value === "compatible" ? "compatible" : "savings";
  const maxFetchImages = $("settings-image-limit").valueAsNumber;
  const maxFetchBytes = $("settings-size-limit").valueAsNumber;
  saving = true;
  $("settings-fields").disabled = true;
  let latest;
  try {
    latest = await readHostOptions();
    if (!latest) throw new Error("无法读取 Magpie 设置，请重试。");
    const next = { ...latest, agentAuto: { ...latest.agentAuto, ...agentChoices }, codexMode, language, maxFetchImages, maxFetchBytes };
    const saved = await magpie.options.set(next);
    if (current) current.agentPaused = (saved?.agentAuto ?? next.agentAuto)[current.session.platform] === false;
    $("settings-status").textContent = "设置已保存。";
  } catch (error) {
    $("settings-status").textContent = error.message;
  } finally {
    $("settings-fields").disabled = !latest;
    saving = false;
    if (current) renderDetail();
  }
}

$("show-settings").onclick = () => showSettings(true);
$("show-attachments").onclick = () => openSession();
$("settings-form").onsubmit = saveSettings;
magpie.ready.then(async () => {
  await loadSessions();
  setInterval(() => { void loadSessions(true); }, 3000);
  magpie.onVisibility?.((visible) => { if (visible) void loadSessions(true); });
}).catch((error) => renderEmpty("Magpie 页面连接失败", String(error)));
