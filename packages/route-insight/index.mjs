import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { UsageStore } from "./lib/store.mjs";
import { deriveEfforts, facets, filterRows, sinceFor, summarize, WINDOW_KEYS } from "./lib/stats.mjs";
import { readQuotas, readRests } from "./lib/live.mjs";
import { modeOf, readBilling, readProviders } from "./lib/billing.mjs";
import { RoutingIndex } from "./lib/routing.mjs";
import { runTests, TESTS, ANIM_PROMPT, familyOf, fetchCatalog } from "./lib/lab.mjs";
import { RUN_REQUEST_LIMIT } from "./lib/gateway.mjs";
import { fingerprinterStatus, downloadReferenceData } from "./lib/numeric.mjs";
import { configDir, configFile } from "./lib/store.mjs";
import { providerCards, providerMeta } from "./lib/providers.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI = path.join(HERE, "ui");
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8"
};
const ICON_TYPES = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg"
};

// ---- 检测历史：一张一张小记录，存在 magpie 配置目录里，重启插件也在 ----
const LAB_HISTORY = "route-insight-lab-history.json";
function readLabHistory() {
  try {
    const doc = JSON.parse(fs.readFileSync(configFile(LAB_HISTORY), "utf8"));
    return Array.isArray(doc) ? doc : [];
  } catch {
    return [];
  }
}
// 一天最多在检测上花多少积分。不是防谁，是防手滑：连点几次「开始检测」就能把额度刷没，
// 而那些积分是用户自己的钱。
const LAB_DAILY_CREDITS = 200;
function labSpentToday() {
  const day = new Date().toISOString().slice(0, 10);
  return readLabHistory().reduce(function (sum, item) {
    if (!item || typeof item.at !== "string" || item.at.slice(0, 10) !== day) return sum;
    const credits = item.cost ? Number(item.cost.credits) : 0;
    return sum + (Number.isFinite(credits) ? credits : 0);
  }, 0);
}
function recordLabHistory(entry) {
  const list = readLabHistory();
  list.unshift(entry);
  try {
    fs.writeFileSync(configFile(LAB_HISTORY), JSON.stringify(list.slice(0, 40), null, 1));
  } catch {
    // 写不进去不影响这次检测
  }
}

// 最近几次检测的完整结果（含 SVG），这样重开窗口还能看到上次那张卡
const LAB_RESULTS = "route-insight-lab-results.json";
function readLabResults() {
  try {
    const doc = JSON.parse(fs.readFileSync(configFile(LAB_RESULTS), "utf8"));
    return Array.isArray(doc) ? doc : [];
  } catch {
    return [];
  }
}
function recordLabResult(entry) {
  const list = readLabResults().filter((item) => item && item.at !== entry.at);
  list.unshift(entry);
  try {
    fs.writeFileSync(configFile(LAB_RESULTS), JSON.stringify(list.slice(0, 6)));
  } catch {
    // 同上，不阻断
  }
}

// ui/ 里任何文件一改，构建号就变：页面对着它轮询，变了就自己刷新。
// 起因是改完样式后插件窗口里还是旧页面，容易以为是没生效。
function uiBuild() {
  let stamp = "";
  (function walk(dir) {
    let items = [];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) {
        walk(full);
        continue;
      }
      try {
        const info = fs.statSync(full);
        stamp += item.name + ":" + info.size + ":" + Math.round(info.mtimeMs) + ";";
      } catch {
        // 文件刚好被删，跳过
      }
    }
  })(UI);
  let version = "";
  try {
    version = String(JSON.parse(fs.readFileSync(path.join(HERE, "package.json"), "utf8")).version || "");
  } catch {
    // 没有 package.json 就只显示构建号
  }
  return { id: crypto.createHash("sha1").update(stamp).digest("hex").slice(0, 10), version };
}

// frame-ancestors 故意留空：magpie 把插件页面放在它自己的页面里，禁掉祖先会让界面显示不出来。
// frame-src 'self'：只为了「HTML 动画」那张卡 —— 模型交的整份文档要放进 iframe 才能跑 CSS 动画。
// 那个页面自己有更窄的 CSP（只放开内联样式，脚本和外部资源早就剥掉了），见 ART_CSP。
const CSP =
  "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'";

