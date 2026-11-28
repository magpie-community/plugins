(function () {
  "use strict";

  // 双语：中文原文进 t()，英文表在 i18n.js；表里没有就退回中文，所以可以逐屏补。
  var t = (window.RI18N && window.RI18N.t) || function (zh) {
    return zh;
  };

  var params = new URLSearchParams(location.search);
  var theme = params.get("theme") === "light" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", theme);

  // 服务令牌：服务端只在导航响应里把它写进 <meta>，所以别的网站、别的进程递不上来。
  // 每个 /api 请求都要带回去，少一次都会被 403 挡掉。
  var RI_TOKEN = (function () {
    var meta = document.querySelector('meta[name="service-token"]');
    var value = (meta && meta.getAttribute("content")) || "";
    return value === "__SERVICE_TOKEN__" ? "" : value;
  })();
  var tokenWarned = false;
  function tokenWarn() {
    if (tokenWarned) return;
    tokenWarned = true;
    var box = document.createElement("div");
    box.className = "tok-warn";
    box.textContent = t("页面已过期（插件重启过），关掉这一页重新打开就好。");
    box.style.cssText =
      "position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:99;padding:9px 15px;border-radius:10px;" +
      "background:#3a1d1d;color:#ffd9d9;border:1px solid #7c3b3b;font:13px/1.5 system-ui,-apple-system,sans-serif";
    document.body.appendChild(box);
  }
  function riFetch(url, opts) {
    var init = Object.assign({}, opts || {});
    var headers = Object.assign({}, init.headers || {});
    if (RI_TOKEN) headers["X-Route-Insight-Token"] = RI_TOKEN;
    init.headers = headers;
    return fetch(url, init).then(function (response) {
      if (response.status === 403) tokenWarn();
      return response;
    });
  }
  // 检测产物走 iframe（加不了自定义头），所以给它的地址多带一个 ?t=。
  function artPath(id) {
    return "/api/lab/art/" + id + ".html" + (RI_TOKEN ? "?t=" + encodeURIComponent(RI_TOKEN) : "");
  }

  var WINDOWS = [
    ["1h", t("1 小时")],
    ["6h", t("6 小时")],
    ["today", t("今天")],
    ["24h", t("24 小时")],
    ["7d", t("7 天")]
  ];
  var MODE_NAME = { credit: t("积分"), balance: t("余额"), window: t("额度") };
  // 强度显示文案：网关能记到真实 effort 时用它，记不到就按思考 token 派生
  var EFFORT_NAME = {
    none: t("无"),
    minimal: t("极低"),
    low: t("低"),
    medium: t("中"),
    high: t("高"),
    xhigh: t("很高"),
    max: t("最大"),
    ultra: t("极高")
  };
  var TABS = [
    ["byProvider", t("供应商")],
    ["byModel", t("模型")],
    ["byEffort", t("强度")],
    ["byAgent", t("Agent")],
    ["byStop", t("停止")],
    ["byReq", t("分组")]
  ];
  var SELECTS = [
    ["provider", t("供应商")],
    ["model", t("模型")],
    ["effort", t("推理强度")],
    ["agent", t("Agent")]
  ];

  // 缓存用小图标（Segoe UI 里没有合适的单字符，用 SVG 保证各字体下一致）
  var ICONS = {
    bolt:
      '<svg class="ic-svg" viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="M7.1 1 2.5 6.7h2.6L5 11l4.6-5.8H7.1z" fill="currentColor"/></svg>',
    coin:
      '<svg class="ic-svg" viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><circle cx="6" cy="6" r="4.3" fill="none" stroke="currentColor" stroke-width="1.1"/><circle cx="6" cy="6" r="1.5" fill="currentColor"/></svg>',
    clock:
      '<svg class="ic-svg" viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><circle cx="6" cy="6" r="4.3" fill="none" stroke="currentColor" stroke-width="1.1"/><path d="M6 3.5V6l1.9 1.3" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>',
    cache:
      '<svg class="ic-svg" viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><ellipse cx="6" cy="2.9" rx="4.1" ry="1.7" fill="none" stroke="currentColor" stroke-width="1.1"/><path d="M1.9 2.9v3.1c0 .95 1.85 1.7 4.1 1.7s4.1-.75 4.1-1.7V2.9" fill="none" stroke="currentColor" stroke-width="1.1"/><path d="M1.9 6.05v3.05c0 .95 1.85 1.7 4.1 1.7s4.1-.75 4.1-1.7V6.05" fill="none" stroke="currentColor" stroke-width="1.1"/></svg>'
  };

  var st = {
    window: params.get("window") || "today",
    provider: [],
    model: [],
    effort: [],
    agent: [],
    status: "",
    q: "",
    limit: 400,
    paused: false,
    data: null,
    tab: "byProvider",
    view: ["lab", "providers"].indexOf(params.get("view")) >= 0 ? params.get("view") : "board",
    prov: { at: "", cards: null, error: "", icons: {} },
    open: "",
    search: {},
    lab: {
      models: null,
      model: "",
      // 三项默认都勾上：数值指纹看统计纹理、协议审计看服务端记账、动画看画的像不像；
      // 提示词留空 = 用服务端给的默认那句。
      tests: { numfp: true, relay: true, anim: true },
      effort: { audit: "", draw: "" },
      prompt: "",
      promptDefault: "",
      library: null,
      numeric: null,
      result: null,
      running: false,
      error: ""
    }
  };

  function el(id) {
    return document.getElementById(id);
  }

  function esc(value) {
    return String(value === undefined || value === null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function fmtInt(n) {
    var v = Number(n) || 0;
    if (Math.abs(v) >= 1e9) return (v / 1e9).toFixed(2) + "B";
    if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(2) + "M";
    if (Math.abs(v) >= 1e4) return (v / 1e3).toFixed(1) + "K";
    return String(Math.round(v));
  }

  function fmtCount(n) {
    return (Number(n) || 0).toLocaleString("en-US");
  }

  function fmtMs(ms) {
    var v = Number(ms) || 0;
    if (!v) return "—";
    if (v >= 10000) return (v / 1000).toFixed(1) + "s";
    if (v >= 1000) return (v / 1000).toFixed(2) + "s";
    return Math.round(v) + "ms";
  }

  function fmtCredits(v) {
    var n = Number(v) || 0;
    if (!n) return "0";
    if (n >= 1000) return (n / 1000).toFixed(2) + "K";
    if (n >= 10) return n.toFixed(1);
    if (n >= 1) return n.toFixed(2);
    return n.toFixed(3);
  }

  function fmtPct(rate, digits) {
    var n = Number(rate) || 0;
    return (n * 100).toFixed(digits === undefined ? 1 : digits) + "%";
  }

  function ttftTone(ms) {
    var v = Number(ms) || 0;
    if (!v) return "dim";
    if (v <= 5000) return "good";
    if (v <= 15000) return "warn";
    return "bad";
  }

  // 速度按 tok/s 上色：越快越绿，慢到 25 以下就是红。总时长同理。
  function speedTone(v) {
    var n = Number(v) || 0;
    if (!n) return "dim";
    if (n >= 60) return "good";
    if (n >= 25) return "warn";
    return "bad";
  }

  function msTone(ms) {
    var v = Number(ms) || 0;
    if (!v) return "dim";
    if (v <= 8000) return "good";
    if (v <= 22000) return "warn";
    return "bad";
  }

  function hitTone(rate) {
    var v = Number(rate) || 0;
    if (v >= 0.8) return "good";
    if (v >= 0.5) return "warn";
    return "bad";
  }

  function hueFor(text) {
    var hash = 0;
    var s = String(text || "");
    for (var i = 0; i < s.length; i += 1) hash = (hash * 31 + s.charCodeAt(i)) % 100000;
    return hash % 360;
  }

  function nameOf(id) {
    var names = (st.data && st.data.names) || {};
    return names[id] || id;
  }

  // magpie 自己的供应商头像（插件已经 /icons/<hash>.<ext> 代理过，页面 CSP img-src 只放行同源）。
  // 没配图标的渠道（codex 这类内置/额度渠道）就退化成首字母方块：不再内置任何第三方品牌素材
  // —— 以前这里挂过 Codex 应用自带的图标，那是 OpenAI 的资产，不该随这个包分发。
  function iconFor(id) {
    var map = (st.prov && st.prov.icons) || null;
    return (map && map[id]) || "";
  }

  function provTag(id, cls) {
    var name = nameOf(id);
    var icon = iconFor(id);
    var face = icon
      ? '<img class="pv-ic" src="' + esc(icon) + '" alt="" loading="lazy" />'
      : '<span class="pv-ic ph">' + esc(String(name || "?").slice(0, 1)) + "</span>";
    return (
      '<span class="pv' + (cls ? " " + cls : "") + '" data-hue="' + hueFor(id) + '" title="' + esc(id) + '">' +
      face + "<b>" + esc(name) + "</b></span>"
    );
  }

  function bar(ratio, tone) {
    var v = Math.max(0, Math.min(1, Number(ratio) || 0));
    return '<span class="bar" data-v="' + v.toFixed(3) + '" data-tone="' + tone + '"><i></i></span>';
  }

  function paintDynamic(root) {
    var nodes = root.querySelectorAll("[data-v]");
    for (var i = 0; i < nodes.length; i += 1) {
      var node = nodes[i];
      node.style.setProperty("--v", node.getAttribute("data-v"));
      var tone = node.getAttribute("data-tone");
      var colour =
        tone === "good" ? "var(--green)" : tone === "warn" ? "var(--amber)" : tone === "bad" ? "var(--red)" : "var(--blue)";
      node.style.setProperty("--tone", colour);
    }
    var pills = root.querySelectorAll("[data-hue]");
    for (var j = 0; j < pills.length; j += 1) {
      pills[j].style.setProperty("--h", pills[j].getAttribute("data-hue"));
    }
  }

  /* ---------------- 筛选控件 ---------------- */

  function buildWindowSeg() {
    var seg = el("seg");
    seg.innerHTML = "";
    WINDOWS.forEach(function (pair) {
      var button = document.createElement("button");
      button.type = "button";
      button.textContent = pair[1];
      button.setAttribute("data-window", pair[0]);
      if (pair[0] === st.window) button.className = "on";
      button.addEventListener("click", function () {
        st.window = pair[0];
        buildWindowSeg();
        load();
      });
      seg.appendChild(button);
    });
  }

  function buildStatusSeg() {
    var seg = el("statusSeg");
    var options = [["", t("全部")], ["ok", t("成功")], ["fail", t("失败")]];
    seg.innerHTML = "";
    options.forEach(function (pair) {
      var button = document.createElement("button");
      button.type = "button";
      button.textContent = pair[1];
      if (pair[0] === st.status) button.className = "on";
      button.addEventListener("click", function () {
        st.status = pair[0];
        buildStatusSeg();
        load();
      });
      seg.appendChild(button);
    });
  }

  function itemsFor(key) {
    var data = st.data;
    if (!data || !data.facets) return [];
    if (key === "provider") {
      return data.facets.providers.map(function (item) {
        return { value: item.key, label: nameOf(item.key), sub: item.key, n: item.n };
      });
    }
    if (key === "model") {
      var merged = {};
      data.facets.models.forEach(function (item) {
        var parts = String(item.key).split("/");
        var model = parts.slice(1).join("/") || item.key;
        var slot = merged[model] || (merged[model] = { value: model, label: model, sub: parts[0], n: 0 });
        slot.n += item.n;
      });
      return Object.keys(merged)
        .map(function (k) {
          return merged[k];
        })
        .sort(function (a, b) {
          return b.n - a.n;
        });
    }
    if (key === "effort") {
      // 派生档位是服务端拼出来的中文标签（思考·低 等），显示前过一遍本地化表
      return (data.facets.efforts || []).map(function (item) {
        return { value: item.key, label: L(item.key), n: item.n };
      });
    }
    return (data.facets.agents || []).map(function (item) {
      return { value: item.key, label: item.key, n: item.n };
    });
  }

  function selected(key) {
    return st[key] || [];
  }

  function syncButton(key) {
    var wrap = document.querySelector('.ms[data-key="' + key + '"]');
    if (!wrap) return;
    var list = selected(key);
    var button = wrap.querySelector(".ms-btn");
    var label = button.querySelector(".ms-label");
    var count = button.querySelector(".ms-count");
    var base = SELECTS.filter(function (pair) {
      return pair[0] === key;
    })[0][1];
    if (!list.length) {
      label.textContent = base;
      count.hidden = true;
      wrap.classList.remove("active");
      return;
    }
    wrap.classList.add("active");
    if (list.length === 1) {
      label.textContent = key === "provider" ? nameOf(list[0]) : L(list[0]);
      count.hidden = true;
      return;
    }
    label.textContent = base;
    count.hidden = false;
    count.textContent = String(list.length);
  }

  function fillList(key) {
    var wrap = document.querySelector('.ms[data-key="' + key + '"]');
    if (!wrap) return;
    var needle = String(st.search[key] || "").toLowerCase();
    var items = itemsFor(key).filter(function (item) {
      if (!needle) return true;
      return (item.label + " " + (item.sub || "")).toLowerCase().indexOf(needle) >= 0;
    });
    var list = wrap.querySelector(".ms-list");
    if (!items.length) {
      list.innerHTML = '<div class="empty">' + esc(t("没有匹配项")) + "</div>";
    } else {
      var chosen = selected(key);
      list.innerHTML = items
        .map(function (item) {
          var on = chosen.indexOf(item.value) >= 0 ? " on" : "";
          return (
            '<button type="button" class="ms-item' +
            on +
            '" data-value="' +
            esc(item.value) +
            '"><span class="tick"></span><span class="txt">' +
            esc(item.label) +
            (item.sub && item.sub !== item.label ? ' <span class="dim">' + esc(item.sub) + "</span>" : "") +
            '</span><span class="cnt">' +
            fmtCount(item.n) +
            "</span></button>"
          );
        })
        .join("");
    }
    syncButton(key);
  }

  function createSelect(key, label) {
    var wrap = document.createElement("div");
    wrap.className = "ms";
    wrap.setAttribute("data-key", key);
    wrap.innerHTML =
      '<button type="button" class="ms-btn"><span class="ms-label">' +
      label +
      '</span><span class="ms-count" hidden></span><i class="ms-caret"></i></button>' +
      '<div class="ms-panel" hidden><input class="ms-q" type="search" placeholder="' +
      esc(t("搜索…")) +
      '" /><div class="ms-tools"><button type="button" data-act="all">' +
      esc(t("全选")) +
      '</button><button type="button" data-act="none">' +
      esc(t("清空")) +
      '</button></div><div class="ms-list"></div></div>';
    var button = wrap.querySelector(".ms-btn");
    var panel = wrap.querySelector(".ms-panel");
    button.addEventListener("click", function (event) {
      event.stopPropagation();
      var opening = panel.hidden;
      closePanels();
      panel.hidden = !opening;
      if (opening) {
        fillList(key);
        wrap.querySelector(".ms-q").focus();
      }
    });
    wrap.querySelector(".ms-q").addEventListener("input", function (event) {
      st.search[key] = event.target.value;
      fillList(key);
    });
    panel.addEventListener("click", function (event) {
      event.stopPropagation();
      var act = event.target.getAttribute ? event.target.getAttribute("data-act") : null;
      if (act) {
        var values = itemsFor(key).map(function (item) {
          return item.value;
        });
        st[key] = act === "all" ? values : [];
        fillList(key);
        load();
        return;
      }
      var row = event.target.closest ? event.target.closest(".ms-item") : null;
      if (!row) return;
      var value = row.getAttribute("data-value");
      var list = selected(key).slice();
      var at = list.indexOf(value);
      if (at >= 0) list.splice(at, 1);
      else list.push(value);
      st[key] = list;
      fillList(key);
      load();
    });
    return wrap;
  }

  function closePanels() {
    var panels = document.querySelectorAll(".ms-panel");
    for (var i = 0; i < panels.length; i += 1) panels[i].hidden = true;
  }

  function buildSelects() {
    var host = el("filters");
    var search = el("q");
    SELECTS.forEach(function (pair) {
      host.insertBefore(createSelect(pair[0], pair[1]), search);
    });
  }

  /* ---------------- 渲染 ---------------- */

  function kpi(cls, key, value, detail, rawKey) {
    return (
      '<div class="kpi ' +
      cls +
      '"><div class="k">' +
      (rawKey ? key : esc(key)) +
      '</div><div class="v">' +
      value +
      '</div><div class="d">' +
      detail +
      "</div></div>"
    );
  }

  function renderKpis(data) {
    var k = data.kpi;
    var modes = k.modes || { credit: { rows: 0, credits: 0 }, balance: { rows: 0, credits: 0 }, window: { rows: 0, credits: 0 } };
    var cards = [
      kpi(
        "info",
        t("⇄ 请求 / 尝试"),
        fmtCount(k.requests),
        fmtCount(k.attempts) + t(" 次 · 重试 ") + fmtCount(k.retried)
      ),
      kpi(
        k.failRate > 0.1 ? "bad" : k.failRate > 0.03 ? "warn" : "good",
        t("✓ 成功率"),
        fmtPct(1 - k.failRate),
        t("失败 ") + fmtCount(k.fail)
      ),
      kpi(
        ttftTone(k.ttftP50),
        t("⚡ 首字 P50"),
        fmtMs(k.ttftP50),
        t("均 ") + fmtMs(k.ttftAvg) + t(" · 慢 ") + fmtMs(k.ttftMax)
      ),
      kpi(ttftTone(k.ttftP90), t("⚡ 首字 P90"), fmtMs(k.ttftP90), t("思考 ") + fmtMs(k.thinkP50)),
      kpi("info", t("⏱ 总时长 P90"), fmtMs(k.msP90), t("均 ") + fmtMs(k.msAvg)),
      kpi(
        hitTone(k.hitRate),
        ICONS.cache + t(" 缓存命中"),
        fmtPct(k.hitRate, 0),
        t("读 ") + fmtInt(k.cacheRead) + t(" · 写 ") + fmtInt(k.cacheWrite),
        true
      ),
      kpi(
        "",
        t("⇅ 入 → 出"),
        fmtInt(k.inp) + " → " + fmtInt(k.out),
        fmtInt(k.speed) + t(" tok/s · 推理 ") + fmtInt(k.reasoning)
      ),
      kpi(
        "info",
        t("◎ 积分合计"),
        fmtCredits(modes.credit.credits),
        t("余额 ") +
          fmtCount(modes.balance.rows) +
          t(" 次 · 额度 ") +
          fmtCount(modes.window.rows) +
          t(" 次")
      )
    ];
    el("kpis").innerHTML = cards.join("");
  }

  function sparkline(values, opts) {
    var width = 240;
    var height = 54;
    var pad = 2;
    var max = Math.max.apply(null, values.concat([1]));
    var step = values.length > 1 ? (width - pad * 2) / (values.length - 1) : width;
    var points = values.map(function (value, index) {
      var x = pad + index * step;
      var y = height - pad - (Math.max(0, value) / max) * (height - pad * 2);
      return [x, y];
    });
    if (opts && opts.bars) {
      var barWidth = Math.max(1.5, step - 1.4);
      var rects = points
        .map(function (point) {
          var h = height - pad - point[1];
          return (
            '<rect x="' +
            point[0].toFixed(1) +
            '" y="' +
            point[1].toFixed(1) +
            '" width="' +
            barWidth.toFixed(1) +
            '" height="' +
            Math.max(1, h).toFixed(1) +
            '" rx="1.5" fill="' +
            (opts.colour || "var(--blue)") +
            '" opacity="0.75" />'
          );
        })
        .join("");
      return '<svg viewBox="0 0 ' + width + " " + height + '" preserveAspectRatio="none">' + rects + "</svg>";
    }
    var path = points
      .map(function (point, index) {
        return (index ? "L" : "M") + point[0].toFixed(1) + " " + point[1].toFixed(1);
      })
      .join(" ");
    return (
      '<svg viewBox="0 0 ' +
      width +
      " " +
      height +
      '" preserveAspectRatio="none"><path d="' +
      path +
      '" fill="none" stroke="' +
      (opts && opts.colour ? opts.colour : "var(--cyan)") +
      '" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" /></svg>'
    );
  }

  function renderCharts(data) {
    var points = data.series || [];
    var n = points.map(function (p) {
      return p.n;
    });
    var fails = points.map(function (p) {
      return p.fail;
    });
    var ttft = points.map(function (p) {
      return p.ttft;
    });
    var cache = points.map(function (p) {
      return p.cacheRead;
    });
    var out = points.map(function (p) {
      return p.out;
    });
    var sum = function (list) {
      return list.reduce(function (a, b) {
        return a + b;
      }, 0);
    };
    var cards = [
      [t("⇄ 请求 ") + "<b>" + fmtCount(sum(n)) + "</b>", sparkline(n, { bars: true, colour: "var(--blue)" })],
      [
        t("⚠ 失败 ") + '<b class="bad">' + fmtCount(sum(fails)) + "</b>",
        sparkline(fails, { bars: true, colour: "var(--red)" })
      ],
      [
        t("⚡ 首字均值 ") + "<b>" + fmtMs(sum(ttft) / (ttft.length || 1)) + "</b>",
        sparkline(ttft, { colour: "var(--amber)" })
      ],
      [
        ICONS.cache + t(" 缓存读取 ") + "<b>" + fmtInt(sum(cache)) + "</b>",
        sparkline(cache, { bars: true, colour: "var(--green)" })
      ],
      [
        t("⇢ 输出 tokens ") + "<b>" + fmtInt(sum(out)) + "</b>",
        sparkline(out, { bars: true, colour: "var(--purple)" })
      ]
    ];
    el("charts").innerHTML = cards
      .map(function (pair) {
        return '<div class="chart"><div class="ct">' + pair[0] + "</div>" + pair[1] + "</div>";
      })
      .join("");
  }

  // 一格两行：↓入 ↑出 / 缓存读 (命中率)
  function tokenCell(row) {
    var tone = hitTone(row.hitRate);
    var hit = row.hitRate ? fmtPct(row.hitRate, 1) : "—";
    return (
      '<td class="num tk-cell">' +
      '<span class="tk"><i class="ic in">↓</i>' +
      fmtInt(row.inp) +
      '<i class="ic out">↑</i>' +
      fmtInt(row.out) +
      "</span>" +
      '<span class="tk sub"><i class="ic">' +
      ICONS.cache +
      "</i>" +
      fmtInt(row.cacheRead) +
      '<em class="' +
      tone +
      '">(' +
      hit +
      ")</em></span></td>"
    );
  }

  // 强度格：优先真实 effort；deepseek 这类链路 magpie 不写 effort，只留下思考 token 数，
  // 于是按「本次筛选内的思考量分位」派生一个相对强度（低/中/高/极高），数字原样附在后面。
  // 派生值一律用虚线边框 + title 说明来源，绝不冒充官方 effort。
  function effortCell(row, tier) {
    var eff = String(row.effort || "").toLowerCase();
    if (eff) {
      return (
        '<span class="pill effort-' +
        esc(eff) +
        '" title="' +
        esc(t("网关记录的推理强度：")) +
        esc(eff) +
        '">' +
        esc(EFFORT_NAME[eff] || eff) +
        "</span>"
      );
    }
    var think = Number(row.reasoning) || 0;
    if (think > 0 && tier) {
      return (
        '<span class="pill eff-derived on t-' +
        esc(tier.cls) +
        '" title="' +
        esc(
          t(
            "网关没记 effort，这里按思考 token 的排名派生：{n} tokens（本窗口 P50 {p50} / P75 {p75} / P90 {p90}）→ 低 < 中 < 高 < 极高，是相对值不是官方档位",
            {
              n: fmtCount(think),
              p50: fmtCount(tier.band.p50),
              p75: fmtCount(tier.band.p75),
              p90: fmtCount(tier.band.p90)
            }
          )
        ) +
        '">' +
        esc(tier.name) +
        "<b>" +
        fmtInt(think) +
        "</b></span>"
      );
    }
    if (think > 0) {
      return '<span class="pill eff-derived on">' + esc(t("思考")) + "<b>" + fmtInt(think) + "</b></span>";
    }
    return (
      '<span class="pill eff-derived" title="' +
      esc(t("网关没记 effort，本次请求也没有思考 token")) +
      '">' +
      esc(t("无思考")) +
      "</span>"
    );
  }

  // 思考量分位：拿当前这批行自己比，比一个固定的死阈值更能反映「这次算多还是少」。
  function thinkTiers(rows) {
    var values = rows
      .map(function (row) {
        return Number(row.reasoning) || 0;
      })
      .filter(function (value) {
        return value > 0;
      })
      .sort(function (a, b) {
        return a - b;
      });
    if (!values.length) return null;
    function at(p) {
      var i = Math.round(p * (values.length - 1));
      return values[Math.min(values.length - 1, Math.max(0, i))];
    }
    var band = { p50: at(0.5), p75: at(0.75), p90: at(0.9) };
    return function tier(think) {
      var name = t("低");
      var cls = "low";
      if (values.length > 3) {
        if (think > band.p90) {
          name = t("极高");
          cls = "max";
        } else if (think > band.p75) {
          name = t("高");
          cls = "high";
        } else if (think > band.p50) {
          name = t("中");
          cls = "mid";
        }
      }
      return { name: name, cls: cls, band: band };
    };
  }

  function renderRows(data) {
    var rows = data.rows || [];
    var tierOf = thinkTiers(rows);
    if (!rows.length) {
      el("rows").innerHTML =
        '<tr><td colspan="11"><div class="empty">' +
        esc(t("这个筛选组合下没有请求")) +
        "</div></td></tr>";
    } else {
      el("rows").innerHTML = rows
        .map(function (row) {
          var ttft = row.ttft ? fmtMs(row.ttft) : "—";
          var tone = ttftTone(row.ttft);
          var mode = row.mode || "credit";
          // 计费按「实际扣了什么」显示：走额度窗口的是 0 积分，就该写额度/免费，不能一律当积分。
          var credits = Number(row.credits) || 0;
          var money =
            mode === "window"
              ? '<span class="money quota">' + esc(t("额度")) + "</span>"
              : credits > 0
                ? '<span class="money">' + ICONS.coin + fmtCredits(credits) + "</span>"
                : '<span class="money free">' + esc(t("免费")) + "</span>";
          var when = String(row.t || "").replace("T", " ").slice(5, 19);
          return (
            "<tr>" +
            '<td class="time">' +
            esc(when) +
            "</td>" +
            '<td class="prov">' + provTag(row.provider) + "</td>" +
            '<td class="model" title="' +
            esc(
              row.asked
                ? t("请求 {asked} → 实际 {served}", { asked: row.asked, served: row.model })
                : row.model
            ) +
            '">' +
            "<b>" + esc(row.model) + "</b>" +
            "</td>" +
            '<td>' +
            effortCell(row, tierOf ? tierOf(Number(row.reasoning) || 0) : null) +
            "</td>" +
            '<td class="agent">' +
            esc(row.agent || "—") +
            "</td>" +
            '<td><span class="status' +
            (row.status === 200 ? "" : " fail") +
            '"><span class="dot ' +
            (row.status === 200 ? "ok" : "fail") +
            '"></span>' +
            esc(row.status) +
            "</span></td>" +
            tokenCell(row) +
            '<td class="num ' +
            tone +
            '">' +
            ttft +
            "</td>" +
            '<td class="num ' +
            speedTone(row.speed) +
            '" title="' +
            esc(
              t("输出速度 {v}（≥60 绿 / 25–60 黄 / <25 红）", {
                v: row.speed ? fmtInt(row.speed) + " tok/s" : t("无")
              })
            ) +
            '">' +
            (row.speed ? ICONS.bolt + fmtInt(row.speed) : '<span class="dim">—</span>') +
            "</td>" +
            '<td class="num ' +
            msTone(row.ms) +
            '" title="' +
            esc(t("总耗时（≤8s 绿 / 8–22s 黄 / >22s 红）")) +
            '">' +
            (row.ms ? ICONS.clock + fmtMs(row.ms) : '<span class="dim">—</span>') +
            "</td>" +
            '<td class="num">' +
            money +
            "</td>" +
            "</tr>"
          );
        })
        .join("");
    }
    el("rowinfo").textContent = t("显示最近 {n} 条 / 匹配 {m} 次尝试", {
      n: fmtCount(rows.length),
      m: fmtCount(data.kpi.attempts)
    });
    paintDynamic(el("rows"));
  }

  function renderTabs() {
    el("tabs").innerHTML = TABS.map(function (pair) {
      return (
        '<button type="button" data-tab="' +
        pair[0] +
        '" class="' +
        (pair[0] === st.tab ? "on" : "") +
        '">' +
        esc(pair[1]) +
        "</button>"
      );
    }).join("");
  }

  function renderGroups(data) {
    renderTabs();
    var rows = data[st.tab] || [];
    if (!rows.length) {
      el("groups").innerHTML = '<tr><td colspan="7"><div class="empty">' + esc(t("没有数据")) + "</div></td></tr>";
      return;
    }
    el("groups").innerHTML = rows
      .map(function (row) {
        var isProvider = st.tab === "byProvider";
        var label = isProvider ? nameOf(row.key) : L(row.key);
        var mode = row.mode || "credit";
        return (
          "<tr>" +
          '<td class="gname" title="' + esc(label) + '">' +
          (isProvider ? provTag(row.key, "tiny") : '<span class="ell">' + esc(label) + "</span>") +
          "</td>" +
          '<td class="num">' +
          fmtCount(row.n) +
          "</td>" +
          '<td class="num ' +
          (row.fail ? "bad" : "dim") +
          '">' +
          (row.fail ? fmtCount(row.fail) : "0") +
          "</td>" +
          '<td class="num ' +
          ttftTone(row.ttftP50) +
          '">' +
          fmtMs(row.ttftP50) +
          "</td>" +
          '<td class="num ' +
          hitTone(row.hitRate) +
          '">' +
          fmtPct(row.hitRate, 0) +
          "</td>" +
          '<td class="num">' +
          (row.speed ? fmtInt(row.speed) : "—") +
          "</td>" +
          '<td class="num">' +
          (mode === "window" ? '<span class="tag window">' + esc(t("额度")) + "</span>" : fmtCredits(row.credits)) +
          "</td>" +
          "</tr>"
        );
      })
      .join("");
    paintDynamic(el("groups"));
  }

  function renderBilling(data) {
    var billing = data.billing || { providers: {}, order: [] };
    var spend = {};
    (data.byProvider || []).forEach(function (row) {
      spend[row.key] = row;
    });
    var groups = { balance: [], window: [], credit: [] };
    (billing.order || []).forEach(function (id) {
      var item = billing.providers[id];
      if (!item) return;
      groups[item.mode] = groups[item.mode] || [];
      groups[item.mode].push({ item: item, spend: spend[id] });
    });
    (data.byProvider || []).forEach(function (row) {
      if (billing.providers[row.key]) return;
      groups.credit.push({ item: { id: row.key, name: nameOf(row.key), mode: "credit", balanceText: "", windows: [] }, spend: row });
    });

    var columns = [];
    columns.push({
      title: t("余额（$）"),
      hint: t("供应商按余额扣费，余额来自它们自己的接口"),
      rows: groups.balance || []
    });
    columns.push({
      title: t("额度（窗口）"),
      hint: t("订阅额度，按窗口剩余"),
      rows: groups.window || []
    });
    columns.push({
      title: t("积分（credits）"),
      hint: t("没有余额或额度的供应商，按网关积分算"),
      rows: groups.credit || []
    });

    el("billing").innerHTML = columns
      .map(function (column) {
        var body;
        if (!column.rows.length) {
          body = '<div class="empty">' + esc(t("近窗口没有这类请求")) + "</div>";
        } else {
          body = column.rows
            .map(function (entry) {
              var item = entry.item;
              var row = entry.spend;
              var right = "";
              if (item.mode === "balance") {
                var value = item.balance;
                var cls = value === null || value === undefined ? "dim" : value <= 0 ? "bad" : value < 1 ? "warn" : "good";
                right = '<span class="bv ' + cls + '">' + esc(item.balanceText || "—") + "</span>";
              } else if (item.mode === "window") {
                right = '<span class="bv dim">' + fmtCount(row ? row.n : 0) + t(" 次") + "</span>";
              } else {
                right = '<span class="bv cyan">' + fmtCredits(row ? row.credits : 0) + "</span>";
              }
              var sub = [];
              if (row) {
                sub.push(fmtCount(row.n) + t(" 次"));
                sub.push(t("首字 ") + fmtMs(row.ttftP50));
                sub.push(t("失败 ") + fmtCount(row.fail));
              } else {
                sub.push(t("近窗口无请求"));
              }
              if (item.keys > 1) sub.push(item.keys + t(" 把 key"));
              if (item.ageSec !== null && item.ageSec !== undefined) {
                sub.push(fmtMs(item.ageSec * 1000) + t(" 前读取"));
              }
              var windows = "";
              (item.windows || []).forEach(function (window) {
                var used = Math.max(0, Math.min(1, window.used > 1 ? window.used / 100 : window.used));
                windows +=
                  '<div class="win"><div class="wl"><span>' +
                  esc(window.name) +
                  "</span><span>" +
                  fmtPct(used, 0) +
                  "</span></div>" +
                  bar(used, used >= 0.9 ? "bad" : used >= 0.7 ? "warn" : "good") +
                  "</div>";
              });
              return (
                '<div class="bill-row"><span class="bn" title="' +
                esc(item.id || item.name) +
                '">' +
                esc(item.name) +
                "</span>" +
                right +
                '<span class="bs">' +
                esc(sub.join(" · ")) +
                "</span>" +
                windows +
                "</div>"
              );
            })
            .join("");
        }
        return (
          '<div class="bill-col"><h3>' +
          esc(column.title) +
          "</h3>" +
          '<div class="hint">' +
          esc(column.hint) +
          "</div>" +
          body +
          "</div>"
        );
      })
      .join("");
    el("billingat").textContent = billing.at ? t("快照 ") + String(billing.at).slice(11, 19) : "";
    paintDynamic(el("billing"));
  }

  function renderMeta(data) {
    var src = data.source || {};
    var routing = src.routing || {};
    el("src").innerHTML =
      "<b>" +
      fmtCount(src.rows) +
      "</b>" +
      esc(t(" 行日志 · 读于 ")) +
      esc(String(src.scannedAt || "").slice(11, 19) || "—") +
      (routing.file ? esc(t(" · 路由 ")) + esc(routing.file) : "");
    el("updated").textContent = t("更新于 ") + String(data.at || "").slice(11, 19);
    SELECTS.forEach(function (pair) {
      fillList(pair[0]);
    });
  }

  function render(data) {
    st.data = data;
    renderKpis(data);
    renderCharts(data);
    renderRows(data);
    renderGroups(data);
    renderBilling(data);
    renderMeta(data);
  }

  /* ---------------- 取数 ---------------- */

  var busy = false;

  function query() {
    var search = new URLSearchParams();
    search.set("window", st.window);
    search.set("limit", String(st.limit));
    if (st.provider.length) search.set("provider", st.provider.join(","));
    if (st.model.length) search.set("model", st.model.join(","));
    if (st.effort.length) search.set("effort", st.effort.join(","));
    if (st.agent.length) search.set("agent", st.agent.join(","));
    if (st.status) search.set("status", st.status);
    if (st.q) search.set("q", st.q);
    return search.toString();
  }

  function load(retry) {
    if (busy) return;
    busy = true;
    riFetch("/api/state?" + query(), { cache: "no-store" })
      .then(function (response) {
        return response.json();
      })
      .then(function (data) {
        busy = false;
        if (!data || !data.ok) {
          el("src").textContent = t("读取失败：") + ((data && data.error) || t("未知错误"));
          return;
        }
        render(data);
      })
      .catch(function (error) {
        busy = false;
        // 插件热重载时服务会断几百毫秒到一两秒。先自己重连两次，别立刻甩一脸红字；
        // 真断了才报错，人工点「刷新」也不会因为重连计时器卡住。
        var tries = retry || 0;
        if (tries < 2) {
          el("src").textContent = t("重连中… ") + String((error && error.message) || error);
          setTimeout(function () {
            load(tries + 1);
          }, 900);
          return;
        }
        el("src").textContent = t("服务没有响应：") + String((error && error.message) || error);
      });
  }

  /* ---------------- 交互 ---------------- */

  function watch() {
    el("pause").addEventListener("click", function () {
      st.paused = !st.paused;
      el("pause").textContent = st.paused ? t("继续") : t("暂停");
      el("pause").className = st.paused ? "ghost on" : "ghost";
    });
    el("refresh").addEventListener("click", function () {
      load();
    });
    el("clear").addEventListener("click", function () {
      st.provider = [];
      st.model = [];
      st.effort = [];
      st.agent = [];
      st.status = "";
      st.q = "";
      el("q").value = "";
      buildStatusSeg();
      SELECTS.forEach(function (pair) {
        fillList(pair[0]);
      });
      load();
    });
    var typing = 0;
    el("q").addEventListener("input", function (event) {
      st.q = event.target.value;
      clearTimeout(typing);
      typing = setTimeout(load, 260);
    });
    el("tabs").addEventListener("click", function (event) {
      var tab = event.target.getAttribute ? event.target.getAttribute("data-tab") : null;
      if (!tab) return;
      st.tab = tab;
      if (st.data) renderGroups(st.data);
    });
    document.addEventListener("click", function (event) {
      var target = event.target;
      var foldBtn = target && target.closest ? target.closest("[data-fold]") : null;
      if (foldBtn) {
        toggleFold(foldBtn.getAttribute("data-fold"));
        return;
      }
      // 整条标题栏都能点：省得去瞄一个小三角
      var head = target && target.closest ? target.closest(".card-head, .res-head") : null;
      if (head) {
        var card = head.parentNode;
        var inTabs = target.closest ? target.closest(".tabs") : null;
        if (!inTabs && card && card.getAttribute && card.getAttribute("data-foldable") === "1") {
          toggleFold(card.id);
          return;
        }
      }
      var again = target && target.closest ? target.closest("[data-again]") : null;
      if (again) {
        retryTest(again.getAttribute("data-again"));
        return;
      }
      var box = target && target.getAttribute ? target.getAttribute("data-test-box") : null;
      if (box) {
        st.lab.tests[box] = !!target.checked;
        renderLabChecks();
        return;
      }
      closePanels();
    });
    el("foldTop").addEventListener("click", function () {
      toggleFold("__top");
    });
    el("labRun").addEventListener("click", function () {
      runLab();
    });
    setInterval(function () {
      if (!st.paused) load();
    }, 2000);
    setInterval(function () {
      if (!st.paused && st.view === "providers") loadProviders();
    }, 8000);
  }

  /* ---------------- 折叠 ---------------- */

  var FOLD_KEY = "route-insight-fold";
  // localStorage 只是"记住上次"的顺手存档，不是状态本身。
  // magpie 把插件页装在一个不带 allow-same-origin 的 iframe 里（origin 为 null），
  // 在那里 window.localStorage 一碰就抛 SecurityError —— 以前读写都走它，
  // 于是点一下：写失败、回头再读还是空，折叠立刻被撤销，表现就是"点了没反应"。
  // 现在以内存里的 foldMap 为准，localStorage 能写就写，纯属锦上添花。
  var foldMap = null;

  function readFold() {
    if (foldMap) return foldMap;
    foldMap = {};
    try {
      var raw = window.localStorage && window.localStorage.getItem(FOLD_KEY);
      var parsed = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === "object") foldMap = parsed;
    } catch (error) {
      // 沙箱里没有存储权限：这次会话记不住，但折叠照样能用。
    }
    return foldMap;
  }

  function writeFold(map) {
    foldMap = map;
    try {
      window.localStorage.setItem(FOLD_KEY, JSON.stringify(map));
    } catch (error) {
      // 同上：存不了不影响本次。
    }
  }

  function applyFold() {
    var map = readFold();
    // 不写死 id 清单：页面上每个 [data-fold] 按钮都算一个可折叠块。
    // 检测结果卡每次跑完都会重绘，写死清单就会漏掉它们（点了没反应就是这么来的）。
    var buttons = document.querySelectorAll("[data-fold]");
    for (var i = 0; i < buttons.length; i += 1) {
      var button = buttons[i];
      var id = button.getAttribute("data-fold");
      if (id === "__top") continue;
      var node = el(id);
      if (!node) continue;
      var on = !!map[id];
      if (on) node.classList.add("collapsed");
      else node.classList.remove("collapsed");
      var chev = button.querySelector(".chev");
      var label = button.querySelector(".flabel");
      if (chev) chev.textContent = on ? "▸" : "▾";
      if (label) label.textContent = on ? t("展开") : t("收起");
      button.setAttribute("aria-expanded", on ? "false" : "true");
      button.title = on ? t("点击展开这张卡片") : t("点击收起这张卡片");
    }
    var page = el("page");
    var top = !!map.__top;
    if (page) {
      if (top) page.classList.add("hide-top");
      else page.classList.remove("hide-top");
    }
    var topBtn = el("foldTop");
    if (topBtn) topBtn.textContent = top ? t("展开指标") : t("收起指标");
  }

  function toggleFold(id) {
    var map = readFold();
    map[id] = !map[id];
    writeFold(map);
    applyFold();
  }

  /* ---------------- 供应商状态（照 magpie 渠道卡片） ---------------- */

  function provState(card) {
    if (card.off) return { cls: "bad", text: t("已停用") };
    if (!card.n) return { cls: "", text: t("没流量") };
    var rate = Number(card.availability);
    if (!isFinite(rate)) return { cls: "", text: t("没流量") };
    if (rate < 0.85) return { cls: "bad", text: t("错误") };
    if (rate < 0.98 || (card.idleMs !== null && card.idleMs > 6 * 3600000)) {
      return { cls: "warn", text: t("告警") };
    }
    return { cls: "ok", text: t("正常") };
  }

  function ago(ms) {
    var v = Number(ms) || 0;
    if (!v) return "—";
    if (v < 60000) return t("刚刚");
    if (v < 3600000) return Math.round(v / 60000) + t(" 分钟前");
    if (v < 86400000) return Math.round(v / 3600000) + t(" 小时前");
    return Math.round(v / 86400000) + t(" 天前");
  }

  function provCard(card) {
    var state = provState(card);
    var rate = Number(card.availability);
    var rateTone = !isFinite(rate) ? "dim" : rate >= 0.98 ? "good" : rate >= 0.85 ? "warn" : "bad";
    var bars = (card.last60 || [])
      .map(function (item) {
        var cls = item.status === 200 ? (item.ttft > 20000 ? "warn" : "ok") : "bad";
        return '<i class="' + cls + '" title="' + esc((item.model || "") + " · " + item.status + " · " + fmtMs(item.ttft)) + '"></i>';
      })
      .join("");
    var icon = card.icon
      ? '<img src="' + esc(card.icon) + '" alt="" loading="lazy" onerror="this.style.display=&quot;none&quot;" />'
      : '<span class="noic">' + esc(String(card.name || "?").slice(0, 1)) + "</span>";
    var models = (card.models || []).length ? card.models.join(" / ") : t("（近 7 天没跑过）");
    return (
      '<article class="prov">' +
      '<div class="prov-top"><span class="prov-ic">' + icon + "</span>" +
      '<span class="prov-name"><b>' + esc(card.name || card.id) + "</b><em>" +
      esc((card.endpoint || t("本地/未填地址")) + (card.off ? " · " + t("已停用") : "")) +
      "</em></span>" +
      '<span class="prov-st ' + state.cls + '">' + esc(state.text) + "</span></div>" +
      '<div class="prov-boxes">' +
      '<div class="prov-box"><div class="k">' + ICONS.bolt + esc(t("首字 P50")) + '</div><div class="v">' +
      (card.ttftP50 ? fmtMs(card.ttftP50) : "—") + "</div></div>" +
      '<div class="prov-box"><div class="k">' + ICONS.clock + t("上次成功") + '</div><div class="v">' +
      (card.idleMs === null || card.idleMs === undefined ? "—" : ago(card.idleMs)) + "</div></div>" +
      "</div>" +
      '<div class="prov-avail"><span class="k">' +
      esc(t("可用性 · 7 天")) +
      '</span><span class="v ' +
      rateTone +
      '">' +
      "" +
      (isFinite(rate) ? (rate * 100).toFixed(2) + "%" : "—") +
      '</span><span class="sub">' +
      t("近 ") +
      fmtCount(card.n) +
      t(" 次 · 失败 ") +
      fmtCount(card.fail) +
      "</span></div>" +
      '<div class="prov-strip">' + bars + "</div>" +
      '<div class="prov-strip-foot"><span>PAST</span><span>NOW</span></div>' +
      '<div class="prov-foot"><span>' +
      esc(t("均速 ")) +
      "<b>" +
      (card.speed ? fmtInt(card.speed) + " tok/s" : "—") +
      "</b></span>" +
      '<span class="sep">·</span><span>' +
      esc(t("积分 ")) +
      "<b>" +
      fmtCredits(card.credits) +
      "</b></span>" +
      '<span class="sep">·</span><span>' +
      esc(t("主要模型 ")) +
      "<b>" +
      esc(models) +
      "</b></span></div>" +
      "</article>"
    );
  }

  function renderProviders(payload) {
    var grid = el("provCards");
    if (!grid) return;
    var cards = (payload && payload.providers) || [];
    if (payload && payload.error) {
      grid.innerHTML = '<div class="empty">' + esc(t("读取供应商失败：")) + esc(payload.error) + "</div>";
      return;
    }
    if (!cards.filter(function (c) { return c.n; }).length) {
      grid.innerHTML = '<div class="empty">' + esc(t("近 7 天没有任何请求，先发几条消息再看")) + "</div>";
      return;
    }
    grid.innerHTML = cards.map(provCard).join("");
    var at = el("provAt");
    if (at) {
      at.textContent = payload && payload.at ? t("更新于 ") + String(payload.at).replace("T", " ").slice(5, 19) : "";
    }
    var meta = el("provMeta");
    if (meta) {
      var live = cards.filter(function (c) { return c.n; }).length;
      meta.textContent = t("近 7 天 · ") + live + t(" 家在用 / 共 ") + cards.length + t(" 家");
    }
    paintDynamic(grid);
  }

  function loadProviders() {
    return riFetch("/api/providers", { cache: "no-store" })
      .then(function (response) {
        return response.json();
      })
      .then(function (data) {
        st.prov.cards = data;
        // 顺带把 id → 头像 存下来，看板表格里也能贴上供应商头像。
        st.prov.icons = {};
        ((data && data.providers) || []).forEach(function (card) {
          if (card && card.id && card.icon) st.prov.icons[card.id] = card.icon;
        });
        renderProviders(data);
      })
      .catch(function (error) {
        renderProviders({ error: String((error && error.message) || error) });
      });
  }

  /* ---------------- 智商检测（数值指纹 + 协议审计 + HTML 动画） ---------------- */

  var LAB_TESTS = [
    [
      "numfp",
      t("数值指纹"),
      t("6 次「数 300 个随机数」（两回合）→ 参考库落到具体型号")
    ],
    ["relay", t("协议审计"), t("7 次协议探针：回声 / usage / 函数调用 / JSON / 流式")],
    ["anim", t("HTML 动画"), t("完整 HTML：会动的鹈鹕骑车（提示词可改）")]
  ];
  // 强度档位：文本探针一条线，画图一条线，各选各的。
  var EFF_SLOTS = [
    ["labEffFam", "audit"],
    ["labEffDraw", "draw"]
  ];

  function buildViewSeg() {
    var seg = el("viewSeg");
    var views = [["board", t("看板")], ["providers", t("供应商")], ["lab", t("指纹")]];
    seg.innerHTML = "";
    views.forEach(function (pair) {
      var button = document.createElement("button");
      button.type = "button";
      button.textContent = pair[1];
      if (pair[0] === st.view) button.className = "on";
      button.addEventListener("click", function () {
        st.view = pair[0];
        if (pair[0] === "lab" && !st.lab.models) loadLabModels();
        if (pair[0] === "lab") {
          refreshNumericStatus();
          loadLabHistory();
          if (!st.lab.last) loadLabResult();
        }
        if (pair[0] === "providers") loadProviders();
        buildViewSeg();
        showView();
      });
      seg.appendChild(button);
    });
  }

  function showView() {
    var page = el("page");
    page.classList.toggle("lab-mode", st.view === "lab");
    page.classList.toggle("prov-mode", st.view === "providers");
    el("labView").hidden = st.view !== "lab";
    el("providersView").hidden = st.view !== "providers";
  }

  function renderLabChecks() {
    el("labTests").innerHTML = LAB_TESTS.map(function (item) {
      var on = st.lab.tests[item[0]];
      return (
        '<label class="lab-check' +
        (on ? " on" : "") +
        '" data-test="' +
        item[0] +
        '"><input type="checkbox" data-test-box="' +
        item[0] +
        '"' +
        (on ? " checked" : "") +
        ' /><span class="box"></span><span class="txt"><b>' +
        esc(item[1]) +
        "</b><em>" +
        esc(item[2]) +
        "</em></span></label>"
      );
    }).join("");
    var count = LAB_TESTS.filter(function (item) {
      return st.lab.tests[item[0]];
    }).length;
    // 数值指纹 5 次数数挑战（空答会各自重试一次，故上限 10）；
    // 协议审计固定 7 次（3 回声 + 函数调用 + JSON + 非流式 + 流式）；
    // 画图 1 次，没画全会自动重试，最多 2 次。
    var low = 0;
    var high = 0;
    if (st.lab.tests.numfp) {
      low += 5;
      high += 10;
    }
    if (st.lab.tests.relay) {
      low += 7;
      high += 7;
    }
    if (st.lab.tests.anim) {
      low += 1;
      high += 2;
    }
    var cost = low === high ? low + t(" 次") : low + "–" + high + t(" 次");
    // 不是每次检测都扣积分：走额度窗口的线路 credits 一直是 0，具体看结果卡里的计费说明。
    el("labCost").textContent = count
      ? t("预计 ") + cost + t(" 次请求 · 是否扣积分看结果卡")
      : t("至少选一项");
    el("labRun").disabled = !count || st.lab.running;
    fillLabEfforts();
  }

  // 强度下拉：档位来自网关 /v1/models 里这个型号的 reasoning_levels，
  // 没声明就只剩「默认档」一项，此时后端不会带 reasoning_effort。
  function labModelItem() {
    var hit = null;
    (st.lab.models || []).forEach(function (one) {
      if (one.value === st.lab.model) hit = one;
    });
    return hit;
  }

  function fillLabEfforts() {
    var item = labModelItem();
    var levels = (item && item.levels) || [];
    EFF_SLOTS.forEach(function (pair) {
      var box = el(pair[0]);
      if (!box) return;
      var cur = st.lab.effort[pair[1]] || "";
      var opts = ['<option value="">' + esc(t("默认档")) + "</option>"].concat(
        levels.map(function (lv) {
          return '<option value="' + esc(lv) + '">' + esc(lv) + "</option>";
        })
      );
      box.innerHTML = opts.join("");
      box.value = levels.indexOf(cur) >= 0 ? cur : "";
      st.lab.effort[pair[1]] = box.value;
      box.disabled = !levels.length;
    });
    var note = el("labEffNote");
    if (note) {
      note.textContent = !item
        ? ""
        : levels.length
          ? item.model + t(" 支持 ") + levels.join(" / ")
          : item.model + t(" 没声明强度档，只能走默认");
    }
  }

  // 参考库状态：只报事实，不下东西。「下载」是个明确的按钮——参考库约 3.8 MB，
  // 版本固定、落地校验哈希（见 lib/numeric.mjs），不问一声就在后台联网取数据不合适。
  var numStatusAsked = false;
  function refreshNumericStatus(force) {
    var note = el("labNumNote");
    if (!note) return;
    if (numStatusAsked && !force) return;
    numStatusAsked = true;
    note.textContent = t("数值指纹参考库：检查中…");
    note.className = "lab-eff-note";
    riFetch("/api/lab/numeric", { cache: "no-store" })
      .then(function (response) {
        return response.json();
      })
      .then(function (data) {
        st.lab.numeric = data || null;
        drawNumericStatus(data || {});
      })
      .catch(function () {
        numStatusAsked = false;
        var now = el("labNumNote");
        if (now) {
          now.textContent = t("参考库状态读不到");
          now.className = "lab-eff-note custom";
        }
      });
  }

  function drawNumericStatus(data) {
    var note = el("labNumNote");
    if (!note) return;
    var size = ((Number(data.downloadBytes) || 0) / 1048576).toFixed(1);
    if (data.ready) {
      note.className = "lab-eff-note";
      note.title = String(data.credit || "");
      note.textContent = t("参考库 {date} · {size} MB", {
        date: String(data.builtAt || "").slice(0, 10),
        size: ((Number(data.dataBytes) || 0) / 1048576).toFixed(1)
      });
      return;
    }
    var label = t("下载 {size} MB", { size: size });
    var lead = t("参考库未下载 · ");
    if (data.downloaded && data.error) {
      label = t("重新下载");
      lead = t("参考库版本不符 · ");
    }
    // 下载前先说清楚要连谁：参考库从固定域名取，用户点之前就能看见。
    var host = "";
    try {
      host = new URL(String(data.source || "")).host;
    } catch (error) {
      host = "";
    }
    note.className = "lab-eff-note custom";
    note.title = String(data.error || data.credit || "");
    note.innerHTML =
      lead +
      '<button type="button" class="mini-link" id="labNumGet" title="' +
      esc(String(data.source || "")) +
      '">' +
      label +
      "</button>" +
      (host
        ? '<span class="dim">' + esc(t(" · 从 {host} 取（固定版本，下完校验 sha256）", { host: host })) + "</span>"
        : "");
    var btn = el("labNumGet");
    if (btn) btn.addEventListener("click", downloadNumericData);
  }

  function downloadNumericData() {
    var note = el("labNumNote");
    if (note) {
      note.className = "lab-eff-note";
      note.textContent = t("正在下载参考库…");
    }
    riFetch("/api/lab/data", { method: "POST", cache: "no-store" })
      .then(function (response) {
        return response.json();
      })
      .then(function (data) {
        st.lab.numeric = data || null;
        numStatusAsked = true;
        drawNumericStatus(data || {});
      })
      .catch(function (error) {
        var now = el("labNumNote");
        if (now) {
          now.className = "lab-eff-note custom";
          now.textContent = t("下载失败：") + String((error && error.message) || error).slice(0, 90);
        }
      });
  }

  // 检测 id → 用哪条强度线
  function labEffort() {
    return {
      // 数值指纹和协议审计共用「文本强度」那条线：两条都是纯文本短回答。
      numfp: st.lab.effort.audit || "",
      relay: st.lab.effort.audit || "",
      anim: st.lab.effort.draw || "",
      pelican: st.lab.effort.draw || ""
    };
  }

  function bindEfforts() {
    EFF_SLOTS.forEach(function (pair) {
      var box = el(pair[0]);
      if (!box) return;
      box.addEventListener("change", function () {
        st.lab.effort[pair[1]] = box.value;
      });
    });
  }

  var PROMPT_KEY = "route-insight-lab-prompt";

  // 画图提示词：输入框留空就用服务端的默认那句，改过的记在 localStorage。
  function fillLabPrompt() {
    var box = el("labPrompt");
    if (!box) return;
    if (!st.lab.prompt) {
      try {
        st.lab.prompt = window.localStorage.getItem(PROMPT_KEY) || "";
      } catch (error) {
        st.lab.prompt = "";
      }
    }
    if (document.activeElement !== box) box.value = st.lab.prompt;
    var hint = el("labPromptHint");
    var custom = !!st.lab.prompt.trim();
    if (box) box.placeholder = st.lab.promptDefault || t("留空 = 用默认提示词");
    if (hint) {
      hint.textContent = custom
        ? t("自定义 · {n} 字", { n: st.lab.prompt.trim().length })
        : t("默认 · 留空就用这句");
      hint.className = "lab-eff-note" + (custom ? " custom" : "");
    }
    var reset = el("labPromptReset");
    if (reset) reset.disabled = !custom;
  }

  function bindLabPrompt() {
    var box = el("labPrompt");
    if (box) {
      box.addEventListener("input", function () {
        st.lab.prompt = box.value;
        try {
          if (st.lab.prompt.trim()) window.localStorage.setItem(PROMPT_KEY, st.lab.prompt);
          else window.localStorage.removeItem(PROMPT_KEY);
        } catch (error) {}
        fillLabPrompt();
      });
    }
    var reset = el("labPromptReset");
    if (reset) {
      reset.addEventListener("click", function () {
        st.lab.prompt = "";
        try {
          window.localStorage.removeItem(PROMPT_KEY);
        } catch (error) {}
        if (box) box.value = "";
        fillLabPrompt();
      });
    }
  }

  // 模型选择器：原生 <select> 塞不下供应商头像，也没有搜索，所以自己画一个。
  // 触发器 = 头像 + 模型名 + 家族；面板 = 搜索 + 按供应商分组 + 每行「家族 / 次数」。
  var pickFlat = [];
  var pickQuery = "";

  function iconMarkup(item, cls) {
    if (item && item.icon) return '<img class="' + cls + '" src="' + esc(item.icon) + '" alt="" loading="lazy">';
    var letter = item && item.kind === "group" ? "◇" : String((item && item.provider) || "?").slice(0, 1).toUpperCase();
    return '<span class="' + cls + ' ph">' + esc(letter) + "</span>";
  }

  function pickProviderName(item) {
    if (item.kind === "group") return t("网关分组");
    return item.providerName || item.provider || t("其他");
  }

  function pickFace() {
    var list = st.lab.models || [];
    var item = null;
    list.forEach(function (one) {
      if (one.value === st.lab.model) item = one;
    });
    var ico = el("labPickIco");
    if (ico) ico.innerHTML = item ? iconMarkup(item, "pick-ico") : '<span class="pick-ico ph">◇</span>';
    el("labPickName").textContent = item
      ? item.model
      : list.length
        ? t("选一个模型…")
        : t("没有可用模型");
    var bits = [];
    if (item) {
      bits.push(pickProviderName(item));
      if (item.family && item.kind !== "group") bits.push(item.family);
    }
    el("labPickFam").textContent = bits.join(" · ");
  }

  function renderPick() {
    var box = el("labPickList");
    if (!box) return;
    var q = pickQuery.trim().toLowerCase();
    var order = [];
    var buckets = {};
    (st.lab.models || []).forEach(function (item) {
      var key = pickProviderName(item);
      var hay = (item.model + " " + key + " " + (item.family || "")).toLowerCase();
      if (q && hay.indexOf(q) < 0) return;
      if (!buckets[key]) {
        buckets[key] = [];
        order.push(key);
      }
      buckets[key].push(item);
    });
    pickFlat = [];
    if (!order.length) {
      box.innerHTML = '<div class="pick-empty">' + esc(t("没有匹配的模型")) + "</div>";
      return;
    }
    box.innerHTML = order
      .map(function (key) {
        var head =
          '<div class="pick-grp">' +
          iconMarkup(buckets[key][0], "pick-gico") +
          '<span class="pick-gname">' +
          esc(key) +
          '</span><span class="n">' +
          buckets[key].length +
          t(" 个型号") +
          "</span></div>";
        var rows = buckets[key]
          .map(function (item) {
            var k = pickFlat.push(item) - 1;
            return (
              '<button class="pick-row' +
              (item.value === st.lab.model ? " on" : "") +
              '" type="button" role="option" data-k="' +
              k +
              '"><span class="pk-name">' +
              esc(item.model) +
              (item.kind === "group" ? '<em class="pk-kind">GROUP</em>' : "") +
              "</span>" +
              (item.family && item.kind !== "group" ? '<em class="pk-fam">' + esc(item.family) + "</em>" : "") +
              '<span class="pk-n">' + (item.n || 0) + t(" 次") + "</span>" +
              '<span class="pk-check">✓</span></button>'
            );
          })
          .join("");
        return head + rows;
      })
      .join("");
  }

  function pickChoose(value) {
    st.lab.model = value;
    pickFace();
    renderPick();
    fillLabEfforts();
  }

  function bindPick() {
    var btn = el("labPickBtn");
    var pop = el("labPickPop");
    var input = el("labPickQ");
    var list = el("labPickList");
    if (!btn || !pop || !list) return;

    function close() {
      pop.hidden = true;
      btn.setAttribute("aria-expanded", "false");
    }
    function open() {
      if (!(st.lab.models || []).length) return;
      pop.hidden = false;
      btn.setAttribute("aria-expanded", "true");
      pickQuery = "";
      if (input) input.value = "";
      renderPick();
      if (input) input.focus();
    }
    function step(delta) {
      var rows = [].slice.call(list.querySelectorAll(".pick-row"));
      if (!rows.length) return;
      var at = -1;
      rows.forEach(function (row, k) {
        if (row.className.indexOf("act") >= 0) at = k;
      });
      at = Math.min(rows.length - 1, Math.max(0, at + delta));
      rows.forEach(function (row, k) {
        row.className = row.className.replace(/\s*act\b/g, "") + (k === at ? " act" : "");
      });
      if (rows[at].scrollIntoView) rows[at].scrollIntoView({ block: "nearest" });
    }

    btn.addEventListener("click", function (event) {
      event.stopPropagation();
      if (pop.hidden) open();
      else close();
    });
    if (input) {
      input.addEventListener("input", function () {
        pickQuery = input.value;
        renderPick();
      });
      input.addEventListener("keydown", function (event) {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          step(1);
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          step(-1);
        } else if (event.key === "Enter") {
          event.preventDefault();
          var row = list.querySelector(".pick-row.act") || list.querySelector(".pick-row.on");
          if (row) {
            pickChoose(pickFlat[Number(row.getAttribute("data-k"))].value);
            close();
          }
        } else if (event.key === "Escape") {
          event.preventDefault();
          close();
        }
      });
    }
    list.addEventListener("click", function (event) {
      var row = event.target && event.target.closest ? event.target.closest(".pick-row") : null;
      if (!row) return;
      var item = pickFlat[Number(row.getAttribute("data-k"))];
      if (!item) return;
      pickChoose(item.value);
      close();
    });
    document.addEventListener("click", function (event) {
      if (pop.hidden) return;
      if (pop.contains(event.target) || btn.contains(event.target)) return;
      close();
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && !pop.hidden) close();
    });
  }

  function loadLabModels() {
    el("labPickName").textContent = t("读取模型…");
    return riFetch("/api/lab/models", { cache: "no-store" })
      .then(function (response) {
        return response.json();
      })
      .then(function (data) {
        var models = (data && data.models) || [];
        st.lab.models = models;
        st.lab.library = (data && data.library) || null;
        st.lab.promptDefault = (data && data.prompts && data.prompts.anim) || "";
        fillLabLimits(data && data.limits);
        fillLabPrompt();
        if (!models.length) {
          pickFace();
          fillLabEfforts();
          return;
        }
        var keep = models.some(function (item) {
          return item.value === st.lab.model;
        });
        if (!keep) st.lab.model = models[0].value;
        pickFace();
        renderPick();
        fillLabEfforts();
      })
      .catch(function (error) {
        st.lab.models = [];
        st.lab.error = String((error && error.message) || error);
        pickFace();
      });
  }

  // 成本上限写在标题旁边：一次点击会花多少、今天还剩多少，先说清楚再让人按。
  function fillLabLimits(limits) {
    var node = el("labNote");
    if (!node) return;
    if (!limits) {
      node.textContent = t("选一个模型，勾上要跑的项就能一起测；每项各花各的请求");
      return;
    }
    var parts = [t("选一个模型，勾上要跑的项就能一起测")];
    if (limits.requestsPerRun) parts.push(t("一次最多 ") + limits.requestsPerRun + t(" 次请求"));
    if (limits.creditsPerDay) {
      var used = Number(limits.creditsToday) || 0;
      parts.push(
        t("今日已花 ") + used.toFixed(1) + t(" / ") + limits.creditsPerDay + t(" 积分")
      );
    }
    node.textContent = parts.join(" · ");
  }

  function signalRows(signals) {
    return (signals || [])
      .map(function (item) {
        return (
          '<div class="sig ' +
          esc(item.tone || "") +
          '"><span class="sig-name">' +
          esc(item.name) +
          '</span><span class="sig-value">' +
          esc(item.value) +
          "</span>" +
          (item.note ? '<span class="sig-note">' + esc(item.note) + "</span>" : "") +
          "</div>"
        );
      })
      .join("");
  }

  // 一项检测一张卡。以前四块内容全塞在一张卡里，标题只有 h4 那点字号，
  // 一屏里根本分不出层次；现在每项自己一张卡：左边一道色条 + 大一号标题 + 右边的结论标签，
  // 说明文字另起一行（标题那行只留结论，不再跟一长串副标题抢空间）。
  function pane(o) {
    return (
      '<div class="lab-pane ' + o.cls + '" id="' + o.id + '" data-foldable="1">' +
      '<div class="res-head"><h4>' + esc(o.title) + (o.tag || "") + "</h4>" +
      '<span class="spacer"></span>' + foldBtn(o.id) + "</div>" +
      (o.sub ? '<div class="res-sub">' + o.sub + "</div>" : "") +
      '<div class="res-body">' + o.body + "</div></div>"
    );
  }

  function labSkeleton(tests, model) {
    return tests
      .map(function (id) {
        var name =
          id === "numfp"
            ? t("数值指纹")
            : id === "relay"
              ? t("协议审计")
              : id === "pelican"
                ? t("一键画鹈鹕")
                : id === "anim"
                  ? t("HTML 动画")
                  : t("检测");
        return (
          '<div class="lab-card"><div class="lab-card-head"><h3>' +
          esc(name) +
          '</h3><span class="meta">' +
          esc(model) +
          t(" · 检测中") +
          '<em class="dots">…</em></span></div><div class="lab-wait"><span class="spin"></span>' +
          esc(t("正在请求网关")) +
          "</div></div>"
        );
      })
      .join("");
  }

  function nowStamp() {
    var d = new Date();
    function p(n) {
      return (n < 10 ? "0" : "") + n;
    }
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  // 检测到底花没花积分：magpie 的计费方式有三种（积分 / 余额 / 额度窗口），
  // 走额度窗口的请求 credits 是 0，所以不能一律写「会花积分」。
  function costText(cost) {
    if (!cost || !cost.requests) return "";
    var parts = [t("本次 {n} 次请求", { n: cost.requests })];
    var modes = cost.modes || {};
    if (Number(cost.credits) > 0) parts.push(t("花费 {x} 积分", { x: fmtCredits(cost.credits) }));
    else if (modes.window) parts.push(t("计入额度窗口，不扣积分"));
    else if (modes.balance) parts.push(t("按余额计费"));
    else parts.push(t("这次没扣积分"));
    if (cost.fail) parts.push(t("失败 {n} 次", { n: cost.fail }));
    return parts.join(" · ");
  }

  function costShort(cost) {
    if (!cost || !cost.requests) return "—";
    var modes = cost.modes || {};
    var tail =
      Number(cost.credits) > 0
        ? t("{x} 积分", { x: fmtCredits(cost.credits) })
        : modes.window
          ? t("额度")
          : modes.balance
            ? t("余额")
            : t("免费");
    return t("{n} 次 · {tail}", { n: cost.requests, tail: tail });
  }

  function foldBtn(id) {
    return '<button class="fold" type="button" data-fold="' + id + '" aria-expanded="true">' +
      '<span class="chev">▾</span><span class="flabel">' + esc(t("收起")) + "</span></button>";
  }

  /* ---------------- 两条证据互相校验 ----------------
     数值指纹看的是「数数的纹理」，协议审计看的是「服务端怎么记账」。前者能被系统提示词
     糊弄（让人家自称 gpt 很容易），后者模型自己改不了，两边一起看才站得住。 */
  /* MODEL-NAME-START —— test.mjs 把这一段抠出来单独跑，改这里记得让测试过 */
  // 型号名有三种写法混在一起：wb-proxy-cn/deepseek-v4.1-flash（供应商/型号）、
  // gpt-6-astra/6.1-sol（型号自己还带一段线路名）、deepseek-v4.1-flash-1017（带四位日期尾）。
  // 逐字比会把「同一型号的另一条线路」误判成冒充（用户 m07537 举的例子就是这种），
  // 所以比的是「型号主干」：最后一段、去四位尾、去厂名前缀、只留字母数字。
  var VENDOR_PREFIX = /^(gpt|chatgpt|claude|gemini|qwen|deepseek|llama|glm|kimi|grok|mistral|minimax|ernie|hunyuan|doubao)[-_.\s]?/;

  function normModel(name) {
    return String(name || "")
      .toLowerCase()
      .replace(/^.*\//, "")          // wb-proxy-cn/deepseek-v4.1-flash → deepseek-v4.1-flash
      .replace(/[-_.]?\d{4}$/, "")   // deepseek-v4.1-flash-1017 → deepseek-v4.1-flash
      .replace(/[^a-z0-9]/g, "");
  }

  function modelCore(name) {
    return String(name || "")
      .toLowerCase()
      .replace(/^.*\//, "")          // 只留最后一段：gpt-6-astra/6.1-sol → 6.1-sol
      .replace(/[-_.]?\d{4}$/, "")
      .replace(VENDOR_PREFIX, "")     // gpt-6.1-sol → 6.1-sol
      .replace(/[^a-z0-9]/g, "");
  }

  function sameModel(a, b) {
    var x = normModel(a);
    var y = normModel(b);
    if (!x || !y) return false;
    if (x === y) return true;
    var cx = modelCore(a);
    var cy = modelCore(b);
    if (!cx || !cy) return false;
    if (cx === cy) return true;
    // 一方是另一方多带了段线路名/厂名的情况；长度至少 4 位才认，免得「6」和「6.1」互相吞
    if (cx.length >= 4 && cy.length >= 4 && (cx.indexOf(cy) === 0 || cy.indexOf(cx) === 0)) return true;
    return false;
  }
  /* MODEL-NAME-END */

  function crossCheck(num, relay, requested) {
    var want = requested || "";
    var got = num && num.ok ? num.predictionName || num.prediction || "" : "";
    var p = num && num.probability !== null && num.probability !== undefined ? Number(num.probability) : null;
    var pct = function (v) { return v === null ? "—" : (v * 100).toFixed(1) + "%"; };
    var auditBad = !!(relay && relay.verdict !== "clean");
    var auditNote = relay
      ? t("协议审计 {score}/100（{label}）", { score: relay.score, label: relay.verdictLabel })
      : "";
    if (!got) {
      if (!relay) return "";
      return (
        '<div class="lab-xcheck ' +
        (auditBad ? "bad" : "dim") +
        '"><b>' +
        esc(t("只有协议层证据")) +
        "</b><span>" +
        esc(auditNote) +
        esc(
          auditBad
            ? t("，{n} 处疑点见下面的清单。这次没测出模型身份。", { n: relay.findings.length })
            : t("。接口本身像真的，但这次没测出模型身份。")
        ) +
        "</span></div>"
      );
    }
    if (!want || sameModel(got, want)) {
      var literally = !want || normModel(got) === normModel(want);
      return (
        '<div class="lab-xcheck ' +
        (auditBad ? "bad" : "ok") +
        '"><b>' +
        esc(auditBad ? t("身份对得上，链路有疑点") : t("两条证据一致")) +
        "</b><span>" +
        esc(t("数数纹理像 ")) +
        "<em>" +
        esc(got) +
        "</em>（" +
        esc(pct(p)) +
        "）——" +
        (literally
          ? esc(t("与请求的型号一致"))
          : esc(t("与请求的 ")) +
            "<em>" +
            esc(want) +
            "</em>" +
            esc(t(" 是同一型号，只是名字落到了另一条线路"))) +
        (relay ? esc(t("；")) + esc(auditNote) : "") +
        esc(t("。")) +
        "</span></div>"
      );
    }
    if (p !== null && p >= 0.6) {
      return (
        '<div class="lab-xcheck bad"><b>' +
        esc(t("身份对不上")) +
        "</b><span>" +
        esc(t("请求的是 ")) +
        "<em>" +
        esc(want) +
        "</em>" +
        esc(t("，数数纹理却更像 ")) +
        "<em>" +
        esc(got) +
        "</em>（" +
        esc(pct(p)) +
        "）——" +
        esc(t("这条路由大概率不是你在页面上选的那个型号")) +
        (relay ? esc(t("；")) + esc(auditNote) : "") +
        esc(t("。")) +
        "</span></div>"
      );
    }
    return (
      '<div class="lab-xcheck dim"><b>' +
      esc(t("数值指纹不够确定")) +
      "</b><span>" +
      esc(t("请求 ")) +
      "<em>" +
      esc(want) +
      "</em>" +
      esc(t("，数数更像 ")) +
      "<em>" +
      esc(got) +
      "</em>" +
      esc(t("，但概率只有 ")) +
      esc(pct(p)) +
      esc(t("，别当定论")) +
      (relay ? esc(t("；")) + esc(auditNote) : "") +
      esc(t("。")) +
      "</span></div>"
    );
  }

  function renderLabResult(payload) {
    var box = el("labResults");
    if (!payload) {
      box.innerHTML = '<div class="empty">' + esc(st.lab.error || t("还没有检测结果")) + "</div>";
      return;
    }
    var results = payload.results || {};
    var family = results.family; // 老结果里还有「自述」，新检测不再产生
    var relay = results.relay;
    var pelican = results.pelican;
    var anim = results.anim;
    var num = results.numfp;
    if (!family && !relay && !pelican && !anim && !num) {
      box.innerHTML = '<div class="empty">' + esc(t("没有结果")) + "</div>";
      return;
    }
    var served =
      (relay && relay.model) || (family && family.served) || (anim && anim.served) || (pelican && pelican.served) || (num && num.model) || payload.model;
    var at = nowStamp();
    var totalMs =
      (Number(relay && relay.ms) || 0) +
      (Number(family && family.ms) || 0) +
      (Number(anim && anim.ms) || 0) +
      (Number(pelican && pelican.ms) || 0) +
      (Number(num && num.ms) || 0);
    var famName = family && family.family ? family.family : family && family.ranking && family.ranking[0] ? family.ranking[0].name : "";

    // 鹈鹕图：白底，跟 magpie 的降智检测卡一个样子，下面是四行小字。
    var shot = "";
    if (pelican) {
      var raw = pelican.raw || "";
      var figure = pelican.svg
        ? '<div class="lab-shot">' + pelican.svg + "</div>"
        : '<div class="lab-shot empty-box">' +
          esc(t("没有拿到 <svg>：")) +
          esc(String(raw).slice(0, 200)) +
          "</div>";
      shot = figure +
        '<div class="lab-shot-meta">' +
        "<span><b>" + esc(t("模型")) + "</b>" + esc(served) + "</span>" +
        "<span><b>" + esc(t("时间")) + "</b>" + esc(at.slice(5)) + "</span>" +
        "<span><b>" + esc(t("强度")) + "</b>" + esc(famName || "—") + "</span>" +
        "<span><b>" + esc(t("耗时")) + "</b>" + fmtMs(pelican.ms) + "</span>" +
        "</div>";
    }

    var fp = "";
    if (family) {
      // 排的是网关清单里的具体型号（deepseek-v4.1-flash 这种），不是泛泛的家族名。
      var ranked = (family.ranking || [])
        .slice(0, 8)
        .map(function (item, k) {
          var pct = Math.max(0, Math.min(1, Number(item.prob) || 0)) * 100;
          var sub = [
            item.family || "",
            item.providers && item.providers.length > 1
              ? t("{n} 个供应商", { n: item.providers.length })
              : ""
          ]
            .filter(Boolean)
            .join(" · ");
          return (
            '<div class="rk-row' + (k === 0 ? " top" : "") + '"><span class="rk-n">' + (k + 1) + "</span>" +
            '<span class="rk-name">' +
            esc(item.name) +
            (item.route ? '<em class="rk-tag">' + esc(t("路由")) + "</em>" : "") +
            (sub ? '<em class="rk-sub">' + esc(sub) + "</em>" : "") + "</span>" +
            '<span class="rk-p">' + pct.toFixed(1) + "%</span>" +
            '<span class="rk-bar"><i data-p="' + (Math.max(0.7, pct) / 100).toFixed(4) + '"></i></span></div>'
          );
        })
        .join("");
      var lib = family.library || st.lab.library || null;
      var libNote =
        lib && lib.count
          ? t("参考库：网关清单里 {c} 个具体型号 · {p} 个供应商 · 归到 {f} 个家族", {
              c: lib.count,
              p: lib.providers || 0,
              f: lib.families || 0
            }) +
            (lib.at ? t(" · 清单取自 {at}", { at: String(lib.at).slice(5, 16).replace("T", " ") }) : "")
          : t("参考库没读到（网关 /v1/models 不通），只能按家族粗略排");
      var rankBlock = ranked
        ? '<div class="rk"><div class="rk-head"><span>' +
          esc(t("候选排名 · 具体型号")) +
          '</span><span class="rk-col">' +
          esc(t("概率")) +
          "</span></div>" +
          ranked + '<div class="rk-foot">' + esc(libNote) + "</div></div>"
        : "";
      fp =
        '<div class="lab-fp"><h4>' +
        esc(t("指纹信息")) +
        '<span class="sub">' +
        esc(family.footnote || "") +
        "</span></h4>" +
        (family.verdict ? '<div class="lab-verdict">' + esc(family.verdict) + "</div>" : "") +
        rankBlock +
        '<div class="signals">' + signalRows(family.signals) + "</div>" +
        (family.error ? '<div class="lab-err">' + esc(family.error) + "</div>" : "") +
        '<details class="lab-raw"><summary>' + esc(t("原始回答")) + '</summary><pre>' +
        esc((family.raw && (family.raw.identity || "") + "\n---\n" + (family.raw.guard || "")) || "") +
        "</pre></details></div>";
    }

    var rawPelican = pelican && !family && !anim && !num
      ? '<div class="lab-fp"><details class="lab-raw"><summary>' +
        esc(t("原始回答")) +
        "</summary><pre>" +
        esc(pelican.raw || "") +
        "</pre></details></div>"
      : "";

    // 数值指纹：它怎么自称都不算数，只看「数数」的统计纹理跟参考库里谁最像。
    var numBlock = "";
    if (num) {
      var numRows = (num.results || [])
        .slice(0, 8)
        .map(function (item, i) {
          var pct = Math.max(0, Math.min(1, Number(item.probability) || 0)) * 100;
          var sub = [item.familyName || item.family || ""].filter(Boolean).join(" · ");
          return (
            '<div class="rk-row' + (i === 0 ? " top" : "") + '"><span class="rk-n">' + (i + 1) + "</span>" +
            '<span class="rk-name">' + esc(item.name) + (sub ? '<em class="rk-sub">' + esc(sub) + "</em>" : "") + "</span>" +
            '<span class="rk-p">' + pct.toFixed(1) + "%</span>" +
            '<span class="rk-bar"><i data-p="' + (Math.max(0.7, pct) / 100).toFixed(4) + '"></i></span></div>'
          );
        })
        .join("");
      var probText =
        num.probability === null || num.probability === undefined
          ? "—"
          : (Number(num.probability) * 100).toFixed(1) + "%";
      var badgeTone = num.ok ? "ok" : num.decision === "not_model" ? "warn" : "bad";
      var numTop = num.ok
        ? '<b class="num-name">' + esc(num.predictionName || num.prediction) + "</b>" +
          '<span class="num-p">' + probText + "</span>" +
          (num.familyName ? '<em class="num-fam">' + esc(num.familyName) + "</em>" : "")
        : '<b class="num-name">' +
          esc(t((num.evidence && num.evidence.label) || num.decisionLabel || "没得分")) +
          "</b>";
      var sampleRows = (num.samples || [])
        .map(function (one) {
          return (
            "<tr><td>" + (one.round || 1) + "</td><td>" + one.index + "</td><td>" + (one.expected || 0) + "</td><td>" +
            (one.parsed || 0) + "</td><td>" + fmtMs(one.ms) + "</td><td>" +
            (one.accepted
              ? '<span class="r ok">' + esc(t("收下")) + "</span>"
              : '<span class="r bad">' + esc(t("没用")) + "</span>") +
            (one.retried ? '<em class="num-retry">' + esc(t("重试")) + "</em>" : "") +
            "</td></tr>"
          );
        })
        .join("");
      var numFoot = [
        num.builtAt ? t("参考库 ") + String(num.builtAt).slice(0, 10) : "",
        t(num.method || ""),
        num.used
          ? num.used +
            " / " +
            (num.probabilityStatus === "merged" ? t("6 个样本（两回合）") : t("3 个样本")) +
            t("入算")
          : "",
        num.margin !== null && num.margin !== undefined
          ? t("与第二名差 {n} 个百分点", { n: (Number(num.margin) * 100).toFixed(1) })
          : ""
      ]
        .filter(Boolean)
        .join(" · ");
      numBlock = pane({
        cls: "lab-num",
        id: "resNum",
        title: t("数值指纹"),
        tag:
          '<span class="res-tag ' +
          badgeTone +
          '">' +
          esc(t(num.decisionLabel || "")) +
          "</span>",
        sub: t("6 次「数数」挑战（两回合） · 看数字串的统计纹理，不看它怎么自称"),
        body:
        '<div class="num-top"><span class="num-badge ' +
        badgeTone +
        '">' +
        esc(t(num.decisionLabel || "")) +
        "</span>" +
        numTop + "</div>" +
        (numRows
          ? '<div class="rk"><div class="rk-head"><span>' +
            esc(t("参考库排名 · 具体型号")) +
            '</span><span class="rk-col">' +
            esc(t("概率")) +
            "</span></div>" +
            numRows +
            "</div>"
          : "") +
        (sampleRows
          ? '<table class="num-samples"><thead><tr>' +
            "<th>" +
            esc(t("回合")) +
            "</th><th>#</th><th>" +
            esc(t("要的数")) +
            "</th><th>" +
            esc(t("解析到")) +
            "</th><th>" +
            esc(t("用时")) +
            "</th><th>" +
            esc(t("结果")) +
            "</th></tr></thead><tbody>" +
            sampleRows + "</tbody></table>"
          : "") +
        (num.evidence && num.evidence.reason && !num.ok
          ? '<div class="lab-verdict">' + esc(num.evidence.reason) + "</div>"
          : "") +
        (numFoot ? '<div class="rk-foot">' + esc(numFoot) + "</div>" : "") +
        (num.error ? '<div class="lab-err">' + esc(num.error) + "</div>" : "")
      });
    }

    // 协议审计：不猜身份，只查「这条路是不是真的按 OpenAI 协议在干活」。
    var relayBlock = "";
    if (relay) {
      var rlChecks = (relay.checks || [])
        .map(function (check) {
          var w = Number(check.weight) || 1;
          var tone = check.pass ? "ok" : check.score >= w * 0.5 ? "warn" : "bad";
          var frac = Math.max(0.02, Math.min(1, (Number(check.score) || 0) / w));
          return (
            '<div class="rl-row"><span class="rl-name">' + esc(check.name) + "</span>" +
            '<span class="rl-bar"><i data-p="' + frac.toFixed(4) + '"></i></span>' +
            '<span class="rl-score ' + tone + '">' + (Number(check.score) || 0) + "<em>/" + w + "</em></span>" +
            '<span class="rl-detail">' + esc(check.detail) + "</span></div>"
          );
        })
        .join("");
      var rlFinds = (relay.findings || [])
        .map(function (item) {
          return '<li class="' + (item.level === "critical" ? "bad" : "warn") + '">' + esc(item.text) + "</li>";
        })
        .join("");
      var rlTone = relay.verdict === "clean" ? "ok" : relay.verdict === "suspicious" ? "warn" : "bad";
      var rlKeys = (relay.usageKeys || []).join("、");
      relayBlock = pane({
        cls: "lab-relay",
        id: "resRelay",
        title: t("协议审计"),
        tag: '<span class="res-tag ' + rlTone + '">' + (Number(relay.score) || 0) + "/100</span>",
        sub: t("回声一致性 / usage 记账 / 函数调用 / 结构化输出 / 流式一致性 · 7 次探针"),
        body:
        '<div class="rl-top"><span class="rl-badge ' + rlTone + '">' + esc(relay.verdictLabel || "") + "</span>" +
        '<b class="rl-total">' + (Number(relay.score) || 0) + "<em>/100</em></b>" +
        '<span class="rl-keys">' +
        esc(t("usage 字段：")) +
        (rlKeys ? esc(rlKeys) : esc(t("一个都没给"))) +
        "</span></div>" +
        '<div class="rl-checks">' + rlChecks + "</div>" +
        (rlFinds
          ? '<ul class="rl-findings">' + rlFinds + "</ul>"
          : '<div class="rl-clean">' + esc(t("这一批没发现疑点。")) + "</div>") +
        '<div class="rk-foot">' + esc(relay.footnote || "") + "</div>" +
        (relay.error ? '<div class="lab-err">' + esc(relay.error) + "</div>" : "")
      });
    }

    // HTML 动画：产物是整份文档，只有放进 iframe 才会真的动起来（内联进主页面会被外层 CSP 挡住）。
    var animBlock = "";
    if (anim) {
      // 没写完的文档不渲染：半张画配上「已渲染」，看起来就是模型不会画。
      var artUrl = anim.ok && anim.htmlId ? artPath(anim.htmlId) : "";
      var feat = anim.features || {};
      var rows = [
        [t("完整度"), feat.bytes ? (Number(feat.bytes) / 1024).toFixed(1) + " KB" : "—"],
        [t("图元"), (feat.elements || 0) + t(" 个图元")],
        [t("动起来"), (feat.animations || 0) + t(" 处 · 关键帧 ") + (feat.keyframes || 0)],
        [t("颜色"), (feat.colours || 0) + t(" 种颜色")],
        [t("耗时"), fmtMs(anim.ms)]
      ]
        .map(function (pair) {
          return "<span><b>" + esc(pair[0]) + "</b>" + esc(pair[1]) + "</span>";
        })
        .join("");
      var animBody = artUrl
        ? '<div class="lab-anim"><iframe title="' +
          esc(t("模型交回来的 HTML 动画")) +
          '" src="' +
          esc(artUrl) +
          '" sandbox="" referrerpolicy="no-referrer" loading="lazy"></iframe>' +
          '<div class="lab-anim-bar"><span class="meta">' + esc(anim.served || served) + "</span>" +
          (anim.retried ? '<span class="meta">' + esc(t("重试过一次")) + "</span>" : "") +
          '<span class="spacer"></span><button class="mini" type="button" data-anim="big">' +
          esc(t("放大")) +
          '</button><a class="mini" href="' +
          esc(artUrl) +
          '" target="_blank" rel="noreferrer">' +
          esc(t("新窗口")) +
          "</a></div></div>"
        : '<div class="lab-anim empty-box"><b>' +
          esc(anim.truncated ? t("这份没画完") : t("没拿到完整 HTML")) +
          "</b><span>" +
          esc(String(anim.error || anim.raw || "").slice(0, 240)) + "</span>" +
          '<button class="mini" type="button" data-again="anim">' +
          esc(t("只重测这一项")) +
          "</button></div>" +
          (anim.htmlId
            ? '<div class="lab-anim-bar"><span class="meta">' +
              esc(t("断掉的那份只供排查")) +
              '</span><span class="spacer"></span><a class="mini" href="' +
              esc(artPath(anim.htmlId)) +
              '" target="_blank" rel="noreferrer">' +
              esc(t("看断口")) +
              "</a></div>"
            : "");
      var animTag = anim.ok
        ? '<span class="res-tag ok">' + esc(t("已渲染")) + "</span>"
        : anim.truncated
          ? '<span class="res-tag bad">' + esc(t("画没画完")) + "</span>"
          : anim.timeout
            ? '<span class="res-tag warn">' + esc(t("超时")) + "</span>"
            : '<span class="res-tag bad">' + esc(t("没拿到")) + "</span>";
      animBlock = pane({
        cls: "lab-anim-wrap",
        id: "resAnim",
        title: t("HTML 动画"),
        tag:
          animTag +
          (anim.custom
            ? '<span class="res-tag plain" title="' +
              esc(t("这次用的是你写的提示词")) +
              '">' +
              esc(t("自定义提示词")) +
              "</span>"
            : ""),
        sub:
          t("CSS 关键帧 + SVG · 脚本和外部资源已剥掉") +
          (anim.ok
            ? ""
            : t(" · 这项最慢，最长等 {n} 秒", { n: Math.round((Number(anim.timeoutMs) || 480000) / 1000) })),
        body: animBody +
        '<div class="lab-shot-meta">' + rows + "</div>" +
        '<div class="signals">' + signalRows(anim.signals) + "</div>" +
        (anim.error ? '<div class="lab-err">' + esc(anim.error) + "</div>" : "") +
        (anim.prompt
          ? '<details class="lab-raw"><summary>' +
            esc(t("这次用的提示词")) +
            "</summary><pre>" +
            esc(anim.prompt) +
            "</pre></details>"
          : "") +
        '<details class="lab-raw"><summary>' +
        esc(t("原始回答")) +
        "</summary><pre>" +
        esc(String(anim.raw || "").slice(0, 20000)) +
        "</pre></details>"
      });
    }

    // 用户要的是一张卡：上面是模型画出来的鹈鹕，下面直接跟它的指纹信息。
    var iqBody =
      (shot ? '<div class="iq-pic">' + shot + "</div>" : "") +
      (fp ? '<div class="iq-fp">' + fp + "</div>" : "") +
      rawPelican;
    var iqHeadNote = shot && fp
      ? t("上面是它画出来的鹈鹕，下面是它对不上号的指纹")
      : shot
        ? t("模型画出来的鹈鹕")
        : t("自述型指纹（不做数，只看路由）");
    var iqBlock = iqBody
      ? pane({ cls: "lab-iq", id: "resIq", title: t("智商检测"), sub: esc(iqHeadNote), body: iqBody })
      : "";

    var xc = crossCheck(num, relay, payload.model || st.lab.model);
    // 第一张卡只说「这次是谁、花了多少、两条证据对不对得上」，
    // 下面每项一张卡，各有自己的标题、结论和收起按钮。
    box.innerHTML =
      '<div class="lab-card lab-sum"><div class="lab-card-head"><h3>' + esc(served) + "</h3>" +
      '<span class="meta">' +
      esc(costText(payload.cost) || t("本次检测")) +
      '</span><span class="spacer"></span><span class="meta">' +
      (totalMs ? t("合计 ") + fmtMs(totalMs) : "") +
      "</span></div>" +
      xc + "</div>" +
      numBlock + relayBlock + animBlock + iqBlock;
    var svgs = box.querySelectorAll(".lab-shot svg");
    for (var k = 0; k < svgs.length; k += 1) {
      svgs[k].removeAttribute("width");
      svgs[k].removeAttribute("height");
    }
    // 候选排名的条：页面 CSP 是 style-src 'self'（没有 unsafe-inline），
    // HTML 里写的 style="width:…" 会被浏览器整条丢掉、条子就变满格；
    // 只有走 CSSOM 赋值才生效，所以长度在这里补上。
    var bars = box.querySelectorAll(".rk-bar i, .rl-bar i");
    for (var b = 0; b < bars.length; b += 1) {
      bars[b].style.transform = "scaleX(" + (bars[b].getAttribute("data-p") || "0") + ")";
    }
    // 动画画布：默认 320px 高，点「放大」铺到 72vh，再点还原。
    var animBox = box.querySelector(".lab-anim");
    if (animBox) {
      var animBtn = animBox.querySelector('[data-anim="big"]');
      if (animBtn) {
        animBtn.addEventListener("click", function () {
          var wrap = animBox.parentNode;
          var big = wrap.className.indexOf("big") >= 0;
          wrap.className = big ? wrap.className.replace(/\s*big\b/g, "") : wrap.className + " big";
          animBtn.textContent = big ? t("放大") : t("还原");
        });
      }
    }
    // 结果卡是刚重绘出来的，折叠态要在这里再套一次，不然上次展开/收起的记录会丢。
    applyFold();
    // 画布：默认压到一屏放得下，点一下放到大图，再点还原。
    var shotBox = box.querySelector(".lab-shot");
    if (shotBox) {
      shotBox.addEventListener("click", function () {
        shotBox.className = shotBox.className.indexOf("big") >= 0
          ? shotBox.className.replace(/\s*big\b/g, "")
          : shotBox.className + " big";
      });
    }
  }

  function renderLabHistory(payload) {
    var box = el("labHistory");
    if (!box) return;
    var items = (payload && payload.items) || [];
    if (!items.length) {
      box.innerHTML = '<div class="empty">' + esc(t("还没有检测记录")) + "</div>";
      return;
    }
    box.innerHTML = items
      .map(function (item) {
        var numTop = (item.numfp && item.numfp.ok && item.numfp.top) || "";
        var numProb = item.numfp && item.numfp.prob !== undefined && item.numfp.prob !== null
          ? (Number(item.numfp.prob) * 100).toFixed(1) + "%"
          : "—";
        var audit = item.relay || null;
        var fam = numTop || (item.family && item.family.top) || (audit ? t("协议审计") : "—");
        var prob = numTop
          ? numProb
          : item.family && item.family.prob !== undefined && item.family.prob !== null
            ? (Number(item.family.prob) * 100).toFixed(1) + "%"
            : audit
              ? (audit.label || "") + " " + (Number(audit.score) || 0)
              : "—";
        var bits = [];
        // 「冒充」的硬信号换成了：请求的型号 ≠ 数值指纹认出的型号。自述那一路已经删掉——
        // 它被后端钉死的系统提示词一改就骗过去了，留着只会误导。
        var clash = !!(numTop && item.model && !sameModel(numTop, item.model));
        // 数值指纹的「型号 · 概率」已经在上面那列了，徽章里不再重复一次。
        if (item.numfp && !item.numfp.ok) {
          bits.push('<span class="r bad">' + esc(t("数值没得分")) + "</span>");
        }
        if (audit) {
          bits.push(
            '<span class="r ' + (audit.verdict === "clean" ? "ok" : audit.verdict === "suspicious" ? "warn" : "bad") +
              '" title="' +
              esc(
                t("协议审计 {score}/100：回声、usage 记账、函数调用、结构化输出、流式一致性", {
                  score: Number(audit.score) || 0
                })
              ) +
              '">' +
              esc(t("审计 ")) +
              (Number(audit.score) || 0) +
              "</span>"
          );
        }
        if (item.anim) {
          bits.push(
            item.anim.ok
              ? '<span class="r ok">' + esc(t("动画")) + "</span>"
              : item.anim.cut
                ? '<span class="r bad" title="' +
                  esc(
                    t("回答被截断了（finish_reason={why}），只画了前半截，不算数", {
                      why: item.anim.cut
                    })
                  ) +
                  '">' +
                  esc(t("画没画完")) +
                  "</span>"
                : '<span class="r bad">' + esc(t("没动画")) + "</span>"
          );
        }
        if (item.pelican) {
          bits.push(
            item.pelican.ok
              ? '<span class="r ok">' + esc(t("出图")) + "</span>"
              : '<span class="r bad">' + esc(t("没出图")) + "</span>"
          );
        }
        if (clash) {
          var why = t(
            "请求的是 {want}，数值指纹认出的是 {got}（{p}）——这条路由大概率不是你要的型号",
            {
              want: item.model,
              got: item.numfp.top,
              p: (Number(item.numfp.prob) * 100).toFixed(1) + "%"
            }
          );
          bits.unshift('<span class="r bad" title="' + esc(why) + '">' + esc(t("对不上")) + "</span>");
        }
        var pel = bits.join("") || '<span class="r">—</span>';
        var when = String(item.at || "").replace("T", " ").slice(5, 16);
        var cls = item.stored ? "hist-row has" : "hist-row";
        var tip = item.stored
          ? t("点开看这次的完整结果")
          : t("这次的结果没留在本地（只保留最近 6 次）");
        return (
          '<div class="' + cls + '" data-at="' + esc(item.at || "") + '" title="' + esc(tip) + '"><span class="t">' + esc(when) + "</span>" +
          '<span class="m" title="' + esc(item.model) + '">' + esc(item.served || item.model) + "</span>" +
          '<span class="f">' + esc(fam) + " · " + prob + "</span>" +
          '<span class="c">' + esc(costShort(item.cost)) + "</span>" +
          '<span class="rb">' + pel + "</span>" +
          "</div>"
        );
      })
      .join("");
    var meta = el("labHistMeta");
    if (meta) meta.textContent = t("最近 {n} 次 · 花不花积分看最后一列", { n: items.length });
  }

  // 服务端回来的分析文字（relay / numeric / lab 的 note、detail）是中文写死的，
  // 英文界面下在这里统一过一遍本地化表，比把 lang 穿进每个 note() 便宜得多。
  function L(value) {
    return window.RI18N && window.RI18N.localize ? window.RI18N.localize(value) : value;
  }

  function loadLabHistory() {
    return riFetch("/api/lab/history", { cache: "no-store" })
      .then(function (response) {
        return response.json();
      })
      .then(function (data) {
        renderLabHistory(L(data));
        if (!labHistoryBound) {
          labHistoryBound = true;
          var box = el("labHistory");
          if (box) {
            box.addEventListener("click", function (event) {
              var row = event.target && event.target.closest ? event.target.closest(".hist-row.has") : null;
              if (!row) return;
              loadLabResult(row.getAttribute("data-at"));
            });
          }
        }
      })
      .catch(function () {
        renderLabHistory({ items: [] });
      });
  }

  var labHistoryBound = false;

  function loadLabResult(at) {
    var url = "/api/lab/last" + (at ? "?at=" + encodeURIComponent(at) : "");
    return riFetch(url, { cache: "no-store" })
      .then(function (response) {
        return response.json();
      })
      .then(function (data) {
        if (data && data.ok && data.item) {
          st.lab.error = "";
          st.lab.last = data.item;
          renderLabResult(L(data.item));
          var card = el("cardLab");
          if (card && card.scrollIntoView) card.scrollIntoView({ block: "nearest" });
        }
      })
      .catch(function () {});
  }
  // 只重测某一项：HTML 动画动辄几分钟，一项失败不该逼着把三项全重跑一遍
  // （那会多花两倍的请求）。结果并回原来那份，次数和积分累加，不覆盖。
  function retryTest(id) {
    if (st.lab.running || !st.lab.model) return;
    var model = st.lab.model;
    st.lab.running = true;
    st.lab.error = "";
    el("labRun").textContent = t("检测中…");
    var node = el("res" + id.charAt(0).toUpperCase() + id.slice(1));
    if (node) node.classList.add("retrying");
    riFetch("/api/lab/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: model, tests: [id], effort: labEffort(), prompt: st.lab.prompt })
    })
      .then(function (response) {
        return response.json();
      })
      .then(function (data) {
        st.lab.running = false;
        el("labRun").textContent = t("开始检测");
        if (!data || !data.results || !data.results[id]) {
          st.lab.error = L(data && data.error) || t("重测失败");
          renderLabResult(L(st.lab.result));
          return;
        }
        var prev = st.lab.result || {};
        var merged = Object.assign({}, prev);
        merged.model = data.model || prev.model;
        merged.at = data.at || prev.at;
        merged.results = Object.assign({}, prev.results || {}, data.results);
        var c0 = prev.cost || {};
        var c1 = data.cost || {};
        merged.cost = {
          requests: (Number(c0.requests) || 0) + (Number(c1.requests) || 0),
          ok: (Number(c0.ok) || 0) + (Number(c1.ok) || 0),
          fail: (Number(c0.fail) || 0) + (Number(c1.fail) || 0),
          credits: Math.round((((Number(c0.credits) || 0) + (Number(c1.credits) || 0)) * 100)) / 100,
          modes: c1.modes || c0.modes || {}
        };
        st.lab.result = merged;
        renderLabResult(L(merged));
        loadLabHistory();
      })
      .catch(function (error) {
        st.lab.running = false;
        el("labRun").textContent = t("开始检测");
        st.lab.error = t("重测失败：") + String((error && error.message) || error);
        renderLabResult(L(st.lab.result));
      });
  }

  function runLab() {
    if (st.lab.running) return;
    var model = st.lab.model;
    var tests = LAB_TESTS.filter(function (item) {
      return st.lab.tests[item[0]];
    }).map(function (item) {
      return item[0];
    });
    if (!model) {
      st.lab.error = t("先选一个模型");
      renderLabResult(null);
      return;
    }
    if (!tests.length) {
      st.lab.error = t("至少选一项检测");
      renderLabResult(null);
      return;
    }
    st.lab.running = true;
    st.lab.error = "";
    el("labRun").textContent = t("检测中…");
    renderLabChecks();
    el("labResults").innerHTML = labSkeleton(tests, model);
    riFetch("/api/lab/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: model, tests: tests, effort: labEffort(), prompt: st.lab.prompt })
    })
      .then(function (response) {
        return response.json();
      })
      .then(function (data) {
        st.lab.running = false;
        el("labRun").textContent = t("开始检测");
        renderLabChecks();
        if (!data || (!data.results && !data.ok)) {
          st.lab.error = L(data && data.error) || t("检测失败");
          renderLabResult(null);
          return;
        }
        st.lab.result = data;
        renderLabResult(L(data));
        loadLabHistory();
      })
      .catch(function (error) {
        st.lab.running = false;
        el("labRun").textContent = t("开始检测");
        renderLabChecks();
        st.lab.error = t("请求失败：") + String((error && error.message) || error);
        renderLabResult(null);
      });
  }

  // 页面加载时记下构建号；ui/ 任何文件一改，服务端构建号就变，5 秒内自己刷新。
  // 之前改完样式，插件窗口里还是旧页面，很容易误判成「没生效」。
  var buildSeen = "";
  function watchBuild() {
    function tick() {
      riFetch("/_route-insight/build", { cache: "no-store" })
        .then(function (res) {
          return res.json();
        })
        .then(function (info) {
          if (!info || !info.id) return;
          var chip = el("build");
          if (!buildSeen) {
            buildSeen = info.id;
            if (chip) chip.textContent = (info.version ? "v" + info.version + " · " : "") + info.id;
            return;
          }
          if (info.id !== buildSeen) {
            buildSeen = info.id;
            if (chip) chip.textContent = t("新版本已就绪，正在刷新…");
            setTimeout(function () {
              location.reload();
            }, 400);
          }
        })
        .catch(function () {
          // 取不到就算了，下一轮再说
        });
    }
    tick();
    setInterval(tick, 5000);
  }

  // 「怎么读这张卡」是带标签和链接的长文，英文版整段替换，不逐句翻。
  function renderHelp() {
    if (!window.RI18N || window.RI18N.LANG !== "en") return;
    var box = document.querySelector(".lab-help");
    if (!box) return;
    var ps = box.querySelectorAll("p");
    for (var i = 0; i < ps.length; i += 1) {
      var key = "help:p" + (i + 1);
      if (window.RI18N.dict && window.RI18N.dict[key]) ps[i].innerHTML = window.RI18N.dict[key];
    }
  }

  function boot() {
    // index.html 里写死的占位文案靠 data-i18n 一次性填掉，长文另外整段换。
    if (window.RI18N && window.RI18N.apply) window.RI18N.apply(document);
    renderHelp();
    var title = t("路由洞察");
    el("title").textContent = title;
    document.title = title;
    buildWindowSeg();
    buildViewSeg();
    buildStatusSeg();
    buildSelects();
    renderLabChecks();
    bindPick();
    bindEfforts();
    bindLabPrompt();
    showView();
    applyFold();
    watchBuild();
    if (st.view === "lab") {
      loadLabModels();
      loadLabHistory();
      loadLabResult();
    }
    if (st.view === "providers") loadProviders();
    // 看板表格里的供应商头像来自这份清单，所以不管在哪个视图都先拉一次。
    else loadProviders();
    watch();
    load();
  }

  boot();
})();