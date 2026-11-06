(() => {
  document.body.dataset.app = "ready";
  const query = new URLSearchParams(location.search);
  const meta = document.querySelector('meta[name="atomcode-token"]');
  const token = meta?.content || "";
  const locale = (
    query.get("lang") ||
    document.documentElement.lang ||
    "en"
  ).toLowerCase().startsWith("zh")
    ? "zh"
    : "en";
  const text = {
    en: {
      eyebrow: "LOCAL DIAGNOSTICS",
      pageTitle: "Diagnostics",
      loading: "Loading local snapshot…",
      refreshing: "Refreshing snapshot…",
      ready: "Snapshot ready",
      failed: "Snapshot unavailable",
      loadFailedTitle: "Could not load diagnostics",
      loadFailedSummary: "The page opened, but the local service did not return a usable snapshot.",
      refreshFailedTitle: "Latest refresh failed",
      refreshFailedSummary: "The earlier snapshot is still shown. Retry when the diagnostics service is available.",
      healthLoading: "Loading local snapshot",
      localOnly: "This view reads local state only. It does not test the AtomCode upstream.",
      localReadyTitle: "Local diagnostics are ready",
      localReadySummary: "The page can read this computer's saved AtomCode state. Upstream availability is not tested here.",
      noAccountTitle: "No account snapshot",
      noAccountSummary: "Sign in to AtomCode in Magpie, then refresh this snapshot.",
      recentErrorTitle: "A recent error needs attention",
      recentErrorSummary: "Review the redacted error, run the offline self-check, or copy the report before asking for help.",
      checkFailedTitle: "Offline self-check failed",
      checkFailedSummary: "The signing or version configuration needs attention. Check the failing item below.",
      refresh: "Refresh snapshot",
      selfCheck: "Run offline self-check",
      checking: "Running offline self-check…",
      checkPassedChip: "Self-check passed",
      checkFailedChip: "Self-check failed",
      account: "Account",
      models: "Models",
      version: "Version",
      lastRefresh: "Last refresh",
      quotaReadout: "QUOTA WINDOWS",
      quotaTitle: "Current quota snapshot",
      stale: "Historical snapshot",
      plan: "Plan",
      captured: "Captured",
      noQuota: "No successful quota snapshot has been recorded yet.",
      catalogKicker: "PROVIDER STATE",
      catalogTitle: "Catalog and account",
      modelCatalog: "Model catalog",
      noModels: "No model catalog has been recorded yet.",
      namesUnavailable: "Model names are unavailable.",
      selfCheckTitle: "OFFLINE SELF-CHECK",
      signature: "Signature and configuration",
      notRun: "Not run in this session",
      checkHint: "Run the check to verify signing and the local version configuration.",
      checkOk: "Signature and configuration checks passed",
      checkFailed: "Offline self-check failed",
      checkedAt: "Checked {time} · {ms} ms",
      checkSignature: "Signature",
      checkVersion: "Version",
      checkConfiguration: "Configuration",
      pass: "pass",
      fail: "fail",
      errorTitle: "LAST ERROR",
      redacted: "Redacted record",
      noError: "No recorded error",
      noErrorHint: "This only reflects the last locally recorded failure.",
      technicalKicker: "TECHNICAL DETAILS",
      technicalTitle: "Runtime and snapshot metadata",
      generated: "Generated",
      runtime: "Runtime",
      platform: "Platform",
      schema: "State schema",
      diagnosticsPort: "Diagnostics port",
      modelSource: "Model source",
      versionSource: "Version source",
      autoClaim: "Auto claim",
      autoVersion: "Auto version",
      readOnly: "Read only",
      privacy: "Read-only. No request is sent to AtomGit from this page. Tokens, emails, prompts and raw responses are never included.",
      copy: "Copy redacted report",
      copied: "Report copied",
      copyFailed: "Could not copy the report.",
      noSnapshot: "There is no loaded snapshot to copy yet.",
      startupFailedTitle: "Diagnostics page could not initialize",
      startupFailedSummary:
        "The page loaded, but a browser compatibility check failed. Refresh after updating Magpie, or reopen the diagnostics page.",
      startupFailedStatus: "Page initialization failed",
      connected: "Connected",
      notConnected: "No snapshot",
      loginBrowser: "Browser sign-in",
      loginCli: "AtomCode CLI sign-in",
      loginMethod: "Sign-in method",
      unknown: "Unknown",
      live: "Live catalog",
      cached: "Cached catalog",
      builtIn: "Built-in catalog",
      manifest: "Official manifest",
      fallback: "Built-in fallback",
      enabled: "Enabled",
      disabled: "Disabled",
      yes: "Yes",
      no: "No",
      modelsCount: "{count} models",
      modelCountOne: "1 model",
      capturedAt: "Captured {time}",
      updatedAt: "Updated {time}",
      checkedAtShort: "Checked {time}",
      usedPercent: "{used}% used",
      quotaUnknown: "Usage unavailable",
      resetUnknown: "Reset time unavailable",
      resetNow: "Resetting now",
      quotaWindowLabel: "{name} usage",
      reportTitle: "AtomCode diagnostics report",
      reportQuotaWindow: "Quota window",
      reportSelfCheck: "Offline self-check",
      reportLastError: "Last error",
      reportRuntime: "Runtime",
      seconds: "{value}s",
      minutes: "{value} min",
      hours: "{value} hr",
      days: "{value} d",
    },
    zh: {
      eyebrow: "本地诊断",
      pageTitle: "诊断",
      loading: "正在读取本机快照…",
      refreshing: "正在刷新快照…",
      ready: "快照已就绪",
      failed: "快照不可用",
      loadFailedTitle: "无法加载诊断信息",
      loadFailedSummary: "页面已打开，但本机服务没有返回可用的快照。",
      refreshFailedTitle: "最近一次刷新失败",
      refreshFailedSummary: "页面仍显示之前的快照。诊断服务恢复后可再次重试。",
      healthLoading: "正在读取本地快照",
      localOnly: "这里只读取本机状态，不会测试 AtomCode 上游是否可用。",
      localReadyTitle: "本地诊断数据已就绪",
      localReadySummary: "页面已读到这台电脑保存的 AtomCode 状态；上游是否可用不在此页测试。",
      noAccountTitle: "暂无账号快照",
      noAccountSummary: "请先在 Magpie 中登录 AtomCode，然后刷新此快照。",
      recentErrorTitle: "最近有错误记录，请确认是否已恢复",
      recentErrorSummary: "可查看下方脱敏错误、运行离线自检，或在求助前复制诊断报告。",
      checkFailedTitle: "离线自检未通过",
      checkFailedSummary: "签名或版本配置需要处理，请查看下方未通过的项目。",
      refresh: "刷新快照",
      selfCheck: "运行离线自检",
      checking: "正在运行离线自检…",
      checkPassedChip: "自检通过",
      checkFailedChip: "自检未通过",
      account: "账号",
      models: "模型",
      version: "版本",
      lastRefresh: "最近刷新",
      quotaReadout: "额度窗口",
      quotaTitle: "当前额度快照",
      stale: "历史快照",
      plan: "套餐",
      captured: "记录时间",
      noQuota: "尚未记录成功的额度快照。",
      catalogKicker: "供应商状态",
      catalogTitle: "模型目录与账号",
      modelCatalog: "模型目录",
      noModels: "尚未记录模型目录。",
      namesUnavailable: "暂时无法获取模型名称。",
      selfCheckTitle: "离线自检",
      signature: "签名与配置",
      notRun: "本次会话尚未运行",
      checkHint: "运行后会检查请求签名与本机版本配置。",
      checkOk: "签名与配置检查通过",
      checkFailed: "离线自检未通过",
      checkedAt: "检查于 {time} · {ms} ms",
      checkSignature: "请求签名",
      checkVersion: "版本号",
      checkConfiguration: "配置",
      pass: "通过",
      fail: "未通过",
      errorTitle: "最近错误",
      redacted: "已脱敏记录",
      noError: "尚未记录错误",
      noErrorHint: "这里只反映最近一次写入本机的失败记录。",
      technicalKicker: "技术详情",
      technicalTitle: "运行时与快照元数据",
      generated: "生成时间",
      runtime: "运行时",
      platform: "平台",
      schema: "状态版本",
      diagnosticsPort: "诊断端口",
      modelSource: "模型来源",
      versionSource: "版本来源",
      autoClaim: "自动领取",
      autoVersion: "自动追版本",
      readOnly: "只读模式",
      privacy: "只读页面。不会从这里请求 AtomGit。页面不包含令牌、邮箱、提示词或原始响应。",
      copy: "复制脱敏报告",
      copied: "报告已复制",
      copyFailed: "复制报告失败。",
      noSnapshot: "目前还没有可复制的快照。",
      startupFailedTitle: "诊断页初始化失败",
      startupFailedSummary: "页面已加载，但浏览器兼容性检查未通过。请更新 Magpie 后刷新，或重新打开诊断页。",
      startupFailedStatus: "页面初始化失败",
      connected: "已连接",
      notConnected: "暂无快照",
      loginBrowser: "浏览器登录",
      loginCli: "AtomCode CLI 登录",
      loginMethod: "登录方式",
      unknown: "未知",
      live: "实时目录",
      cached: "缓存目录",
      builtIn: "内置目录",
      manifest: "官方清单",
      fallback: "内置回退",
      enabled: "已开启",
      disabled: "已关闭",
      yes: "是",
      no: "否",
      modelsCount: "{count} 个模型",
      modelCountOne: "1 个模型",
      capturedAt: "记录于 {time}",
      updatedAt: "更新于 {time}",
      checkedAtShort: "检查于 {time}",
      usedPercent: "已用 {used}%",
      quotaUnknown: "暂无用量数据",
      resetUnknown: "暂无重置时间",
      resetNow: "即将重置",
      quotaWindowLabel: "{name} 用量",
      reportTitle: "AtomCode 诊断报告",
      reportQuotaWindow: "额度窗口",
      reportSelfCheck: "离线自检",
      reportLastError: "最近错误",
      reportRuntime: "运行时",
      seconds: "{value} 秒",
      minutes: "{value} 分钟",
      hours: "{value} 小时",
      days: "{value} 天",
    },
  }[locale];

  const element = (id) => document.getElementById(id);
  const hasOwn = (object, key) =>
    Object.prototype.hasOwnProperty.call(object, key);
  const fill = (value, values) =>
    String(value).replace(/\{(\w+)\}/g, (all, key) =>
      hasOwn(values, key) ? String(values[key]) : all,
    );
  const clear = (node) => {
    while (node.firstChild) node.removeChild(node.firstChild);
  };
  const safeFormat = (factory) => {
    try {
      return factory();
    } catch {
      return undefined;
    }
  };
  const dateTimeFormat = safeFormat(() => new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }));
  const shortTimeFormat = safeFormat(() => new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }));
  const numberFormat = safeFormat(() => new Intl.NumberFormat(locale, {
    maximumFractionDigits: 1,
  }));
  const relativeTimeFormat = safeFormat(() => new Intl.RelativeTimeFormat(locale, {
    numeric: "auto",
    style: "short",
  }));
  const formatNumber = (value) => {
    try {
      return numberFormat?.format(value) ?? String(value);
    } catch {
      return String(value);
    }
  };
  const setText = (id, value) => {
    const node = element(id);
    if (node) node.textContent = value ?? "";
  };
  const formatDate = (value, formatter = dateTimeFormat) => {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    try {
      return formatter?.format(date) ?? date.toISOString();
    } catch {
      return date.toISOString();
    }
  };
  const formatCount = (count) =>
    Number(count) === 1 ? text.modelCountOne : fill(text.modelsCount, {
      count: formatNumber(Number(count) || 0),
    });
  const formatEnabled = (value) => value ? text.enabled : text.disabled;
  const formatYesNo = (value) => value ? text.yes : text.no;
  const modelSource = (value) => ({
    live: text.live,
    cached: text.cached,
    "built-in": text.builtIn,
  }[value] || value || text.unknown);
  const versionSource = (value) => ({
    manifest: text.manifest,
    fallback: text.fallback,
  }[value] || value || text.unknown);
  const loginSource = (value) => ({
    browser: text.loginBrowser,
    "atomcode-cli": text.loginCli,
  }[value] || value || text.unknown);

  function setStatus(message, tone = "info") {
    element("status-text").textContent = message;
    element("status").dataset.tone = tone;
  }

  function setHealth(tone, title, summary) {
    element("overview").dataset.tone = tone;
    setText("health-title", title);
    setText("health-summary", summary);
  }

  function setBusy(id, busy) {
    const button = element(id);
    button.disabled = busy;
    if (busy) button.dataset.busy = "true";
    else delete button.dataset.busy;
  }

  for (const node of document.querySelectorAll("[data-i18n]")) {
    const value = text[node.dataset.i18n];
    if (value) node.textContent = value;
  }
  document.documentElement.lang = locale;
  document.title = locale === "zh" ? "AtomCode 诊断" : "AtomCode diagnostics";

  const theme = query.get("theme");
  if (theme === "dark" || theme === "light") {
    document.documentElement.dataset.theme = theme;
  }
  const allowedTokens = new Set([
    "bg",
    "card",
    "fg",
    "fg-2",
    "muted",
    "faint",
    "line",
    "accent",
    "accent-soft",
    "accent-fg",
    "green",
    "red",
    "amber",
    "font",
    "code",
  ]);
  try {
    const raw = query.get("tokens");
    const tokens = raw
      ? JSON.parse(new TextDecoder().decode(
          Uint8Array.from(atob(raw), (character) => character.charCodeAt(0)),
        ))
      : {};
    for (const [key, value] of Object.entries(tokens)) {
      if (
        allowedTokens.has(key) &&
        typeof value === "string" &&
        value.length < 300 &&
        !/url\s*\(/i.test(value)
      ) {
        document.documentElement.style.setProperty("--" + key, value);
      }
    }
  } catch {}

  let snapshot;
  let localSelfCheck;
  let copyTimer;

  async function api(path, init = {}) {
    const response = await fetch(path, {
      ...init,
      headers: { "x-atomcode-token": token, ...(init.headers || {}) },
      cache: "no-store",
    });
    if (!response.ok) throw new Error("HTTP " + response.status);
    return response.json();
  }

  function renderWindows(windows, generatedAt) {
    const list = element("windows");
    clear(list);
    const baseTime = Date.parse(generatedAt) || Date.now();
    for (const window of windows || []) {
      const item = document.createElement("li");
      item.className = "window";
      const percent = Number(window.used);
      const normalized = Number.isFinite(percent)
        ? Math.max(0, Math.min(100, percent))
        : undefined;
      if (normalized !== undefined && normalized >= 90) item.dataset.level = "danger";
      else if (normalized !== undefined && normalized >= 70) item.dataset.level = "warn";

      const head = document.createElement("div");
      head.className = "window-head";
      const name = document.createElement("strong");
      name.textContent = window.name || text.unknown;
      const usage = document.createElement("span");
      usage.textContent = normalized === undefined
        ? text.quotaUnknown
        : fill(text.usedPercent, {
            used: formatNumber(normalized),
          });
      head.append(name, usage);

      const progress = document.createElement("div");
      progress.className = "progress";
      progress.setAttribute("role", "progressbar");
      progress.setAttribute(
        "aria-label",
        fill(text.quotaWindowLabel, { name: window.name || text.unknown }),
      );
      progress.setAttribute("aria-valuemin", "0");
      progress.setAttribute("aria-valuemax", "100");
      const progressFill = document.createElement("span");
      progressFill.className = "progress-fill";
      if (normalized === undefined) {
        progress.setAttribute("aria-valuetext", window.display || text.quotaUnknown);
      } else {
        progress.setAttribute("aria-valuenow", String(Math.round(normalized)));
        progressFill.style.transform = "scaleX(" + normalized / 100 + ")";
      }
      progress.append(progressFill);

      const meta = document.createElement("div");
      meta.className = "window-meta";
      const display = document.createElement("span");
      display.textContent = window.display ||
        (normalized === undefined ? text.quotaUnknown : usage.textContent);
      const reset = document.createElement("span");
      const resetSecs = Number(window.resetSecs);
      const resetAt = Number.isFinite(resetSecs)
        ? baseTime + resetSecs * 1000
        : Date.parse(window.resetsAt);
      if (Number.isFinite(resetAt)) {
        reset.dataset.resetAt = String(resetAt);
        reset.textContent = formatReset(resetAt);
      } else {
        reset.textContent = text.resetUnknown;
      }
      meta.append(display, reset);
      item.append(head, progress, meta);
      list.append(item);
    }
    element("quota-empty").hidden = Boolean(windows?.length);
    updateCountdowns();
  }

  function formatReset(target) {
    const remaining = target - Date.now();
    if (remaining <= 0) return text.resetNow;
    const seconds = Math.max(1, Math.ceil(remaining / 1000));
    if (seconds < 90) {
      return fill(text.seconds, { value: formatNumber(seconds) });
    }
    if (seconds < 90 * 60) {
      const value = Math.ceil(seconds / 60);
      return relativeTimeFormat?.format(value, "minute") ??
        fill(text.minutes, { value: formatNumber(value) });
    }
    if (seconds < 36 * 60 * 60) {
      const value = Math.ceil(seconds / 3600);
      return relativeTimeFormat?.format(value, "hour") ??
        fill(text.hours, { value: formatNumber(value) });
    }
    const value = Math.ceil(seconds / 86400);
    return relativeTimeFormat?.format(value, "day") ??
      fill(text.days, { value: formatNumber(value) });
  }

  function updateCountdowns() {
    for (const node of document.querySelectorAll("[data-reset-at]")) {
      const target = Number(node.dataset.resetAt);
      if (Number.isFinite(target)) node.textContent = formatReset(target);
    }
  }

  function renderModels(models) {
    const names = Array.isArray(models?.names) ? models.names : [];
    const list = element("models");
    clear(list);
    for (const name of names) {
      const item = document.createElement("li");
      const code = document.createElement("code");
      code.textContent = name;
      item.append(code);
      list.append(item);
    }
    const hasNames = names.length > 0;
    list.hidden = !hasNames;
    element("models-empty").hidden = hasNames || Boolean(models?.count);
    setText(
      "model-count",
      models?.count ? formatCount(models.count) : "",
    );
    if (!hasNames && models?.count) {
      element("models-empty").textContent = text.namesUnavailable;
      element("models-empty").hidden = false;
    } else if (!hasNames) {
      element("models-empty").textContent = text.noModels;
    }
  }

  function renderSelfCheck(check) {
    const block = element("self-check-result");
    const checks = element("self-check-checks");
    clear(checks);
    if (!check) {
      block.dataset.tone = "idle";
      setText("self-check-state", text.notRun);
      setText("self-check-detail", text.checkHint);
      return;
    }
    block.dataset.tone = check.ok ? "good" : "error";
    setText("self-check-state", check.ok ? text.checkOk : text.checkFailed);
    setText(
      "self-check-detail",
      fill(text.checkedAt, {
        time: formatDate(check.at),
        ms: formatNumber(Number(check.ms) || 0),
      }),
    );
    const labels = {
      signature: text.checkSignature,
      version: text.checkVersion,
      configuration: text.checkConfiguration,
    };
    for (const [key, label] of Object.entries(labels)) {
      if (typeof check.checks?.[key] !== "boolean") continue;
      const item = document.createElement("li");
      item.dataset.tone = check.checks[key] ? "good" : "error";
      item.textContent = label + ": " + (check.checks[key] ? text.pass : text.fail);
      checks.append(item);
    }
  }

  function renderLastError(error) {
    const block = element("last-error-card");
    const time = element("last-error-time");
    time.textContent = "";
    time.removeAttribute("datetime");
    if (!error) {
      block.dataset.tone = "idle";
      setText("last-error-title", text.noError);
      setText("last-error-message", text.noErrorHint);
      return;
    }
    block.dataset.tone = "error";
    setText(
      "last-error-title",
      [error.category || text.unknown, error.status ? "HTTP " + error.status : ""]
        .filter(Boolean).join(" · "),
    );
    setText("last-error-message", error.message || text.unknown);
    if (error.at) {
      time.dateTime = String(error.at);
      time.textContent = formatDate(error.at);
    }
  }

  function updateHealth(data) {
    const selfCheck = data?.selfCheck || localSelfCheck;
    if (selfCheck && selfCheck.ok === false) {
      setHealth("error", text.checkFailedTitle, text.checkFailedSummary);
      return;
    }
    if (data?.lastError) {
      setHealth("warn", text.recentErrorTitle, text.recentErrorSummary);
      return;
    }
    if (!data?.account) {
      setHealth("warn", text.noAccountTitle, text.noAccountSummary);
      return;
    }
    setHealth("good", text.localReadyTitle, text.localReadySummary);
  }

  function render(data) {
    snapshot = data;
    document.body.dataset.state = "ready";
    updateHealth(data);

    const account = data.account;
    const models = data.models || {};
    const quota = data.quota;
    const version = data.version || {};
    setText("summary-account", account ? text.connected : text.notConnected);
    setText(
      "summary-models",
      models.count ? formatCount(models.count) : "—",
    );
    setText("summary-version", version.version || "—");
    setText(
      "summary-snapshot",
      data.generatedAt ? formatDate(data.generatedAt, shortTimeFormat) : "—",
    );

    setText("model-source", modelSource(models.source));
    setText(
      "model-detail",
      [
        formatCount(models.count || 0),
        models.updatedAt
          ? fill(text.updatedAt, { time: formatDate(models.updatedAt) })
          : "",
      ].filter(Boolean).join(" · "),
    );
    setText("account-state", account ? text.connected : text.notConnected);
    setText("login-source", account ? loginSource(account.loginSource) : text.unknown);
    setText("version", version.version || "—");
    setText(
      "version-detail",
      [
        versionSource(version.source),
        version.checkedAt
          ? fill(text.checkedAtShort, { time: formatDate(version.checkedAt) })
          : "",
      ].filter(Boolean).join(" · "),
    );

    setText("quota-plan", quota?.plan || "—");
    setText(
      "quota-captured",
      quota?.capturedAt
        ? fill(text.capturedAt, { time: formatDate(quota.capturedAt) })
        : text.noQuota,
    );
    element("stale-badge").hidden = !quota;
    setText("stale-badge", text.stale);
    renderWindows(quota?.windows || [], data.generatedAt);
    renderModels(models);
    renderSelfCheck(data.selfCheck || localSelfCheck);
    renderLastError(data.lastError);

    setText("tech-generated", formatDate(data.generatedAt));
    setText("tech-runtime", data.runtime?.node ? "Node " + data.runtime.node : "—");
    setText("tech-platform", data.runtime?.platform || "—");
    setText("tech-schema", data.schemaVersion ?? "—");
    setText("tech-port", data.config?.diagnosticsPort ?? "—");
    setText("tech-model-source", modelSource(models.source));
    setText("tech-version-source", versionSource(version.source));
    setText(
      "tech-auto-claim",
      data.config?.autoClaim === undefined ? "—" : formatEnabled(data.config.autoClaim),
    );
    setText(
      "tech-auto-version",
      data.config?.autoVersion === undefined ? "—" : formatEnabled(data.config.autoVersion),
    );
    setText(
      "tech-read-only",
      data.config?.readOnly === undefined ? "—" : formatYesNo(data.config.readOnly),
    );
    element("copy").disabled = false;
  }

  async function refresh({ announce = true } = {}) {
    setBusy("refresh", true);
    if (!snapshot) {
      document.body.dataset.state = "loading";
      setHealth("loading", text.healthLoading, text.localOnly);
    }
    if (announce) setStatus(text.refreshing, "loading");
    try {
      render(await api("api/state"));
      if (announce) setStatus(text.ready, "ok");
    } catch (error) {
      if (snapshot) {
        document.body.dataset.state = "ready";
        setHealth(
          "warn",
          text.refreshFailedTitle,
          text.refreshFailedSummary + " " + readableError(error),
        );
      } else {
        document.body.dataset.state = "error";
        setHealth(
          "error",
          text.loadFailedTitle,
          text.loadFailedSummary + " " + readableError(error),
        );
      }
      setStatus(text.failed, "error");
    } finally {
      setBusy("refresh", false);
    }
  }

  async function selfCheck() {
    setBusy("self-check", true);
    setBusy("refresh", true);
    setStatus(text.checking, "loading");
    try {
      const result = await api("api/self-check", { method: "POST" });
      localSelfCheck = result;
      renderSelfCheck(result);
      await refresh({ announce: false });
      setStatus(
        result.ok ? text.checkPassedChip : text.checkFailedChip,
        result.ok ? "ok" : "error",
      );
    } catch (error) {
      setHealth("error", text.checkFailedTitle, text.checkFailedSummary);
      setText("self-check-state", text.checkFailed);
      setText("self-check-detail", readableError(error));
      setStatus(text.failed, "error");
    } finally {
      setBusy("self-check", false);
      setBusy("refresh", false);
    }
  }

  function reportFor(data) {
    const lines = ["# " + text.reportTitle, ""];
    lines.push("- " + text.generated + ": " + formatDate(data.generatedAt));
    lines.push("- " + text.account + ": " + (data.account ? text.connected : text.notConnected));
    if (data.account) {
      lines.push("- " + text.loginMethod + ": " + loginSource(data.account.loginSource));
    }
    const models = data.models || {};
    lines.push(
      "- " + text.models + ": " + formatCount(models.count || 0) +
      " · " + modelSource(models.source),
    );
    for (const name of models.names || []) {
      lines.push("  - `" + String(name).split("`").join("\\`") + "`");
    }
    if (data.quota) {
      lines.push("- " + text.plan + ": " + (data.quota.plan || text.unknown));
      lines.push("- " + text.captured + ": " + formatDate(data.quota.capturedAt));
      for (const window of data.quota.windows || []) {
        const pieces = [window.name || text.unknown];
        if (window.display) pieces.push(window.display);
        else if (Number.isFinite(Number(window.used))) {
          pieces.push(fill(text.usedPercent, { used: formatNumber(Number(window.used)) }));
        }
        if (Number.isFinite(Number(window.resetSecs))) {
          pieces.push(formatReset(Date.now() + Number(window.resetSecs) * 1000));
        }
        lines.push("  - " + text.reportQuotaWindow + ": " + pieces.join(" · "));
      }
    } else {
      lines.push("- " + text.quotaTitle + ": " + text.noQuota);
    }
    lines.push(
      "- " + text.version + ": " + (data.version?.version || text.unknown) +
      " · " + versionSource(data.version?.source),
    );
    if (data.selfCheck) {
      lines.push(
        "- " + text.reportSelfCheck + ": " +
        (data.selfCheck.ok ? text.checkOk : text.checkFailed) +
        " · " + formatDate(data.selfCheck.at),
      );
    } else {
      lines.push("- " + text.reportSelfCheck + ": " + text.notRun);
    }
    if (data.lastError) {
      lines.push(
        "- " + text.reportLastError + ": " +
        [
          data.lastError.category || text.unknown,
          data.lastError.status ? "HTTP " + data.lastError.status : "",
          data.lastError.message || text.unknown,
          formatDate(data.lastError.at),
        ].filter(Boolean).join(" · "),
      );
    } else {
      lines.push("- " + text.reportLastError + ": " + text.noError);
    }
    if (data.runtime) {
      lines.push(
        "- " + text.reportRuntime + ": " +
        [data.runtime.node ? "Node " + data.runtime.node : "", data.runtime.platform || ""]
          .filter(Boolean).join(" · "),
      );
    }
    return lines.join("\n");
  }

  async function writeClipboard(value) {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(value);
        return;
      } catch {}
    }
    const area = document.createElement("textarea");
    area.value = value;
    area.className = "copy-buffer";
    area.setAttribute("readonly", "");
    document.body.append(area);
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    if (!copied) throw new Error("copy failed");
  }

  async function copyReport() {
    if (!snapshot) {
      setStatus(text.noSnapshot, "info");
      return;
    }
    try {
      await writeClipboard(reportFor(snapshot));
      setStatus(text.copied, "ok");
      setText("copy-label", text.copied);
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => setText("copy-label", text.copy), 1600);
    } catch {
      setStatus(text.copyFailed, "error");
    }
  }

  function readableError(error) {
    const message = error instanceof Error ? error.message : String(error ?? "");
    return message.replace(/\s+/g, " ").trim().slice(0, 240);
  }

  function failStartup(error) {
    const detail = readableError(error) || text.unknown;
    document.body.dataset.app = "error";
    document.body.dataset.state = "error";
    setHealth("error", text.startupFailedTitle, text.startupFailedSummary);
    setStatus(text.startupFailedStatus, "error");
    setText("summary-account", text.unknown);
    setText("summary-models", text.unknown);
    setText("summary-version", text.unknown);
    setText("summary-snapshot", "—");
    element("last-error-card").dataset.tone = "error";
    setText("last-error-title", text.startupFailedTitle);
    setText("last-error-message", detail);
    try {
      console.error("AtomCode diagnostics failed to initialize", error);
    } catch {}
  }

  function initialize() {
    element("refresh").addEventListener("click", () => refresh());
    element("self-check").addEventListener("click", selfCheck);
    element("copy").addEventListener("click", copyReport);
    element("copy").disabled = true;
    renderSelfCheck();
    renderLastError();
    setInterval(updateCountdowns, 30_000);
    refresh();
  }

  try {
    initialize();
  } catch (error) {
    failStartup(error);
  }
})();
