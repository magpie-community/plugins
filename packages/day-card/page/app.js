// The page: reads usage:day (the only read package.json declares) for the
// day picked, draws it on a canvas as a receipt, and hands that canvas's
// PNG to magpie.image to copy or save.
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

  // ---- the receipt's look: fixed, as a printed slip is, in either theme ----
  const INK = "#1f1d20";
  const MUTED = "#76736e";
  const PAPER = "#f7f4ed";
  const DASH = "#a8a49c";
  const MONO = '"Day Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, "PingFang SC", "Hiragino Sans", "Microsoft YaHei", "Noto Sans CJK SC", monospace';

  // JetBrains Mono from fonts.js's bytes: no fetch, which the frame can't make
  const fonts = (async () => {
    const F = globalThis.DayFonts || {};
    await Promise.all(Object.entries(F).map(async ([weight, b64]) => {
      try {
        const bin = atob(b64);
        const buf = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
        const face = new FontFace("Day Mono", buf.buffer, { weight });
        document.fonts.add(await face.load());
      } catch {
        // the system's monospace draws it instead
      }
    }));
  })();

  // ---- logos: data: pictures from the read, each drawn in the ink ----
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
  // A mark (a mono logo, or a colour one with no ground of its own) is
  // filled with the ink; a picture on a light ground of its own (an app's
  // tile, a drawing) prints in the ink, only its near-white parts left the
  // paper's, and what is clear around it stays clear.
  function drawIcon(ctx, ic, x, y, size, scale) {
    if (!ic) {
      ctx.fillStyle = INK;
      ctx.beginPath();
      ctx.arc(x + size / 2, y + size / 2, size * 0.22, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    const px = Math.max(1, Math.ceil(size * scale));
    const off = document.createElement("canvas");
    off.width = off.height = px;
    const o = off.getContext("2d");
    o.drawImage(ic.img, 0, 0, px, px);
    let clear = ic.mono;
    if (!clear) {
      try {
        const d = o.getImageData(0, 0, px, px);
        const p = d.data;
        const lum = (i) => (0.2126 * p[i] + 0.7152 * p[i + 1] + 0.0722 * p[i + 2]) / 255;
        let solid = 0, light = 0, dark = 0;
        for (let i = 0; i < p.length; i += 4) {
          if (p[i + 3] < 128) continue;
          solid++;
          const v = lum(i);
          if (v > 0.8) light++;
          else if (v < 0.5) dark++;
        }
        // a ground: mostly light, with something dark drawn on it
        clear = !(solid && light / solid > 0.35 && dark / solid > 0.05) && solid < px * px * 0.8;
        if (!clear) {
          const ink = [0x1f, 0x1d, 0x20], paper = [0xf7, 0xf4, 0xed];
          for (let i = 0; i < p.length; i += 4) {
            // only what is near white stays light: a logo prints solid
            const t = Math.min(1, Math.max(0, (lum(i) - 0.65) / 0.2));
            const l = t * t * (3 - 2 * t);
            for (let k = 0; k < 3; k++) p[i + k] = ink[k] + (paper[k] - ink[k]) * l;
          }
          o.putImageData(d, 0, 0);
        }
      } catch {
        clear = true;
      }
    }
    if (clear) {
      o.globalCompositeOperation = "source-in";
      o.fillStyle = INK;
      o.fillRect(0, 0, px, px);
    }
    ctx.drawImage(off, x, y, size, size);
  }

  // ---- the receipt ----
  const PW = 440; // the paper
  const PAD = 30; // the paper's margin
  const SIDE = 207; // the backdrop either side, and above and below
  const TOP = 48;
  const BOTTOM = 52;
  const TOOTH = 5; // the torn edge's teeth

  const f = (w, px) => `${w} ${px}px ${MONO}`;
  function fit(ctx, s, width) {
    if (ctx.measureText(s).width <= width) return s;
    let lo = 0, hi = s.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ctx.measureText(s.slice(0, mid) + "…").width <= width) lo = mid; else hi = mid - 1;
    }
    return s.slice(0, lo) + "…";
  }
  // text with its letters spaced, centred on cx
  function spaced(ctx, s, cx, y, em, max) {
    const chars = [...s];
    const bare = chars.reduce((n, ch) => n + ctx.measureText(ch).width, 0);
    const gap = Math.max(0, Math.min(em, (max - bare) / Math.max(1, chars.length - 1)));
    const w = bare + gap * (chars.length - 1);
    let x = cx - w / 2;
    ctx.textAlign = "left";
    for (const ch of chars) {
      ctx.fillText(ch, x, y);
      x += ctx.measureText(ch).width + gap;
    }
  }
  // the largest size up to px that keeps s within width
  function sized(ctx, weight, px, s, width) {
    ctx.font = f(weight, px);
    const w = ctx.measureText(s).width;
    if (w > width) {
      px = Math.max(10, Math.floor(px * width / w));
      ctx.font = f(weight, px);
    }
    return px;
  }

  // The slip's text, top to bottom, on the paper at (0, 0); the height it
  // took. Run once on a scratch canvas to measure, then on the card.
  function slip(ctx, c, icons, scale) {
    const L = PAD, R = PW - PAD, inner = R - L;
    const rule = (y) => {
      ctx.save();
      ctx.strokeStyle = DASH;
      ctx.lineWidth = 1;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(L + 11, y + 0.5);
      ctx.lineTo(R - 11, y + 0.5);
      ctx.stroke();
      ctx.restore();
    };
    const row = (label, value, y, o = {}) => {
      ctx.font = f(o.weight || 400, o.px || 12.5);
      ctx.fillStyle = o.colour || INK;
      ctx.textAlign = "right";
      ctx.fillText(value, R, y);
      const vw = ctx.measureText(value).width;
      ctx.textAlign = "left";
      ctx.fillText(fit(ctx, label, inner - vw - 14), L, y);
    };
    const glow = (on) => {
      ctx.shadowColor = on ? "rgba(31, 29, 32, .16)" : "transparent";
      ctx.shadowBlur = on ? 14 : 0;
      ctx.shadowOffsetY = on ? 3 : 0;
    };
    ctx.textBaseline = "alphabetic";
    let y = 0;

    // title and tagline
    y += 54;
    ctx.fillStyle = INK;
    sized(ctx, 800, 30, c.title, inner);
    ctx.textAlign = "center";
    glow(true);
    ctx.fillText(c.title, PW / 2, y);
    glow(false);
    y += 25;
    ctx.font = f(400, 11.5);
    ctx.fillText(c.tagline, PW / 2, y);

    // the day, and when this was drawn
    y += 27;
    c.head.forEach((h, i) => {
      if (i) y += 22;
      row(h.label, h.value, y);
    });
    y += 15;
    rule(y);

    // the day's cost
    y += 25;
    ctx.fillStyle = INK;
    ctx.font = f(400, 12.5);
    spaced(ctx, c.totalLabel, PW / 2, y, 3.2, inner);
    y += 57;
    sized(ctx, 800, 52, c.total, inner);
    ctx.textAlign = "center";
    glow(true);
    ctx.fillText(c.total, PW / 2, y);
    glow(false);
    y += 23;
    sized(ctx, 400, 10.5, c.totalNote, inner);
    spaced(ctx, c.totalNote, PW / 2, y, 1.6, inner);
    y += 16;
    rule(y);

    // streak, requests, against an average day
    y += 25;
    c.stats.forEach((s, i) => {
      if (i) y += 21;
      row(s.label, s.value, y);
    });
    y += 15;
    rule(y);

    // each agent and its models, by cost
    y += 25;
    row(c.agentHead[0], c.agentHead[1], y, { colour: MUTED });
    if (c.empty) {
      y += 27;
      ctx.font = f(400, 12.5);
      ctx.fillStyle = MUTED;
      ctx.textAlign = "left";
      ctx.fillText(c.empty, L, y);
    }
    for (const a of c.agents) {
      y += 27;
      drawIcon(ctx, icons.get(a.icon), L, y - 15, 18, scale);
      ctx.font = f(700, 14.5);
      ctx.fillStyle = INK;
      ctx.textAlign = "right";
      ctx.fillText(a.value, R, y);
      const vw = ctx.measureText(a.value).width;
      ctx.textAlign = "left";
      ctx.fillText(fit(ctx, a.name, inner - 26 - vw - 14), L + 26, y);
      y += 1;
      for (const m of a.models) {
        y += 27;
        drawIcon(ctx, icons.get(m.icon), L + 26, y - 10.5, 12, scale);
        ctx.font = f(400, 12.5);
        ctx.fillStyle = INK;
        ctx.textAlign = "right";
        ctx.fillText(m.value, R, y);
        const mw = ctx.measureText(m.value).width;
        ctx.textAlign = "left";
        ctx.fillText(fit(ctx, m.name, inner - 44 - mw - 14), L + 44, y);
      }
      if (a.more) {
        y += 24;
        ctx.font = f(400, 11.5);
        ctx.fillStyle = MUTED;
        ctx.textAlign = "left";
        ctx.fillText(a.more, L + 44, y);
      }
      y += 3;
    }
    if (c.moreAgents) {
      y += 24;
      ctx.font = f(400, 11.5);
      ctx.fillStyle = MUTED;
      ctx.textAlign = "left";
      ctx.fillText(c.moreAgents, L + 26, y);
    }
    y += 17;
    rule(y);

    // the tokens
    y += 25;
    c.tokens.forEach((s, i) => {
      if (i) y += 21;
      row(s.label, s.value, y);
    });
    if (c.note) {
      y += 21;
      row(c.note, "", y, { colour: MUTED, px: 11 });
    }
    y += 18;
    rule(y);

    // the footer, one word of it bold
    y += 22;
    for (const line of c.footer) {
      const parts = line.map((s, i) => ({ s, w: i === 1 ? 700 : 400 })).filter((p) => p.s);
      const width = parts.reduce((n, p) => { ctx.font = f(p.w, 10.5); return n + ctx.measureText(p.s).width; }, 0);
      let x = PW / 2 - width / 2;
      ctx.fillStyle = INK;
      ctx.textAlign = "left";
      for (const p of parts) {
        ctx.font = f(p.w, 10.5);
        ctx.fillText(p.s, x, y);
        x += ctx.measureText(p.s).width;
      }
      y += 20;
    }
    return Math.ceil(y + 4);
  }

  async function draw() {
    const day = state.day;
    if (!day) return;
    await fonts;
    const c = V.card(day, lang);
    const icons = new Map();
    await Promise.all([...new Set(c.agents.flatMap((a) => [a.icon, ...a.models.map((m) => m.icon)]))].map(async (n) => icons.set(n, await picture(n))));
    if (state.day !== day) return;
    const scale = Math.max(2, Math.min(3, Math.ceil(window.devicePixelRatio || 1)));

    // measure, then draw
    const ph = slip(document.createElement("canvas").getContext("2d"), c, new Map(), 1) + TOOTH;
    const W = PW + SIDE * 2;
    const H = Math.max(TOP + ph + BOTTOM, Math.round(W * 4 / 3));
    const top = Math.round((H - ph) / 2.15);
    const cv = $("card");
    cv.width = W * scale;
    cv.height = H * scale;
    cv.style.aspectRatio = `${W} / ${H}`;
    const ctx = cv.getContext("2d");
    ctx.setTransform(scale, 0, 0, scale, 0, 0);

    // the backdrop: teal at the top left to mint at the bottom right
    const g = ctx.createLinearGradient(0, 0, W * 0.35, H);
    g.addColorStop(0, "#1dd8d1");
    g.addColorStop(1, "#92ecc6");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    const g2 = ctx.createLinearGradient(0, 0, W, 0);
    g2.addColorStop(0, "rgba(255, 255, 255, 0)");
    g2.addColorStop(1, "rgba(255, 255, 255, .14)");
    ctx.fillStyle = g2;
    ctx.fillRect(0, 0, W, H);

    // the paper, torn along its foot, and its shadow
    ctx.save();
    ctx.translate(SIDE, top);
    const paper = new Path2D();
    paper.moveTo(0, 0);
    paper.lineTo(PW, 0);
    paper.lineTo(PW, ph - TOOTH);
    const teeth = Math.round(PW / (TOOTH * 2));
    const tw = PW / teeth;
    for (let i = teeth - 1; i >= 0; i--) {
      paper.lineTo(i * tw + tw / 2, ph);
      paper.lineTo(i * tw, ph - TOOTH);
    }
    paper.closePath();
    ctx.shadowColor = "rgba(0, 60, 55, .28)";
    ctx.shadowBlur = 36;
    ctx.shadowOffsetY = 12;
    ctx.fillStyle = PAPER;
    ctx.fill(paper);
    ctx.shadowColor = "transparent";
    slip(ctx, c, icons, scale);
    ctx.restore();
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
