// The page: reads usage:day (the only read package.json declares) for the
// day picked, draws it on a canvas in magpie's colours, and hands that
// canvas's PNG to magpie.image to copy or save.
(async () => {
  const V = globalThis.DayView;
  const $ = (id) => document.getElementById(id);
  const theme = await magpie.ready;
  let lang = theme.lang;
  const zone = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch { return ""; } })();
  const state = { date: "", day: null, icons: new Map(), loading: 0 };

  // ---- words ----
  function words() {
    const t = V.text(lang);
    document.querySelectorAll("[data-t]").forEach((e) => { e.textContent = t[e.dataset.t]; });
    document.querySelectorAll("[data-t-label]").forEach((e) => { e.setAttribute("aria-label", t[e.dataset.tLabel]); e.title = t[e.dataset.tLabel]; });
  }
  let statusTimer = 0;
  function status(msg, bad, keep) {
    clearTimeout(statusTimer);
    $("status").textContent = msg || "";
    $("status").classList.toggle("bad", !!bad);
    if (msg && !keep) statusTimer = setTimeout(() => status(""), 6000);
  }

  // ---- colours and fonts, from magpie's theme ----
  function look() {
    const css = getComputedStyle(document.documentElement);
    const v = (k, f) => css.getPropertyValue("--magpie-" + k).trim() || f;
    const dark = document.documentElement.dataset.theme === "dark";
    return {
      bg: v("card", dark ? "#1c1c1e" : "#f6f6f7"),
      fg: v("fg", dark ? "#f5f5f7" : "#1d1d1f"),
      fg2: v("fg-2", v("fg", dark ? "#d1d1d6" : "#3a3a3c")),
      muted: v("muted", dark ? "#98989d" : "#6e6e73"),
      line: v("line", dark ? "#38383a" : "#e5e5ea"),
      font: v("font", '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif'),
      code: v("code", "ui-monospace, SFMono-Regular, Menlo, monospace"),
    };
  }

  // ---- logos: data: pictures from the read, a mono one in the text's colour ----
  function picture(name) {
    const ic = state.day?.icons?.[name];
    if (!ic?.src) return Promise.resolve(null);
    if (!state.icons.has(ic.src)) {
      state.icons.set(ic.src, new Promise((ok) => {
        const img = new Image();
        img.onload = () => ok({ img, mono: !!ic.mono });
        img.onerror = () => ok(null);
        img.src = ic.src;
      }));
    }
    return state.icons.get(ic.src);
  }
  function drawIcon(ctx, ic, x, y, size, colour, scale) {
    if (!ic) {
      // no logo: a quiet dot where it would be
      ctx.fillStyle = colour;
      ctx.globalAlpha = 0.3;
      ctx.beginPath();
      ctx.arc(x + size / 2, y + size / 2, size * 0.28, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      return;
    }
    if (!ic.mono) {
      ctx.drawImage(ic.img, x, y, size, size);
      return;
    }
    const px = Math.ceil(size * scale);
    const off = document.createElement("canvas");
    off.width = off.height = px;
    const o = off.getContext("2d");
    o.drawImage(ic.img, 0, 0, px, px);
    o.globalCompositeOperation = "source-in";
    o.fillStyle = colour;
    o.fillRect(0, 0, px, px);
    ctx.drawImage(off, x, y, size, size);
  }

  // ---- the card ----
  const W = 600;
  const PAD = 28;
  function fit(ctx, s, width) {
    if (ctx.measureText(s).width <= width) return s;
    let lo = 0, hi = s.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ctx.measureText(s.slice(0, mid) + "…").width <= width) lo = mid; else hi = mid - 1;
    }
    return s.slice(0, lo) + "…";
  }

  // the card's height for model c: the drawing's own walk, measured
  function heightOf(c) {
    let h = PAD + 22 + 58 + 22 + 22 + 50 + 24;
    if (c.empty) h += 40;
    else {
      h += 24;
      for (const a of c.agents) h += 30 + a.models.length * 22 + (a.more ? 20 : 0) + 8;
      if (c.moreAgents) h += 20;
    }
    h += 16 + 60 + (c.note ? 18 : 0) + 18 + PAD;
    return Math.ceil(h);
  }

  async function draw() {
    const day = state.day;
    if (!day) return;
    const c = V.card(day, lang);
    const icons = new Map();
    await Promise.all([...new Set(c.agents.flatMap((a) => [a.icon, ...a.models.map((m) => m.icon)]))].map(async (n) => icons.set(n, await picture(n))));
    if (state.day !== day) return;
    const L = look();
    const H = heightOf(c);
    const scale = Math.max(2, Math.min(3, Math.ceil(window.devicePixelRatio || 1)));
    const cv = $("card");
    cv.width = W * scale;
    cv.height = H * scale;
    cv.style.aspectRatio = `${W} / ${H}`;
    const ctx = cv.getContext("2d");
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = L.bg;
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(0, 0, W, H, 18) : ctx.rect(0, 0, W, H);
    ctx.fill();
    ctx.textBaseline = "alphabetic";
    const f = (w, px, fam = L.font) => `${w} ${px}px ${fam}`;
    const right = W - PAD;
    const rule = (y) => {
      ctx.fillStyle = L.line;
      ctx.fillRect(PAD, y, W - PAD * 2, 1);
    };
    let y = PAD;

    // magpie, and the day
    y += 14;
    ctx.font = f(600, 13);
    ctx.fillStyle = L.fg;
    ctx.textAlign = "left";
    ctx.fillText("magpie", PAD, y);
    ctx.font = f(400, 13);
    ctx.fillStyle = L.muted;
    ctx.textAlign = "right";
    ctx.fillText(c.date, right, y);
    y += 8;

    // the day's tokens
    y += 52;
    ctx.textAlign = "left";
    ctx.fillStyle = L.fg;
    ctx.font = f(600, 46);
    ctx.fillText(c.headline, PAD - 2, y);
    const hw = ctx.measureText(c.headline).width;
    ctx.font = f(400, 16);
    ctx.fillStyle = L.muted;
    ctx.fillText(c.unit, PAD + hw + 8, y);
    y += 6;
    y += 22;
    ctx.font = f(400, 14);
    ctx.fillStyle = L.fg2;
    ctx.fillText(c.sub, PAD, y);
    y += 22;

    // input, output, cache, hits
    const col = (W - PAD * 2) / c.stats.length;
    c.stats.forEach((s, i) => {
      const x = PAD + i * col;
      ctx.font = f(400, 12);
      ctx.fillStyle = L.muted;
      ctx.fillText(fit(ctx, s.label, col - 10), x, y + 14);
      ctx.font = f(600, 17);
      ctx.fillStyle = L.fg;
      ctx.fillText(s.value, x, y + 38);
    });
    y += 50;
    y += 12;
    rule(y);
    y += 12;

    if (c.empty) {
      ctx.font = f(400, 14);
      ctx.fillStyle = L.muted;
      ctx.fillText(c.empty, PAD, y + 26);
      y += 40;
    } else {
      ctx.font = f(400, 12);
      ctx.fillStyle = L.muted;
      ctx.fillText(c.agentsLabel, PAD, y + 16);
      y += 24;
      for (const a of c.agents) {
        drawIcon(ctx, icons.get(a.icon), PAD, y + 4, 18, L.fg, scale);
        ctx.font = f(400, 13);
        ctx.textAlign = "right";
        ctx.fillStyle = L.fg2;
        ctx.fillText(a.value, right, y + 18);
        const vw = ctx.measureText(a.value).width;
        ctx.textAlign = "left";
        ctx.font = f(600, 14);
        ctx.fillStyle = L.fg;
        ctx.fillText(fit(ctx, a.name, W - PAD * 2 - 28 - vw - 16), PAD + 28, y + 18);
        // its share of the day's busiest agent
        ctx.fillStyle = L.line;
        ctx.fillRect(PAD + 28, y + 25, W - PAD * 2 - 28, 2);
        ctx.fillStyle = L.muted;
        ctx.fillRect(PAD + 28, y + 25, Math.max(2, (W - PAD * 2 - 28) * a.share), 2);
        y += 30;
        for (const m of a.models) {
          drawIcon(ctx, icons.get(m.icon), PAD + 28, y + 5, 13, L.fg2, scale);
          ctx.font = f(400, 12);
          ctx.textAlign = "right";
          ctx.fillStyle = L.muted;
          ctx.fillText(m.value, right, y + 16);
          const mw = ctx.measureText(m.value).width;
          ctx.textAlign = "left";
          ctx.font = f(400, 12.5, L.code);
          ctx.fillStyle = L.fg2;
          ctx.fillText(fit(ctx, m.name, W - PAD * 2 - 48 - mw - 16), PAD + 48, y + 16);
          y += 22;
        }
        if (a.more) {
          ctx.font = f(400, 12);
          ctx.fillStyle = L.muted;
          ctx.fillText(a.more, PAD + 48, y + 14);
          y += 20;
        }
        y += 8;
      }
      if (c.moreAgents) {
        ctx.font = f(400, 12);
        ctx.fillStyle = L.muted;
        ctx.fillText(c.moreAgents, PAD + 28, y + 12);
        y += 20;
      }
    }

    // streak, average day, the last two weeks
    y += 4;
    rule(y);
    y += 12;
    const third = (W - PAD * 2) / 3;
    for (const [i, s] of [c.streak, c.average].entries()) {
      const x = PAD + i * third;
      ctx.textAlign = "left";
      ctx.font = f(400, 12);
      ctx.fillStyle = L.muted;
      ctx.fillText(fit(ctx, s.label, third - 12), x, y + 16);
      ctx.font = f(600, 15);
      ctx.fillStyle = L.fg;
      ctx.fillText(fit(ctx, s.value, third - 12), x, y + 40);
    }
    const bars = c.bars;
    const most = bars.reduce((m, b) => Math.max(m, b.tokens), 0);
    const bw = 7, gap = 4;
    const bx = right - bars.length * (bw + gap) + gap;
    const base = y + 44;
    bars.forEach((b, i) => {
      const h = b.tokens > 0 && most > 0 ? Math.max(3, (b.tokens / most) * 34) : 1.5;
      ctx.fillStyle = i === bars.length - 1 ? L.fg : L.muted;
      ctx.globalAlpha = i === bars.length - 1 ? 1 : b.tokens > 0 ? 0.45 : 0.3;
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(bx + i * (bw + gap), base - h, bw, h, Math.min(2, h / 2)) : ctx.rect(bx + i * (bw + gap), base - h, bw, h);
      ctx.fill();
    });
    ctx.globalAlpha = 1;
    y += 60;
    if (c.note) {
      ctx.font = f(400, 11);
      ctx.fillStyle = L.muted;
      ctx.fillText(c.note, PAD, y + 8);
      y += 18;
    }
    ctx.font = f(400, 11);
    ctx.fillStyle = L.muted;
    ctx.textAlign = "right";
    ctx.fillText("usemagpie.ai", right, y + 10);
    ctx.textAlign = "left";
    $("copy").disabled = $("save").disabled = !magpie.image;
  }

  // ---- reading a day ----
  async function load(date) {
    const n = ++state.loading;
    try {
      const day = await magpie.read("usage:day", { date: date || "", tz: zone });
      if (n !== state.loading) return;
      state.day = day;
      state.date = day.date;
      status("");
    } catch (e) {
      if (n !== state.loading) return;
      const m = String(e?.message || e);
      // a magpie from before usage:day refuses it as a read it doesn't have
      status(/usage:day/.test(m) ? V.text(lang).update : `${V.text(lang).failed}: ${m}`, true, true);
    }
    paintBar();
    await draw();
  }

  function paintBar() {
    const d = state.day;
    $("date-text").textContent = d ? V.dateLabel(d.date, lang) : "…";
    $("next").disabled = !d || d.date >= d.today;
    $("today").disabled = !d || d.date === d.today;
    $("prev").disabled = !d;
  }

  // ---- the day menu: the days that had calls, newest first ----
  const menu = $("menu");
  function openMenu() {
    const d = state.day;
    if (!d) return;
    const days = (d.days || []).slice().reverse().slice(0, 120);
    if (!days.some((x) => x.date === d.today)) days.unshift({ date: d.today, tokens: 0 });
    menu.replaceChildren(...days.map((x) => {
      const li = document.createElement("li");
      li.setAttribute("role", "option");
      li.dataset.date = x.date;
      li.setAttribute("aria-selected", String(x.date === d.date));
      const a = document.createElement("span");
      a.textContent = V.dateLabel(x.date, lang);
      const b = document.createElement("span");
      b.textContent = x.tokens ? V.count(x.tokens) : "";
      li.append(a, b);
      return li;
    }));
    menu.hidden = false;
    menu.classList.remove("closing");
    menu.classList.add("opening");
    $("date").setAttribute("aria-expanded", "true");
    requestAnimationFrame(() => menu.classList.remove("opening"));
    menu.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }
  function closeMenu() {
    if (menu.hidden) return;
    $("date").setAttribute("aria-expanded", "false");
    menu.classList.add("closing");
    setTimeout(() => { if (menu.classList.contains("closing")) { menu.hidden = true; menu.classList.remove("closing"); } }, 110);
  }
  $("date").addEventListener("click", (e) => {
    e.stopPropagation();
    if (menu.hidden || menu.classList.contains("closing")) openMenu(); else closeMenu();
  });
  menu.addEventListener("click", (e) => {
    const li = e.target.closest("li");
    if (!li) return;
    closeMenu();
    if (li.dataset.date !== state.date) load(li.dataset.date);
  });
  document.addEventListener("click", (e) => { if (!e.target.closest(".pick")) closeMenu(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); });

  $("prev").addEventListener("click", () => state.date && load(V.shift(state.date, -1)));
  $("next").addEventListener("click", () => state.date && state.day && state.date < state.day.today && load(V.shift(state.date, 1)));
  $("today").addEventListener("click", () => load(""));

  // ---- sharing ----
  const png = () => new Promise((ok, no) => $("card").toBlob((b) => (b ? ok(b) : no(new Error("no picture"))), "image/png"));
  $("copy").addEventListener("click", async () => {
    const b = $("copy");
    b.disabled = true;
    try {
      await magpie.image.copy(await png());
      b.textContent = V.text(lang).copied;
      setTimeout(() => { b.textContent = V.text(lang).copy; }, 1500);
    } catch (e) {
      status(`${V.text(lang).shareFailed}: ${e?.message || e}`, true);
    } finally {
      b.disabled = false;
    }
  });
  $("save").addEventListener("click", async () => {
    const b = $("save");
    b.disabled = true;
    try {
      const r = await magpie.image.save(await png(), V.fileName(state.date));
      if (r?.path) status(`${V.text(lang).saved} ${r.path}`);
    } catch (e) {
      status(`${V.text(lang).shareFailed}: ${e?.message || e}`, true);
    } finally {
      b.disabled = false;
    }
  });

  magpie.onTheme((t) => { lang = t.lang; words(); paintBar(); draw(); });
  // today's numbers keep coming while the page is open
  setInterval(() => { if (state.day && state.date === state.day.today && document.visibilityState !== "hidden") load(state.date); }, 60_000);
  words();
  paintBar();
  await load("");
})();
