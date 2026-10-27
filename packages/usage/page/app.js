// The page: reads usage:summary (the only read package.json declares) for
// the period picked, and keeps the period and the sort in this plugin's
// own options so the page opens where it was left.
(async () => {
  const V = globalThis.UsageView;
  const $ = (id) => document.getElementById(id);
  const theme = await magpie.ready;
  let lang = theme.lang;
  let opts = {};
  try { opts = (await magpie.options.get()) || {}; } catch {}
  const state = {
    period: V.PERIODS.includes(opts.period) ? opts.period : "today",
    sort: V.SORTS.includes(opts.sort) ? opts.sort : "tokens",
    summary: null,
  };

  function words() {
    const t = V.text(lang);
    document.querySelectorAll("[data-t]").forEach((e) => { e.textContent = t[e.dataset.t]; });
  }

  function select(group, attr, value) {
    $(group).querySelectorAll("button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset[attr] === value)));
  }

  function paint() {
    select("periods", "period", state.period);
    select("sorts", "sort", state.sort);
    const s = state.summary;
    if (!s) return;
    $("since").textContent = V.since(s, lang);
    $("tiles").replaceChildren(...V.tiles(s, lang).map((t) => {
      const d = document.createElement("div");
      d.className = "tile" + (t.bad ? " bad" : "");
      for (const [cls, v] of [["k", t.label], ["v", t.value], ["s", t.sub]]) {
        const e = document.createElement("div");
        e.className = cls;
        e.textContent = v;
        d.append(e);
      }
      return d;
    }));
    const rows = V.rows(s, state.sort, lang);
    $("empty").hidden = rows.length > 0;
    $("empty").textContent = V.text(lang).noCalls;
    $("models").replaceChildren(...rows.map((r) => {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = name.title = r.name;
      const num = document.createElement("span");
      num.className = "num";
      num.textContent = `${r.value} · ${r.detail}`;
      const bar = document.createElement("span");
      bar.className = "bar";
      const fill = document.createElement("i");
      fill.style.width = `${Math.max(2, Math.round(r.share * 100))}%`;
      bar.append(fill);
      li.append(name, num, bar);
      return li;
    }));
  }

  async function load() {
    try {
      state.summary = await magpie.read("usage:summary", { period: state.period });
      $("error").hidden = true;
    } catch (e) {
      $("error").hidden = false;
      $("error").textContent = `${V.text(lang).failed}: ${e.message}`;
    }
    paint();
  }

  // options can be set once a second: a quick second click is saved with
  // the next one
  let saving = null;
  function save() {
    if (saving) return;
    saving = setTimeout(async () => {
      saving = null;
      try { opts = await magpie.options.set({ ...opts, period: state.period, sort: state.sort }); } catch {}
    }, 1100);
  }

  $("periods").addEventListener("click", (e) => {
    const p = e.target.closest("button")?.dataset.period;
    if (!p || p === state.period) return;
    state.period = p;
    paint();
    load();
    save();
  });
  $("sorts").addEventListener("click", (e) => {
    const s = e.target.closest("button")?.dataset.sort;
    if (!s || s === state.sort) return;
    state.sort = s;
    paint();
    save();
  });
  magpie.onTheme((t) => { lang = t.lang; words(); paint(); });
  // fresh numbers while the page is open
  setInterval(load, 60_000);
  words();
  await load();
})();
