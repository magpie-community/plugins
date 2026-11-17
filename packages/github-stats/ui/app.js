(() => {
  const form = document.querySelector("#settings"),
    fields = form.elements,
    token = document.querySelector('meta[name="page-token"]').content;
  const $ = (id) => document.getElementById(id);
  let mode = "dark",
    cards = null,
    previewSequence = 0,
    noticeTimer,
    previewTimer,
    savedConfig;
  const booleans = [
    "showCost",
    "showTrend",
    "showHeatmap",
    "showModels",
    "daily",
  ];
  function config() {
    const c = {};
    for (const key of [
      "repository",
      "branch",
      "folder",
      "period",
      "theme",
      "heatmapView",
      "credentialSource",
    ])
      c[key] = fields[key].value.trim();
    for (const key of ["width", "topModels", "magpiePort"])
      c[key] = Number(fields[key].value);
    for (const key of booleans) c[key] = fields[key].checked;
    return c;
  }
  async function api(path, data) {
    const r = await fetch(`api/${path}`, {
      method: data === undefined ? "GET" : "POST",
      headers: {
        "X-Magpie-Stats-Token": token,
        ...(data === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const value = await r.json();
    if (!r.ok) throw new Error(value.error || "请求失败");
    return value;
  }
  function notice(message) {
    $("notice").textContent = message;
    $("notice").hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => ($("notice").hidden = true), 7000);
  }
  function display() {
    if (!cards) return;
    $("preview").src =
      "data:image/svg+xml;base64," +
      btoa(unescape(encodeURIComponent(cards[mode])));
    $("preview").hidden = false;
    $("placeholder").hidden = true;
    $("dark-mode").classList.toggle("selected", mode === "dark");
    $("light-mode").classList.toggle("selected", mode === "light");
    document
      .querySelector(".preview-stage")
      .classList.toggle("light", mode === "light");
  }
  async function preview() {
    const seq = ++previewSequence;
    $("preview-label").textContent = "正在读取…";
    try {
      const r = await api("preview", { config: config() });
      if (seq !== previewSequence) return;
      cards = r;
      display();
      $("summary").textContent =
        `${r.requests.toLocaleString()} 次请求 · ${r.activeDays} 个活跃日`;
      $("preview-label").textContent = "本机真实用量 · 未发布";
    } catch (e) {
      if (seq !== previewSequence) return;
      $("preview-label").textContent = "预览暂不可用";
      $("placeholder").textContent = e.message;
      $("placeholder").hidden = false;
      $("preview").hidden = true;
    }
  }
  function authUI() {
    const gh = fields.credentialSource.value === "github-cli";
    $("token-row").hidden = gh;
    $("cli-note").hidden = !gh;
  }
  async function status(initial = false) {
    const r = await api("status");
    if (initial) {
      savedConfig = r.config;
      for (const [k, v] of Object.entries(r.config)) {
        if (!fields[k]) continue;
        if (booleans.includes(k)) fields[k].checked = v;
        else {
          if (
            fields[k].tagName === "SELECT" &&
            !Array.from(fields[k].options).some((o) => o.value === String(v))
          ) {
            const opt = document.createElement("option");
            opt.value = String(v);
            opt.textContent = String(v);
            fields[k].append(opt);
          }
          fields[k].value = v;
        }
      }
      authUI();
      await preview();
    }
    const s = r.state;
    $("status-title").textContent =
      s.lastResult === "failed"
        ? "上次同步失败"
        : s.lastSuccess
          ? s.lastResult === "unchanged"
            ? "数据未变化，已跳过提交"
            : "已成功同步"
          : "尚未同步";
    $("status-detail").textContent =
      s.error ||
      (s.lastSuccess
        ? `${new Date(s.lastSuccess).toLocaleString()} · ${r.schedule.installed ? "每日调度已启用" : "手动同步模式"}`
        : "保存仓库与授权后即可开始。");
    $("status-dot").style.background = s.error
      ? "#f472b6"
      : s.lastSuccess
        ? "#68d6e7"
        : "#68758a";
  }
  async function busy(button, fn) {
    button.disabled = true;
    try {
      await fn();
    } catch (e) {
      notice(e.message);
    } finally {
      button.disabled = false;
    }
  }
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    busy(form.querySelector("[type=submit]"), async () => {
      const c = config();
      await api("config", { config: c, token: fields.token.value });
      fields.token.value = "";
      savedConfig = c;
      notice("配置已保存");
      await status();
    });
  });
  form.addEventListener("change", (e) => {
    authUI();
    if (
      [
        "period",
        "theme",
        "heatmapView",
        "width",
        "topModels",
        "showCost",
        "showTrend",
        "showHeatmap",
        "showModels",
        "magpiePort",
      ].includes(e.target.name)
    ) {
      clearTimeout(previewTimer);
      previewTimer = setTimeout(preview, 300);
    }
  });
  $("sync").addEventListener("click", () =>
    busy($("sync"), async () => {
      if (
        JSON.stringify(config()) !== JSON.stringify(savedConfig) &&
        Object.keys(config()).some((k) => config()[k] !== savedConfig?.[k])
      )
        throw new Error("设置已修改，请先保存配置再同步。");
      const r = await api("sync", {});
      notice(
        r.changed
          ? `已更新 ${r.changed} 张 GitHub 卡片`
          : "数据未变化，没有创建提交",
      );
      await status();
    }),
  );
  $("copy").addEventListener("click", () =>
    busy($("copy"), async () => {
      const r = await api("readme");
      $("readme").value = r.html;
      try {
        await navigator.clipboard.writeText(r.html);
        notice("README HTML 已复制");
      } catch {
        $("readme").focus();
        $("readme").select();
        try {
          if (!document.execCommand("copy")) throw new Error();
          notice("README HTML 已复制");
        } catch {
          notice("代码已选中，请按 Ctrl/Cmd+C 复制。");
        }
      }
    }),
  );
  $("dark-mode").addEventListener("click", () => {
    mode = "dark";
    display();
  });
  $("light-mode").addEventListener("click", () => {
    mode = "light";
    display();
  });
  status(true).catch((e) => {
    $("placeholder").textContent = e.message;
    notice(e.message);
  });
  setInterval(() => {
    if (!document.hidden) status().catch(() => {});
  }, 15000);
})();