// 「HTML 动画」的产物：一份文档一个文件，前端用 iframe 打开。
const ART_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'";
const ART_KEEP = 60;
function artDir() {
  return path.join(configDir(), "route-insight-art");
}
function saveArtifact(html) {
  const text = String(html || "");
  const id = crypto.createHash("sha1").update(text).digest("hex").slice(0, 16);
  const dir = artDir();
  const file = path.join(dir, id + ".html");
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, text, "utf8");
    const items = fs
      .readdirSync(dir)
      .filter(function (name) {
        return name.endsWith(".html");
      })
      .map(function (name) {
        let mtime = 0;
        try {
          mtime = fs.statSync(path.join(dir, name)).mtimeMs;
        } catch {
          // 刚被删掉的文件忽略
        }
        return { name, mtime };
      })
      .sort(function (a, b) {
        return b.mtime - a.mtime;
      });
    items.slice(ART_KEEP).forEach(function (item) {
      try {
        fs.unlinkSync(path.join(dir, item.name));
      } catch {
        // 删不掉就算了
      }
    });
  } catch {
    // 存不下来时返回 null，界面会退化成「没有 HTML」
    return "";
  }
  return id;
}

function json(res, status, value) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(value));
}

function numberFrom(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function pick(name, fallback) {
  return process.env["MAGPIE_ROUTE_INSIGHT_" + name] || fallback;
}

function buildService(options) {
  // 这个服务只让「自己打开的页面」调：HTML 里带着它，别的来源拿不到。见 start() 里的说明。
  const SERVICE_TOKEN = String((options && options.serviceToken) || "");
  const bytes = numberFrom(options && options.historyBytes, 24 * 1024 * 1024, 1024 * 1024, 256 * 1024 * 1024);
  const keep = numberFrom(options && options.keepRows, 60000, 1000, 400000);
  const store = new UsageStore({ bytes, keep });
  const routing = new RoutingIndex({ bytes: 8 * 1024 * 1024 });
  const defaultWindow = WINDOW_KEYS.includes(String(options && options.window)) ? String(options.window) : "today";
  let billingCache = { at: 0, value: null };

  // quotas.json 由网关自己刷新，看板每 3 秒看一眼就够。
  function billing(now) {
    if (!billingCache.value || now - billingCache.at > 3000) {
      billingCache = { at: now, value: readBilling(now) };
    }
    return billingCache.value;
  }

  function state(query) {
    const now = Date.now();
    const window = WINDOW_KEYS.includes(query.window) ? query.window : defaultWindow;
    const since = sinceFor(window, now);
    store.refresh();
    const head = billing(now);
    const scoped = routing.decorate(filterRows(store.rows, { since, until: now }), now);
    // 强度：网关记了 effort 就用它；没记就按思考 token 的窗口分位派生一个可筛选、可分组的标签。
    const derivedEffort = deriveEfforts(scoped);
    for (const row of scoped) {
      row.effortShow = row.effort || derivedEffort(Number(row.re || row.reasoning) || 0);
    }
    const filtered = filterRows(scoped, {
      since,
      until: now,
      provider: query.provider || "",
      model: query.model || "",
      agent: query.agent || "",
      effort: query.effort || "",
      status: query.status || "",
      text: query.q || ""
    }).map((row) => Object.assign(row, { mode: modeOf(head, row.provider) }));
    const limit = numberFrom(query.limit, 300, 20, 2000);
    const names = {};
    for (const [id, item] of readProviders()) names[id] = item.name;
    return {
      ok: true,
      at: new Date(now).toISOString(),
      window,
      defaultWindow,
      options: { window: defaultWindow, historyBytes: bytes, keepRows: keep },
      source: {
        file: "usage.jsonl",
        rows: store.rows.length,
        scannedAt: store.readAt ? new Date(store.readAt).toISOString() : "",
        skipped: store.skipped,
        routing: { file: path.basename(routing.file || ""), loadedAt: routing.loadedAt ? new Date(routing.loadedAt).toISOString() : "" }
      },
      names,
      ...summarize(filtered, { since, until: now, window, limit }),
      facets: facets(scoped),
      billing: head,
      live: { quotas: readQuotas(), rests: readRests(now) }
    };
  }

  // 智商检测可选的模型：最近的真实组合（provider/model），外加网关里的分组 id。
  // catalog 是 /v1/models 的清单，用来补「这个型号支持哪些推理强度」。
  function labModels(catalog) {
    store.refresh();
    const rows = store.rows;
    const direct = new Map();
    const groups = new Map();
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const row = rows[i];
      const model = row.served || row.model;
      if (row.provider && model) {
        const key = row.provider + "/" + model;
        const item = direct.get(key) || { value: key, kind: "provider", provider: row.provider, model, n: 0, last: 0 };
        item.n += 1;
        if (row.e > item.last) item.last = row.e;
        direct.set(key, item);
      }
      const req = String(row.req || "");
      if (req.indexOf("group/") === 0) {
        const item = groups.get(req) || { value: req, kind: "group", provider: "分组", model: req.slice(6), n: 0, last: 0 };
        item.n += 1;
        if (row.e > item.last) item.last = row.e;
        groups.set(req, item);
      }
    }
    const order = (a, b) => b.last - a.last;
    const pick = [...direct.values()].sort(order).slice(0, 40).concat([...groups.values()].sort(order).slice(0, 12));
    const meta = providerMeta();
    const byValue = new Map();
    const byName = new Map();
    (catalog || []).forEach((one) => {
      byValue.set(one.id, one);
      const key = String(one.model || "").toLowerCase();
      if (key && !byName.has(key)) byName.set(key, one);
    });
    return pick
      .map((item) => {
        const family = familyOf(item.model);
        const info = item.kind === "provider" ? meta.get(item.provider) : null;
        const hit = byValue.get(item.value) || byName.get(String(item.model || "").toLowerCase()) || null;
        return Object.assign({}, item, {
          family: family ? family.name : "",
          providerName: info ? info.name : item.provider,
          icon: info && info.icon ? "/icons/" + info.icon : "",
          levels: hit ? hit.levels || [] : [],
          reasoning: hit ? !!hit.reasoning : false
        });
      })
      .sort(order);
  }

  function labLimits() {
    return { requestsPerRun: RUN_REQUEST_LIMIT, creditsPerDay: LAB_DAILY_CREDITS, creditsToday: Math.round(labSpentToday() * 10) / 10 };
  }

  // 这次检测到底花了什么：检测也是真的请求网关，所以从 usage.jsonl 里把这段时间的行捞出来，
  // 按计费方式分开说（有的分组走积分，有的走额度/余额，不是一律扣积分）。
  function labCost(startedAt, model) {
    store.refresh();
    const from = startedAt - 2000;
    const to = Date.now() + 2000;
    const hit = store.rows.filter((row) => {
      if (row.e < from || row.e > to) return false;
      const served = row.served || row.model || "";
      if (row.req && row.req === model) return true;
      if (served === model) return true;
      if (model.indexOf("/") > 0 && row.provider + "/" + served === model) return true;
      return false;
    });
    const modes = {};
    let credits = 0;
    let ok = 0;
    for (const row of hit) {
      modes[row.mode || "credit"] = (modes[row.mode || "credit"] || 0) + 1;
      credits += Number(row.credits) || 0;
      if (row.status === 200) ok += 1;
    }
    return { requests: hit.length, ok, fail: hit.length - ok, credits, modes };
  }

  // 谁在什么时候请求过这个页面：插件宿主/网页窗口连不上时，靠它判断请求到底有没有到。
  // 默认不写：只有设了 ROUTE_INSIGHT_ACCESS_LOG=1 才落盘（README「会写哪些文件」里有说明）。
  const accessLog = path.join(configDir(), "route-insight-access.log");
  const ACCESS_LOG_ON = String(process.env.ROUTE_INSIGHT_ACCESS_LOG || "") === "1";
  function note(req) {
    if (!ACCESS_LOG_ON) return;
    const url = String(req.url || "/");
    if (url.startsWith("/api/state")) return;
    try {
      if (fs.statSync(accessLog).size > 1024 * 1024) fs.renameSync(accessLog, accessLog + ".1");
    } catch {
      // 还没有日志文件，直接建。
    }
    const line = [
      new Date().toISOString(),
      req.method,
      String(req.headers.host || "-"),
      url,
      String(req.headers["user-agent"] || "-").slice(0, 120)
    ].join("\t");
    try {
      fs.appendFileSync(accessLog, line + "\n");
    } catch {
      // 写不进日志不影响页面。
    }
  }

  function serveStatic(req, res, rel) {
    const clean = rel.replace(/^\/+/, "") || "index.html";
    const file = path.join(UI, clean);
    if (!file.startsWith(UI)) return json(res, 403, { error: "forbidden" });
    let body;
    try {
      body = fs.readFileSync(file);
    } catch {
      return json(res, 404, { error: "not found" });
    }
    const isHtml = path.extname(file) === ".html";
    // 令牌只出现在「打开这个页面」的那一次导航里：别的网页 fetch 这份 HTML 拿不到它，
    // 也就没法用你的浏览器替它跑检测、读走用量。
    const mode = req.headers["sec-fetch-mode"];
    if (isHtml && mode && mode !== "navigate") return json(res, 403, { error: "navigation only" });
    if (isHtml) body = String(body).replace(/__SERVICE_TOKEN__/g, SERVICE_TOKEN);
    res.writeHead(200, {
      "content-type": TYPES[path.extname(file)] || "application/octet-stream",
      "cache-control": "no-store",
      "content-security-policy": CSP
    });
    res.end(body);
  }

  return { store, state, serveStatic, defaultWindow, note, labModels, labCost, labLimits, serveIcon, serveArtifact };

  // 检测产物：只认 16 位十六进制 id，读不到就当没有。
  function serveArtifact(res, rawId) {
    const id = String(rawId || "").replace(/\.html?$/i, "");
    if (!/^[a-f0-9]{8,32}$/i.test(id)) return json(res, 400, { error: "bad id" });
    let body;
    try {
      body = fs.readFileSync(path.join(artDir(), id.toLowerCase() + ".html"));
    } catch {
      return json(res, 404, { error: "not found" });
    }
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": ART_CSP
    });
    res.end(fitArtifact(Buffer.isBuffer(body) ? body.toString("utf8") : String(body)));
  }

  // 产物一律按「一个视口」显示：去掉滚动条，画面按比例缩到刚好放得下。
  // 不这么做的话，模型写的 body{display:grid;place-items:center} + svg 固定宽高会在小 iframe 里溢出，
  // 看着就是「显示不完全」。
  function fitArtifact(html) {
    const FIT =
      "<style data-route-insight-fit>" +
      "html,body{margin:0!important;padding:0!important;height:100%!important;overflow:hidden!important;background:#fff!important}" +
      "body{display:flex!important;align-items:center!important;justify-content:center!important}" +
      "svg,img,video,canvas{max-width:100%!important;max-height:100%!important;width:auto!important;height:auto!important;display:block!important}" +
      "</style>";
    if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, FIT + "</head>");
    if (/<body[^>]*>/i.test(html)) return html.replace(/<body[^>]*>/i, (tag) => tag + FIT);
    return FIT + html;
  }

  // magpie 自己的供应商头像（~/.config/magpie/icons），插件直接拿来用，省得自己画。
  function serveIcon(res, name) {
    const clean = String(name || "").replace(/^\/+/, "");
    if (!/^[a-f0-9]{6,64}\.(svg|png|webp|jpe?g)$/i.test(clean)) return json(res, 400, { error: "bad icon" });
    let body;
    try {
      body = fs.readFileSync(path.join(configDir(), "icons", clean));
    } catch {
      return json(res, 404, { error: "not found" });
    }
    res.writeHead(200, {
      "content-type": ICON_TYPES[path.extname(clean).toLowerCase()] || "application/octet-stream",
      "cache-control": "public, max-age=3600"
    });
    res.end(body);
  }
}

