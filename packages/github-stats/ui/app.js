(() => {
  const form = document.querySelector("#settings"),
    fields = form.elements;
  let token = document.querySelector('meta[name="page-token"]').content;
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
    "pairBlocks",
  ];
  const blockLabels = {
    trend: ["Token 趋势", "showTrend"],
    models: ["模型排行", "showModels"],
    heatmap: ["用量热力图", "showHeatmap"],
  };
  const list = $("blocks");
  function arrange(row, target) {
    const rows = [...list.children];
    if (!row || !target || row === target) return;
    const down = rows.indexOf(row) < rows.indexOf(target);
    list.insertBefore(row, down ? target.nextSibling : target);
    preview();
  }
  function buildBlocks(keys) {
    list.replaceChildren();
    for (const key of keys) {
      const [title, field] = blockLabels[key];
      const row = document.createElement("div");
      row.draggable = true;
      row.dataset.key = key;
      row.innerHTML = `<span aria-hidden="true">⠿</span><label><input type="checkbox" name="${field}">${title}</label>`;
      for (const [symbol, direction] of [
        ["↑", -1],
        ["↓", 1],
      ]) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = symbol;
        button.setAttribute(
          "aria-label",
          (direction < 0 ? "上移" : "下移") + title,
        );
        button.onclick = () =>
          arrange(
            row,
            direction < 0 ? row.previousElementSibling : row.nextElementSibling,
          );
        row.append(button);
      }
      row.ondragstart = (event) =>
        event.dataTransfer.setData("text/plain", key);
      row.ondragover = (event) => event.preventDefault();
      row.ondrop = (event) => {
        event.preventDefault();
        arrange(
          [...list.children].find(
            (item) =>
              item.dataset.key === event.dataTransfer.getData("text/plain"),
          ),
          row,
        );
      };
      list.append(row);
    }
  }
  function config() {
    const c = {
      blockOrder: [...$("blocks").children].map((row) => row.dataset.key),
    };
    for (const key of [
      "repository",
      "branch",
      "folder",
      "period",
      "theme",
      "heatmapView",
      "heatmapMetric",
      "credentialSource",
    ])
      c[key] = fields[key].value.trim();
    for (const key of ["width", "topModels", "magpiePort"])
      c[key] = Number(fields[key].value);
    for (const key of booleans) c[key] = fields[key].checked;
    return c;
  }
  async function api(path, data, refresh = true) {
    const requestToken = token;
    const r = await fetch(`api/${path}`, {
      method: data === undefined ? "GET" : "POST",
      headers: {
        "X-Magpie-Stats-Token": requestToken,
        ...(data === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    // A new host issues a new page token. Only replay a request rejected
    // before dispatch, and only after reading a different same-service token.
    if (r.status === 403 && refresh) {
      const page = await fetch("./", { cache: "no-store", redirect: "error" });
      const html = new DOMParser().parseFromString(
        await page.text(),
        "text/html",
      );
      const fresh = html.querySelector('meta[name="page-token"]')?.content;
      if (page.ok && fresh && fresh !== requestToken) {
        token = fresh;
        return api(path, data, false);
      }
    }
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
      buildBlocks(r.config.blockOrder);
      $("connection").open = !r.config.repository;
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
        "heatmapMetric",
        "pairBlocks",
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
        Object.entries(config()).some(
          ([key, value]) =>
            JSON.stringify(value) !== JSON.stringify(savedConfig?.[key]),
        )
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
