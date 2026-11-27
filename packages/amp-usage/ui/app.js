const $ = (id) => document.getElementById(id);
const query = new URL(location.href).searchParams;
const root = document.documentElement;
const theme = query.get("theme");
root.dataset.theme =
  theme === "dark" ||
  (!theme && matchMedia("(prefers-color-scheme: dark)").matches)
    ? "dark"
    : "light";
try {
  // Magpie's own colours, handed over by the launcher.
  const tokens = JSON.parse(atob(query.get("tokens") || ""));
  for (const [k, v] of Object.entries(tokens))
    if (/^[a-z0-9-]+$/.test(k)) root.style.setProperty(`--magpie-${k}`, v);
} catch {
  /* The fallbacks in style.css apply. */
}
const lang = (query.get("lang") || navigator.language || "")
  .toLowerCase()
  .startsWith("zh")
  ? "zh"
  : "en";
root.lang = lang === "zh" ? "zh-CN" : "en";

const W = AmpUsage.words[lang];
document.title = W.title;
for (const node of document.querySelectorAll("[data-t]"))
  node.textContent = W[node.dataset.t];
$("refresh").title = W.refresh;
$("refresh").setAttribute("aria-label", W.refresh);
$("auto").setAttribute("aria-label", W.auto);

const groups = {
  noTime: ["missingTimestamp"],
  inProgress: ["unfinished", "settling"],
  excluded: ["excludedThread", "excludedModel"],
  held: [
    "identityChanged",
    "changedAfterImport",
    "conflictingIdentity",
    "invalidUsage",
    "missingIdentity",
    "invalidThread",
    "rejected",
  ],
};
const locale = lang === "zh" ? "zh-CN" : "en";
const compact = new Intl.NumberFormat(locale, {
  notation: "compact",
  maximumFractionDigits: 1,
});
const full = new Intl.NumberFormat(locale);
const two = (n) => String(n).padStart(2, "0");
const dayOf = (d) =>
  `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
const hourOf = (d) => `${dayOf(d)}T${two(d.getHours())}`;
const dateOf = (key) => {
  const [y, m, d, h = 0] = key.split(/[-T]/).map(Number);
  return new Date(y, m - 1, d, h);
};
const el = (tag, text, cls) => {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
};
const number = (tag, n) => {
  const e = el(tag, compact.format(n));
  e.title = full.format(n);
  return e;
};
const share = (x) => (x > 0 && x < 0.01 ? "<1%" : `${Math.round(x * 100)}%`);
const total = (r) => r.in + r.out + r.cache_read + r.cache_write;
const sum = (rows) =>
  rows.reduce(
    (a, r) => {
      for (const k of Object.keys(a)) a[k] += r[k];
      return a;
    },
    { calls: 0, in: 0, out: 0, cache_read: 0, cache_write: 0 },
  );

// What the reader chose last time. A convenience: the page works without it.
const kept = (key, fallback) => {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
};
const keep = (key, value) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* See above. */
  }
};
const token = document.querySelector('meta[name="service-token"]').content;
let state,
  busy = false,
  failure = "",
  turn = 0,
  period = kept("period", "30d"),
  auto = Number(kept("auto", 300));
const week = new Date();
week.setDate(week.getDate() - 6);
$("from").value = kept("from", dayOf(week));
$("to").value = kept("to", dayOf(new Date()));
$("auto").replaceChildren(
  ...[0, 30, 60, 300].map((n) => {
    const o = el(
      "option",
      !n ? W.off : n < 60 ? W.seconds(n) : W.minutes(n / 60),
    );
    o.value = n;
    return o;
  }),
);
$("auto").value = auto;

async function api(path, body) {
  let r, result;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  // Errors are codes the page words itself; see W.err.
  try {
    r = await fetch(new URL(`api/${path}`, location.href), {
      signal: controller.signal,
      method: body === undefined ? "GET" : "POST",
      headers: {
        "X-Amp-Usage-Token": token,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    result = await r.json();
  } catch {
    throw new Error("unreachable");
  } finally {
    clearTimeout(timeout);
  }
  if (!r.ok) throw new Error(result.code || "unexpected");
  return result;
}
function errors(codes) {
  const lines = [...new Set(codes.map((c) => AmpUsage.error(W, c)))];
  $("errors").replaceChildren(...lines.map((m) => el("p", m)));
  $("errors").hidden = !lines.length;
}

// The span the reader asked for, as local hour keys, both ends included.
function span(rows) {
  const now = new Date();
  const day = (back) =>
    new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);
  if (period === "24h")
    return [hourOf(new Date(now.getTime() - 23 * 3600_000)), hourOf(now)];
  if (period === "custom") {
    const [a, b] = [$("from").value, $("to").value].sort();
    return [`${a || dayOf(now)}T00`, `${b || dayOf(now)}T23`];
  }
  const back = { today: 0, "7d": 6, "30d": 29 }[period];
  const first =
    back === undefined
      ? rows.reduce((a, r) => (r.hour < a ? r.hour : a), hourOf(now))
      : hourOf(day(back));
  return [`${first.slice(0, 10)}T00`, hourOf(now)];
}

function board(rows) {
  const [from, to] = span(rows);
  const shown = rows.filter((r) => r.hour >= from && r.hour <= to);
  const all = sum(shown);
  const prompt = all.in + all.cache_read + all.cache_write;
  $("empty").textContent = rows.length ? W.emptyPeriod : W.empty;
  $("empty").hidden = shown.length > 0;
  $("board").hidden = !shown.length;
  if (!shown.length) return;

  $("tiles").replaceChildren(
    ...[
      [W.calls, all.calls],
      [W.input, all.in],
      [W.output, all.out],
      [W.cacheRead, all.cache_read],
      [W.cacheWrite, all.cache_write],
      [W.hit, prompt ? all.cache_read / prompt : null],
    ].map(([label, n], i) => {
      const tile = el("div");
      const value =
        i < 5
          ? number("dd", n)
          : el("dd", n === null ? "–" : `${Math.floor(n * 1000) / 10}%`);
      tile.append(el("dt", label), value);
      return tile;
    }),
  );

  // Hours for a day or two, days beyond that. Every step gets a bar, empty
  // ones included, so gaps read as gaps.
  const hourly = dateOf(to) - dateOf(from) < 48 * 3600_000;
  const keyOf = hourly ? hourOf : dayOf;
  const buckets = new Map();
  for (const r of shown) {
    const key = hourly ? r.hour : r.hour.slice(0, 10);
    const b = buckets.get(key) || { calls: 0, tokens: 0 };
    b.calls += r.calls;
    b.tokens += total(r);
    buckets.set(key, b);
  }
  const series = [];
  const at = dateOf(from);
  const end = dateOf(to);
  while (at <= end) {
    const key = keyOf(at);
    series.push([key, buckets.get(key) || { calls: 0, tokens: 0 }]);
    if (hourly) at.setHours(at.getHours() + 1);
    else at.setDate(at.getDate() + 1);
  }
  const label = (key) =>
    hourly ? `${key.slice(5, 10)} ${key.slice(11)}:00` : key;
  $("chart-title").textContent = hourly ? W.hourly : W.daily;
  $("chart").hidden = series.length < 2;
  const peak = Math.max(...series.map(([, v]) => v.tokens));
  const rest = `${full.format(total(all))} ${W.tokens}`;
  $("readout").textContent = rest;
  $("bars").classList.toggle("dense", series.length > 90);
  $("bars").replaceChildren(
    ...series.map(([key, v]) => {
      const column = el("div", undefined, "bar");
      column.tabIndex = 0;
      const text = `${label(key)} · ${full.format(v.tokens)} ${W.tokens} · ${full.format(v.calls)} ${W.calls}`;
      column.setAttribute("aria-label", text);
      const fill = el("i");
      fill.style.height = `${peak ? (v.tokens / peak) * 100 : 0}%`;
      column.append(fill);
      for (const on of ["pointerenter", "focus"])
        column.addEventListener(on, () => ($("readout").textContent = text));
      for (const off of ["pointerleave", "blur"])
        column.addEventListener(off, () => ($("readout").textContent = rest));
      return column;
    }),
  );
  $("first-tick").textContent = label(series[0][0]);
  $("last-tick").textContent = label(series.at(-1)[0]);

  const models = new Map();
  for (const r of shown)
    models.set(r.model, sum([models.get(r.model) || sum([]), r]));
  $("models").replaceChildren(
    ...[...models]
      .sort((a, b) => total(b[1]) - total(a[1]))
      .map(([model, v]) => {
        const tr = el("tr");
        tr.append(
          el("th", model),
          number("td", v.calls),
          number("td", v.in),
          number("td", v.out),
          number("td", v.cache_read),
          number("td", v.cache_write),
          el("td", share(total(v) / total(all))),
        );
        tr.firstChild.scope = "row";
        return tr;
      }),
  );
}

// The poll repaints every two seconds; rebuilding the board then would drop
// the hover and focus a reader has on a bar.
let painted = "";
function render(s) {
  state = s;
  const working = s.phase !== "idle";
  $("refresh").disabled = working || busy;
  $("refresh").classList.toggle("spin", working || busy);
  for (const b of $("periods").children)
    b.setAttribute("aria-pressed", String(b.dataset.period === period));
  $("range").hidden = period !== "custom";
  const paint = JSON.stringify([
    period,
    $("from").value,
    $("to").value,
    s.lastScan,
    s.usage,
  ]);
  if (paint !== painted) {
    painted = paint;
    $("empty").hidden = true;
    if (s.lastScan) board(s.usage || []);
    else $("board").hidden = true;
  }
  if (!s.lastScan && working) {
    $("empty").textContent = W.reading;
    $("empty").hidden = false;
  }
  $("progress").textContent = [
    s.lastScan &&
      W.scanned(
        new Date(s.lastScan).toLocaleTimeString(locale, {
          hour: "2-digit",
          minute: "2-digit",
        }),
      ),
    s.remaining ? W.remaining(s.remaining) : "",
  ]
    .filter(Boolean)
    .join(" · ");

  const items = Object.entries(groups)
    .map(([k, codes]) => [
      k,
      codes.reduce((n, c) => n + (s.issues?.[c] || 0), 0),
    ])
    .filter(([, n]) => n);
  $("issues").replaceChildren(
    ...items.map(([k, n]) => el("li", `${W[k]}: ${full.format(n)}`)),
  );
  $("issues-summary").textContent = W.issues(
    full.format(items.reduce((n, [, c]) => n + c, 0)),
  );
  $("issues-box").hidden = !items.length;
  errors([failure, ...(s.errors || [])].filter(Boolean));
}

async function act(fn) {
  if (busy) return;
  busy = true;
  turn++;
  failure = "";
  if (state) render(state);
  try {
    const s = await fn();
    busy = false;
    render(s);
  } catch (e) {
    busy = false;
    // Kept until the next action, so a status poll cannot erase it.
    failure = e.message;
    if (state) render(state);
    else errors([failure]);
  }
}
const read = () => api("refresh", {});
$("refresh").onclick = () => act(read);
$("auto").onchange = () => keep("auto", (auto = Number($("auto").value)));
for (const b of $("periods").children)
  b.onclick = () => {
    keep("period", (period = b.dataset.period));
    if (state) render(state);
  };
for (const id of ["from", "to"])
  $(id).onchange = () => {
    keep(id, $(id).value);
    if (state) render(state);
  };

let left = Infinity;
let polling = false;
async function poll() {
  if (polling || busy) return;
  polling = true;
  const mine = turn;
  try {
    const s = await api("status");
    // A reply that raced an action is older than what the action returned.
    if (busy || mine !== turn) return;
    if (failure === "unreachable") failure = "";
    render(s);
    if (s.phase !== "idle") return;
    const age = s.lastScan ? Date.now() - Date.parse(s.lastScan) : Infinity;
    // A first export is bounded per read; keep going while it makes progress.
    const more = s.remaining > 0 && s.remaining < left && !s.errors.length;
    if (more || age === Infinity || (auto && age >= auto * 1000)) {
      left = s.remaining || Infinity;
      void act(read);
    }
  } catch (e) {
    if (!busy && mine === turn) errors([e.message]);
  } finally {
    polling = false;
  }
}
void poll();
setInterval(poll, 2000);