// 服务只在宿主调 server() 时才起（同 magpie-community 的 page-chat / page-usage-board）：
// 单纯 import 这个模块不能占端口、不能写配置，社区市场的 scripts/check.mjs 会直接 import 做静态检查。
let starting = null;

function start(options = {}) {
  const port = numberFrom(options.port, 4397, 1024, 65535);
  const host = "127.0.0.1";
  // 每次启动换一把 32 字节的随机令牌（照 magpie-community 的 amp-usage / page-model-quota 的做法）：
  //   · 打开页面时由服务端把它塞进 <meta name="service-token">，页面之后每个 /api 请求都带回来；
  //   · 只认导航请求，别的网页 fetch 这份 HTML 拿不到令牌；
  //   · 令牌对不上就 403，界面提示「重新打开页面」。
  // 这样本机别的网页/程序不能借你的浏览器去跑检测（花钱、打满额度），也读不到你的用量明细。
  const token = crypto.randomBytes(32).toString("hex");
  let labBusy = false;
// 参考库下载的单次信号：并发点「下载参考库」只发一次请求。
let labDataPromise = null;
  function tokenMatches(given) {
    const a = Buffer.from(String(given || ""));
    const b = Buffer.from(token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  const service = buildService(Object.assign({}, options, { serviceToken: token }));

  const server = http.createServer((req, res) => {
      service.note(req);
    const hostHeader = String(req.headers.host || "").toLowerCase();
    const allowed = [host + ":" + port, "localhost:" + port];
    if (!allowed.includes(hostHeader)) return json(res, 403, { error: "bad host" });
    // 浏览器里直接开页面时，页面和它的 /api 同源，不需要任何 CORS 头。
    // 但 magpie 把插件页装在 sandbox="allow-scripts" 的 iframe 里：那份文档的 origin 就是字符串 "null"，
    // 页面里的 fetch('/api/…') 在浏览器看来是跨源请求，没有 ACAO 只会得到 TypeError: Failed to fetch
    // （窗口里「重连中…Failed to fetch」就是这么来的）。
    // 所以只在「Origin: null + 请求带着正确令牌」时回放行头：别的网页拿不到令牌（页面只对导航下发），
    // 令牌不对照样 403、且一个 CORS 头都不回，空白放行那种洞不会回来。
    const origin = String(req.headers.origin || "");
    const sandboxed = origin === "null";
    if (req.method === "OPTIONS") {
      if (sandboxed) {
        res.writeHead(204, {
          "access-control-allow-origin": "null",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "x-route-insight-token, content-type",
          "access-control-max-age": "600",
          vary: "Origin"
        });
      } else {
        res.writeHead(204);
      }
      return res.end();
    }
    const url = new URL(req.url || "/", "http://" + host + ":" + port);
    // 每个 /api 都要那把令牌；检测产物走 iframe（不能加自定义头），所以只对那一条放宽成 ?t=。
    if (url.pathname.startsWith("/api/")) {
      const viaQuery = url.pathname.startsWith("/api/lab/art/") ? url.searchParams.get("t") : "";
      if (!tokenMatches(req.headers["x-route-insight-token"] || viaQuery)) {
        return json(res, 403, { ok: false, code: "reconnect", error: "reopen" });
      }
      // 令牌对了才谈跨源：沙箱 iframe 里必须能看到自己这份响应。
      if (sandboxed) {
        res.setHeader("access-control-allow-origin", "null");
        res.setHeader("vary", "Origin");
      }
    }
    if (url.pathname === "/_route-insight/health") {
      return json(res, 200, { app: "route-insight", protocol: 4, derived: 1 });
    }
    if (url.pathname === "/_route-insight/build") {
      return json(res, 200, uiBuild());
    }
    if (url.pathname.startsWith("/icons/")) {
      return service.serveIcon(res, decodeURIComponent(url.pathname.slice("/icons/".length)));
    }
    if (url.pathname === "/api/providers") {
      try {
        service.store.refresh();
        return json(res, 200, { ok: true, at: new Date().toISOString(), providers: providerCards(service.store.rows) });
      } catch (error) {
        return json(res, 500, { ok: false, error: String((error && error.message) || error) });
      }
    }
    if (url.pathname === "/api/lab/history") {
      const stored = new Set(readLabResults().map((item) => item && item.at).filter(Boolean));
      const items = readLabHistory().map((item) => Object.assign({}, item, { stored: stored.has(item.at) }));
      return json(res, 200, { ok: true, items });
    }
    if (url.pathname === "/api/lab/last") {
      const want = url.searchParams.get("at") || "";
      const items = readLabResults();
      const item = want ? items.find((one) => one && one.at === want) : items[0];
      if (!item) return json(res, 404, { ok: false, error: "no result", items: items.map((one) => ({ at: one.at, model: one.model })) });
      return json(res, 200, { ok: true, item });
    }
    if (url.pathname === "/api/lab/numeric") {
      // 只报状态，不下载：界面看这个决定是显示版本号，还是给一个「下载参考库」按钮。
      // 以前这里顺手就下 3.6MB，等于一进「指纹」页就开始联网取数据。
      fingerprinterStatus().then((status) => {
        json(res, 200, Object.assign({ ok: true }, status));
      });
      return;
    }
    if (url.pathname === "/api/lab/data") {
      // 点了按钮才真去下（固定版本、落地校验哈希，见 lib/numeric.mjs）。并发点只下一次。
      if (req.method !== "POST") return json(res, 405, { ok: false, error: "POST only" });
      if (!labDataPromise) {
        labDataPromise = downloadReferenceData().then(
          () => {
            labDataPromise = null;
          },
          (error) => {
            labDataPromise = null;
            throw error;
          }
        );
      }
      labDataPromise.then(
        () => {
          fingerprinterStatus().then((status) => {
            json(res, 200, Object.assign({ ok: true }, status));
          });
        },
        (error) => {
          json(res, 502, { ok: false, error: "下载参考库失败：" + String((error && error.message) || error) });
        }
      );
      return;
    }
    if (url.pathname === "/api/lab/models") {
      // 参考库（/v1/models）挂掉不能挡住选模型：拿不到就给 null，界面只少强度下拉。
      fetchCatalog()
        .then((cat) =>
          json(res, 200, {
            ok: true,
            tests: TESTS,
            models: service.labModels(cat.list),
            library: cat.meta,
            prompts: { anim: ANIM_PROMPT },
            limits: service.labLimits()
          })
        )
        .catch((error) =>
          json(res, 200, {
            ok: true,
            tests: TESTS,
            models: service.labModels(null),
            library: null,
            libraryError: String((error && error.message) || error),
            prompts: { anim: ANIM_PROMPT },
            limits: service.labLimits()
          })
        );
      return;
    }
    if (url.pathname.startsWith("/api/lab/art/")) {
      return service.serveArtifact(res, decodeURIComponent(url.pathname.slice("/api/lab/art/".length)));
    }
    if (url.pathname === "/api/lab/run") {
      if (req.method !== "POST") return json(res, 405, { ok: false, error: "use POST" });
      // 一次只跑一个检测：并发跑会互相抢额度，成本也记不清。这里先粗筛，校验通过后再真正占位。
      if (labBusy) return json(res, 409, { ok: false, code: "busy", error: "already running" });
      const chunks = [];
      let size = 0;
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size > 64 * 1024) return req.destroy();
        chunks.push(chunk);
      });
      req.on("end", () => {
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        } catch {
          return json(res, 400, { ok: false, error: "bad json" });
        }
        const model = String((body && body.model) || "").trim();
        if (!/^[A-Za-z0-9._/@:-]+$/.test(model) || model.length > 120) {
          return json(res, 400, { ok: false, error: "bad model" });
        }
        // 只认这三项；body 给了但不含任何一项（例如只传 ["numfp"] 而这里漏了它）
        // 会让过滤结果变成空数组，runTests 再把空数组当「没指定」跑全部——所以这里必须齐。
        const tests = Array.isArray(body && body.tests)
          ? body.tests.filter((id) => id === "numfp" || id === "relay" || id === "anim")
          : ["numfp", "relay", "anim"];
        // 每个检测可以单独设推理强度（空 = 那条线的默认档）：指纹一档、画图一档最常用。
        const effort = {};
        if (body && body.effort && typeof body.effort === "object") {
          ["numfp", "relay", "pelican", "anim"].forEach((id) => {
            const value = String(body.effort[id] || "").trim();
            if (/^[a-z]{3,12}$/.test(value)) effort[id] = value;
          });
        }
        // 画图提示词可以自己写：控制字符剔掉，太长就截断（够用了，再长模型也不看）。
        let prompt = "";
        if (body && typeof body.prompt === "string") {
          prompt = body.prompt.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, 2000);
        }
        // 占位：同一个进程里只允许一个检测在跑，跑完（成功/失败）都放回。
        if (labBusy) return json(res, 409, { ok: false, code: "busy", error: "already running" });
        // 成本闸门：今天已经花超了就不开新的，历史里已有的结果照样能看。
        const spent = labSpentToday();
        if (spent >= LAB_DAILY_CREDITS) {
          return json(res, 429, {
            ok: false,
            code: "budget",
            error: "今天检测已经花了 " + spent.toFixed(1) + " 积分，到上限 " + LAB_DAILY_CREDITS + " 了（历史结果还能看）"
          });
        }
        labBusy = true;
        const releaseBusy = () => {
          labBusy = false;
        };
        const startedAt = Date.now();
        fetchCatalog()
          .then((cat) => ({ library: cat.list, libraryMeta: cat.meta }))
          .catch(() => ({ library: null, libraryMeta: null }))
          .then((cat) => runTests(model, tests, { effort, prompt, library: cat.library, libraryMeta: cat.libraryMeta }))
          .then((result) => {
            const cost = service.labCost(startedAt, model);
            const relay = result.results && result.results.relay;
            const family = result.results && result.results.family; // 老记录还能重开
            const pelican = result.results && result.results.pelican;
            const anim = result.results && result.results.anim;
            const numfp = result.results && result.results.numfp;
            // HTML 太大不进 JSON / 结果缓存：存成文件，只回一个 id，前端用 iframe 打开。
            if (anim && anim.html) {
              anim.htmlId = saveArtifact(anim.html);
              anim.htmlBytes = anim.html.length;
              delete anim.html;
            }
            const top = family && family.ranking && family.ranking[0];
            const at = new Date().toISOString();
            recordLabResult({ at, model, cost, results: result.results || {} });
            recordLabHistory({
              at,
              model,
              served:
                (family && family.served) || (relay && relay.model) || (pelican && pelican.served) || (anim && anim.served) || (numfp && numfp.model) || model,
              tests: Object.keys(result.results || {}),
              relay: relay ? { ok: !!relay.ok, score: relay.score, verdict: relay.verdict, label: relay.verdictLabel } : null,
              family: family
                ? { top: (top && top.name) || "", prob: (top && top.prob) || 0, verdict: family.verdict || "", route: family.family || "" }
                : null,
              pelican: pelican ? { ok: !!pelican.svg, bytes: (pelican.features && pelican.features.bytes) || 0, ms: pelican.ms } : null,
              numfp: numfp
                ? { ok: !!numfp.ok, top: numfp.predictionName || "", prob: numfp.probability, decision: numfp.decision || "" }
                : null,
              // ok 只看「整份文档 + 有画面」，不能看 htmlId：截断的文档也会存成文件。
              anim: anim
                ? {
                    ok: !!anim.ok,
                    cut: anim.cut || "",
                    bytes: (anim.features && anim.features.bytes) || 0,
                    elements: (anim.features && anim.features.elements) || 0,
                    animations: (anim.features && anim.features.animations) || 0,
                    ms: anim.ms
                  }
                : null,
              ms: Math.max(
                (relay && relay.ms) || 0,
                (family && family.ms) || 0,
                (pelican && pelican.ms) || 0,
                (anim && anim.ms) || 0,
                (numfp && numfp.ms) || 0
              ),
              cost
            });
            return json(res, 200, Object.assign({ ok: result.ok, cost }, result));
          })
          .catch((error) => json(res, 500, { ok: false, model, error: String((error && error.message) || error) }))
          .then(releaseBusy, releaseBusy);
      });
      return;
    }
    if (url.pathname === "/api/state") {
      const query = Object.fromEntries(url.searchParams.entries());
      try {
        return json(res, 200, service.state(query));
      } catch (error) {
        return json(res, 500, { ok: false, error: String((error && error.message) || error) });
      }
    }
    return service.serveStatic(req, res, url.pathname);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      console.log("route-insight: http://" + host + ":" + port + "  (usage.jsonl 只读)");
      resolve({ port, close: () => server.close() });
    });
  });
}

// start 也导出：bun test 要在同一个进程里起一份临时服务来验证令牌，不用另开 node 子进程
// （子进程在 bun/Mac 上都不一定有 node 可执行文件）。
export { start };

// magpie 会把每个导出的函数当成一个插件调用；用 OpenCode v1 的形式只导出服务器。
export default {
  id: "magpie-route-insight",
  server: async (_input, options) => {
    if (!starting) {
      starting = start(options).catch((error) => {
        console.error("route-insight:", (error && error.message) || error);
        return null;
      });
    }
    await starting;
    return {};
  }
};

if (import.meta.url === "file://" + process.argv[1]) {
  start({ port: pick("PORT", 4397) }).catch((error) => {
    console.error("route-insight:", error && error.message);
    process.exit(1);
  });
}