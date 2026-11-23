// 本文由AI自动生成
// AI_额度节奏盘 —— magpie 插件入口。
//
// 分工：
//   宿主侧（这里）起一个只监听 127.0.0.1 的 HTTP 服务，把额度、路由快照、
//   消耗历史聚合成一份 JSON；插件的页面是「带路页」，把自己导航到这个服务，
//   界面与数据同源，绕开插件沙盒 default-src 'none' 的联网禁令。
//
// 只读声明：本服务只读 gateway.json / providers.json / credits-daily.json /
//   quota-history.json / routing/*.jsonl，以及网关的 GET /v1/magpie/quotas。
//   不读 plugin-auth.json、caller-keys.json、settings.json —— 那里是凭证。

import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { aggregate, reprice } from "./lib/pace.mjs";
import { resolveMagpieBin, runRefresh } from "./lib/refresh.mjs";
import { configDir } from "./lib/paths.mjs";
import { fetchQuotas, readCreditsDaily, readGroups, readQuotaHistory, readSnapshot } from "./lib/source.mjs";
import { readJSON, writeJSON } from "./lib/storage.mjs";
import { projectWindow } from "./lib/waste.mjs";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const DEFAULT_PORT = 3488;
const SNAPSHOT_STALE_MIN = 15;
const QUOTA_STALE_HOURS = 24;

// 页面文档是 magpie 用 sandbox allow-scripts 的框架发的，origin 是 opaque，
// 浏览器发过来的 Origin 就是字面量 "null" —— 所以它取数一定是「跨源」。
// 口令不是为了挡跨源（跨源已经由 CORS 放行了），而是为了挡「本机任何一个
// 沙箱页面都能读这份额度」：只有我们自己发出去的 HTML 里带着它。
const TOKEN_HEADER = "x-pace-token";
let TOKEN = "";
let DATA_DIR = null;

// 自动刷新周期白名单：关闭 / 5s / 10s / 30s / 1m / 5m / 15m / 30m
const AUTO_MS = new Set([0, 5000, 10000, 30000, 60000, 300000, 900000, 1800000]);
const DEFAULT_AUTO_MS = 300000;
let refreshing = null;
let lastRefreshOkAt = 0;

const STATIC = {
  "/": { file: "page/board/index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "page/board/index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "page/board/app.js", type: "text/javascript; charset=utf-8" },
  "/style.css": { file: "page/board/style.css", type: "text/css; charset=utf-8" },
  "/icon.svg": { file: "page/icon.svg", type: "image/svg+xml" },
};

const norm = (s) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, "");

function pickGroup(groups, want) {
  if (!Array.isArray(groups) || !groups.length) return null;
  if (want) {
    const hit = groups.find((g) => g.id === want);
    if (hit) return hit;
  }
  const pace = groups.filter((g) => g.routing === "pace" && !g.hidden);
  if (pace.length) return pace[0];
  return groups.find((g) => g.routing && !g.hidden) || null;
}

/** 把 pace 候选和网关额度账号对上。对不上不算错——不少账号网关压根不上报额度。 */
function buildAccountIndex(accounts) {
  const byProvider = new Map();
  const byExact = new Map();
  for (const a of accounts) {
    const p = norm(a.provider);
    if (!byProvider.has(p)) byProvider.set(p, []);
    byProvider.get(p).push(a);
    byExact.set(`${p}|${norm(a.user)}`, a);
  }
  return { byProvider, byExact };
}

function matchAccount(idx, row) {
  const p = norm(row.provider);
  const exact = idx.byExact.get(`${p}|${norm(row.who)}`);
  if (exact) return exact;
  const same = idx.byProvider.get(p);
  if (same && same.length === 1) return same[0];
  return null;
}

function quotaAgeHours(readAt, now) {
  if (!readAt) return null;
  const t = Date.parse(String(readAt));
  if (!Number.isFinite(t)) return null;
  return (now - t) / 3_600_000;
}

async function buildBoard(wantGroup) {
  const now = Date.now();
  const warnings = [];

  const [groups, quotas, daily, history] = await Promise.all([
    readGroups(),
    fetchQuotas(),
    readCreditsDaily(),
    readQuotaHistory(),
  ]);

  if (!groups) warnings.push({ level: "warn", text: "读不到 providers.json，组配置缺失" });
  if (!quotas.ok) {
    warnings.push({
      level: "error",
      text: `额度网关没响应（${quotas.error}）。排名仍可用，但「还剩多少」这一列会是空的。`,
    });
  }
  if (quotas.gateway?.assumed) {
    warnings.push({
      level: "warn",
      text: `没找到网关地址，按 ${quotas.gateway.base} 猜的。如果 magpie 端口改过，这一栏会一直是空的。`,
    });
  }

  const group = pickGroup(groups, wantGroup);
  let snapshot = { ok: false, error: "没有可用的路由组" };
  if (group) snapshot = await readSnapshot(group.id);

  if (group && !snapshot.ok) {
    warnings.push({
      level: "warn",
      text: `没有「${group.name || group.id}」的路由快照（${snapshot.error}）。这个组最近没有请求经过，排名暂时算不出来。`,
    });
  }

  let snapshotAgeMin = null;
  if (snapshot.ok && snapshot.at) {
    const t = Date.parse(snapshot.at);
    if (Number.isFinite(t)) snapshotAgeMin = (now - t) / 60_000;
  } else if (snapshot.ok) {
    warnings.push({ level: "warn", text: "路由快照没有时间戳，无法判断新鲜度。" });
  }

  const rows = snapshot.ok ? aggregate(snapshot.order, now) : [];
  const accounts = quotas.ok ? quotas.accounts : [];
  const idx = buildAccountIndex(accounts);

  // magpie 真正会先试的那个：order[] 里第一个不在冷却的条目。
  // 注意不能拿 rows[0] —— rows 是按 pace 重排过的展示顺序。
  const nextUpRaw = snapshot.ok ? snapshot.order.find((o) => o && !o.rest) : null;
  const nextUp = nextUpRaw
    ? {
        id: nextUpRaw.id || `${nextUpRaw.provider}/${nextUpRaw.who ?? ""}`,
        provider: nextUpRaw.provider || "",
        name: nextUpRaw.name || nextUpRaw.provider || "",
        who: nextUpRaw.who || "",
        model: nextUpRaw.model || "",
        pace: typeof nextUpRaw.pace === "number" ? nextUpRaw.pace : null,
      }
    : null;

  // 每个候选挂上额度现值
  for (const r of rows) {
    const acc = matchAccount(idx, r);
    r.matched = !!acc;
    r.quota = acc
      ? {
          user: acc.user || "",
          plan: acc.plan || "",
          readAt: acc.readAt || "",
          ageHours: quotaAgeHours(acc.readAt, now),
          windows: (acc.windows || []).map((w) => ({
            name: w.name || "",
            used: w.used ?? null,
            remaining: w.remaining ?? null,
            amount: w.amount ?? null,
            limit: w.limit ?? null,
            unit: w.unit || "",
            display: w.display || "",
            resetsAt: w.resetsAt || null,
            runsOutAt: w.runsOutAt || null,
            runsOut: w.runsOut ?? null,
          })),
        }
      : null;

    // 校验快照有没有过时：只对「同一限流窗口」重算，账号额度包不参与。
    const live = reprice(r, acc, now);
    if (live.status === "repriced") {
      live.delta = live.pace - r.pace;
      live.changed = Math.abs(live.delta) > 1e-6;
    }
    r.live = live;
  }

  // 快照新鲜度：把「决策时间」和「重算结果」分开说。
  // 旧文案「这份排名按当时的额度算」会被读成「排名用了过时额度」；
  // 但 pace 的输入是模型限流窗口，不是账号额度包——没有窗口的候选，
  // 重算一万次也还是 100/168，这种行必须明说是兜底值，不是陈旧值。
  if (snapshotAgeMin != null && snapshotAgeMin > SNAPSHOT_STALE_MIN) {
    const repriced = rows.filter((r) => r.live?.status === "repriced");
    const changed = repriced.filter((r) => r.live.changed);
    const noWindow = rows.filter((r) => r.live?.status === "no-window");
    const notes = [];
    if (changed.length) {
      notes.push(`${changed.length} 个候选的限流窗口读数已变，行内标了重算值`);
    } else if (repriced.length) {
      notes.push(`${repriced.length} 个候选已按最新读数重算，分数没变`);
    }
    if (noWindow.length) {
      notes.push(`${noWindow.length} 个候选没有到期窗口，走 168h 兜底，重算也不会变`);
    }
    warnings.push({
      level: "warn",
      text: `magpie 最近一次真实决策在 ${Math.round(snapshotAgeMin)} 分钟前；此后没有请求经过，队列顺序不会自己更新。${
        notes.length ? `${notes.join("；")}。` : ""
      }`,
    });
  }

  // 到期账：每个账号 × 每个窗口
  const wasteRows = [];
  for (const acc of accounts) {
    const accKey = `${acc.provider}|${acc.user ?? ""}`;
    for (const w of acc.windows || []) {
      const dailyKey = `${acc.provider}|${acc.user ?? ""}|${w.name ?? ""}`;
      const histKey = accKey;
      const hist = history && history[histKey] ? history[histKey][w.name ?? ""] : null;
      const proj = projectWindow(w, daily && daily[dailyKey], hist, now);
      if (proj.due == null && proj.officialWaste == null) continue; // 不会过期也没官方口径：不进预警区
      wasteRows.push({
        provider: acc.provider,
        providerName: acc.name || acc.provider,
        user: acc.user || "",
        plan: acc.plan || "",
        readAt: acc.readAt || "",
        ageHours: quotaAgeHours(acc.readAt, now),
        ...proj,
      });
    }
  }
  wasteRows.sort((a, b) => {
    const rank = (x) => (x.verdict === "waste" ? 0 : x.verdict === "burnable" ? 1 : 2);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    const wa = a.waste ?? -1;
    const wb = b.waste ?? -1;
    if (Math.abs(wb - wa) > 1e-9) return wb - wa;
    return (a.daysLeft ?? 9e9) - (b.daysLeft ?? 9e9);
  });

  // 同一账号里，"Total credits" 这类汇总窗口和它的子窗口会报出同一个失效量。
  // 不去重的话，把这些数加起来会凭空多出一倍。
  const seenLapse = new Map();
  const deduped = [];
  for (const w of wasteRows) {
    const isOfficial = w.wasteSource === "official" && (w.officialWaste ?? 0) > 0;
    if (isOfficial) {
      const k = `${w.provider}|${w.user}|${w.officialWaste.toFixed(4)}`;
      const prevIdx = seenLapse.get(k);
      if (prevIdx != null) {
        const prev = deduped[prevIdx];
        // 保留更具体的那个（名字里没有 total 的子窗口）
        if (/total/i.test(prev.name) && !/total/i.test(w.name)) {
          deduped[prevIdx] = { ...w, mergedNote: `含汇总项「${prev.name}」，已合并` };
          seenLapse.set(k, prevIdx);
        } else {
          prev.mergedNote = prev.mergedNote || `含汇总项「${w.name}」，已合并`;
        }
        continue;
      }
      seenLapse.set(k, deduped.length);
    }
    deduped.push(w);
  }

  const staleAccounts = accounts.filter((a) => {
    const h = quotaAgeHours(a.readAt, now);
    return h != null && h > QUOTA_STALE_HOURS;
  });
  if (staleAccounts.length) {
    warnings.push({
      level: "warn",
      text: `${staleAccounts.length} 个账号的额度读数超过 ${QUOTA_STALE_HOURS} 小时没更新（${staleAccounts
        .slice(0, 3)
        .map((a) => `${a.provider}/${a.user || "默认"}`)
        .join("、")}${staleAccounts.length > 3 ? " 等" : ""}）。这些行会标「陈旧」。`,
    });
  }

  const ages = accounts.map((a) => quotaAgeHours(a.readAt, now)).filter((h) => h != null);

  return {
    generatedAt: new Date(now).toISOString(),
    group: group
      ? {
          id: group.id,
          name: group.name || group.id,
          routing: group.routing || "",
          members: group.members,
          off: group.off,
          accounts: group.accounts,
        }
      : null,
    gateway: quotas.gateway
      ? { base: quotas.gateway.base, source: quotas.gateway.source, assumed: quotas.gateway.assumed, ok: quotas.ok, error: quotas.error || "" }
      : null,
    snapshot: snapshot.ok
      ? { at: snapshot.at, ageMin: snapshotAgeMin, model: snapshot.model, agent: snapshot.agent, file: snapshot.file, entries: snapshot.order.length }
      : { at: null, ageMin: null, error: snapshot.error || "" },
    fresh: {
      quotaNewestHours: ages.length ? Math.min(...ages) : null,
      quotaOldestHours: ages.length ? Math.max(...ages) : null,
      accountCount: accounts.length,
    },
    rows,
    nextUp,
    waste: deduped,
    accounts: accounts.map((a) => ({
      provider: a.provider,
      providerName: a.name || a.provider,
      user: a.user || "",
      kind: a.kind || "",
      plan: a.plan || "",
      readAt: a.readAt || "",
      ageHours: quotaAgeHours(a.readAt, now),
      windows: (a.windows || []).map((w) => ({
        name: w.name || "",
        used: w.used ?? null,
        remaining: w.remaining ?? null,
        amount: w.amount ?? null,
        limit: w.limit ?? null,
        unit: w.unit || "",
        display: w.display || "",
        resetsAt: w.resetsAt || null,
        runsOutAt: w.runsOutAt || null,
        runsOut: w.runsOut ?? null,
      })),
    })),
    warnings,
  };
}

/* ── 传输层 ───────────────────────────────────────────────
 * 两条独立的门：
 *   1) Host 必须是本机回环（挡 DNS rebinding：别的域名解析到 127.0.0.1 时过不去）
 *   2) Origin 只能是缺省（顶层导航/curl）、"null"（沙箱页面）、或本端口自己
 * 再叠一道口令（见 TOKEN 注释）。所有响应都带 CORS 头 —— 失败时也得带，
 * 否则浏览器只会抛一句 "Load failed"，真实状态码谁也看不见。
 */

function hostAllowed(req, port) {
  const host = String(req.headers.host || "").toLowerCase();
  return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`;
}

function originAllowed(req, port) {
  const o = req.headers.origin;
  if (o === undefined) return true;
  if (o === "null") return true;
  const own = new Set([
    `http://127.0.0.1:${port}`,
    `https://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `https://localhost:${port}`,
  ]);
  return own.has(String(o).toLowerCase());
}

function corsHeaders(req, port) {
  const o = String(req.headers.origin ?? "");
  const allow = o === "null" ? "null" : o && originAllowed(req, port) ? o : "null";
  return {
    "access-control-allow-origin": allow,
    "access-control-allow-headers": `content-type, ${TOKEN_HEADER}`,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-max-age": "600",
    vary: "Origin",
  };
}

function tokenOK(req) {
  const got = Buffer.from(String(req.headers[TOKEN_HEADER] || ""));
  const want = Buffer.from(TOKEN);
  return got.length === want.length && timingSafeEqual(got, want);
}

function send(req, res, port, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...corsHeaders(req, port),
  });
  res.end(body);
}

// 页面里的口令只在服务端注入：静态 js/css 原样发，别把口令写进文件。
function injectToken(html) {
  return html.replace(/<meta name="pace-token" content="[^"]*"\s*\/?>/i, `<meta name="pace-token" content="${TOKEN}">`);
}

// 口令跨宿主重启复用。否则每次插件宿主重启都会让已打开的页面拿到 401。
async function serviceToken(dir) {
  const path = join(dir, "service-token.json");
  const kept = await readJSON(path, null);
  if (kept && /^[a-f0-9]{64}$/.test(kept.token)) return kept.token;
  const token = randomBytes(32).toString("hex");
  await writeJSON(path, { token });
  return token;
}

function normalizeAuto(value) {
  const n = Number(value);
  return AUTO_MS.has(n) ? n : DEFAULT_AUTO_MS;
}

async function readPrefs() {
  const p = await readJSON(join(DATA_DIR, "prefs.json"), null);
  return { version: 1, autoRefreshMs: normalizeAuto(p?.autoRefreshMs ?? DEFAULT_AUTO_MS) };
}

async function writePrefs(autoRefreshMs) {
  const value = { version: 1, autoRefreshMs: normalizeAuto(autoRefreshMs) };
  await writeJSON(join(DATA_DIR, "prefs.json"), value);
  return value;
}

async function readBody(req, limit = 4096) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("请求体过大");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// 真正刷新一次。刷新只是「让 magpie 重新问厂商」，展示数据仍走原来的只读聚合。
async function doRefresh(group) {
  const quotas = await fetchQuotas();
  const accounts = quotas.ok && Array.isArray(quotas.accounts) ? quotas.accounts : [];
  const bin = await resolveMagpieBin();
  if (!bin) {
    return {
      status: "unavailable",
      note: "找不到 magpie 命令，自动刷新不可用；面板数据仍可正常查看",
      board: await buildBoard(group),
    };
  }
  if (!accounts.length) {
    return { status: "unavailable", note: "网关没有上报可刷新的账号", board: await buildBoard(group) };
  }
  if (Date.now() - lastRefreshOkAt < 30_000) {
    return {
      status: "skipped",
      note: "magpie 30 秒内不会重复查询同一张卡，已跳过",
      board: await buildBoard(group),
    };
  }
  const results = await runRefresh(accounts, bin);
  const ok = results.filter((r) => r.ok).length;
  if (ok) lastRefreshOkAt = Date.now();
  const board = await buildBoard(group);
  const failed = results.length - ok;
  return {
    status: "ok",
    note: `已向厂商重读 ${ok} 个账号${failed ? `，${failed} 个失败` : ""}`,
    results,
    board,
  };
}

async function startServer(port) {
  const server = createServer(async (req, res) => {
    const t0 = Date.now();
    const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
    const done = (status) =>
      console.log(
        `[pace-board] ${req.method} ${url.pathname} host=${req.headers.host || "-"} origin=${
          req.headers.origin ?? "-"
        } → ${status} ${Date.now() - t0}ms`,
      );

    if (!hostAllowed(req, port) || !originAllowed(req, port)) {
      send(req, res, port, 403, JSON.stringify({ error: "只接受本机回环、且来自本插件页面或同源的请求" }));
      done(403);
      return;
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204, { "cache-control": "no-store", ...corsHeaders(req, port) });
      res.end();
      done(204);
      return;
    }

    if (url.pathname === "/api/board") {
      if (!tokenOK(req)) {
        send(req, res, port, 401, JSON.stringify({ error: "缺口令：请从这个插件的页面里打开，别直接敲地址" }));
        done(401);
        return;
      }
      try {
        const group = url.searchParams.get("group") || "";
        const data = await buildBoard(group);
        send(req, res, port, 200, JSON.stringify(data));
        done(200);
      } catch (err) {
        send(req, res, port, 500, JSON.stringify({ error: String(err?.stack || err?.message || err) }));
        done(500);
      }
      return;
    }

    if (url.pathname === "/api/prefs") {
      if (!tokenOK(req)) {
        send(req, res, port, 401, JSON.stringify({ error: "缺口令" }));
        done(401);
        return;
      }
      try {
        if (req.method === "POST") {
          if (!/application\/json/i.test(String(req.headers["content-type"] || ""))) {
            send(req, res, port, 415, JSON.stringify({ error: "需要 application/json" }));
            done(415);
            return;
          }
          const body = await readBody(req);
          let value;
          try {
            value = JSON.parse(body || "{}");
          } catch {
            value = {};
          }
          const prefs = await writePrefs(value?.autoRefreshMs);
          send(req, res, port, 200, JSON.stringify(prefs));
          done(200);
          return;
        }
        const prefs = await readPrefs();
        send(req, res, port, 200, JSON.stringify(prefs));
        done(200);
      } catch (err) {
        send(req, res, port, 500, JSON.stringify({ error: String(err?.message || err) }));
        done(500);
      }
      return;
    }

    if (url.pathname === "/api/refresh") {
      if (!tokenOK(req)) {
        send(req, res, port, 401, JSON.stringify({ error: "缺口令" }));
        done(401);
        return;
      }
      if (req.method !== "POST") {
        send(req, res, port, 405, JSON.stringify({ error: "需要 POST" }));
        done(405);
        return;
      }
      try {
        if (refreshing) {
          send(req, res, port, 200, JSON.stringify({ status: "in_progress", note: "正在重读额度" }));
          done(200);
          return;
        }
        const group = url.searchParams.get("group") || "";
        refreshing = doRefresh(group);
        const result = await refreshing;
        send(req, res, port, 200, JSON.stringify(result));
        done(200);
      } catch (err) {
        send(req, res, port, 500, JSON.stringify({ error: String(err?.message || err) }));
        done(500);
      } finally {
        refreshing = null;
      }
      return;
    }

    const hit = STATIC[url.pathname];
    if (!hit) {
      send(req, res, port, 404, "not found", "text/plain; charset=utf-8");
      done(404);
      return;
    }
    try {
      let body = await readFile(join(ROOT, hit.file));
      if (hit.type.startsWith("text/html")) body = injectToken(body.toString("utf8"));
      res.writeHead(200, {
        "content-type": hit.type,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        ...corsHeaders(req, port),
      });
      res.end(body);
      done(200);
    } catch {
      send(req, res, port, 500, `missing ${hit.file}`, "text/plain; charset=utf-8");
      done(500);
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve({ server, port });
    });
  });
}

// 端口被上一个宿主占着时不要静默换端口：包里的 page.service 声明的是这个端口，
// 换了页面就跳不过来。改成等着它松手。
let booted = null;
function boot(port, dataDir) {
  DATA_DIR = dataDir;
  if (!booted) {
    booted = (async () => {
      TOKEN = await serviceToken(DATA_DIR);
      for (let i = 0; i < 20; i++) {
        try {
          const { port: p } = await startServer(port);
          console.log(`[pace-board] listening on http://127.0.0.1:${p}`);
          return p;
        } catch (err) {
          if (err?.code !== "EADDRINUSE") throw err;
          await new Promise((r) => setTimeout(r, 1500));
        }
      }
      throw new Error(`端口 ${port} 一直被占用`);
    })().catch((err) => {
      console.error("[pace-board] 启动失败:", err?.message || err);
      return null;
    });
  }
  return booted;
}

export default {
  id: "magpie-pace-board",
  server: async (input, options) => {
    const p = Number(options?.port);
    const port = Number.isFinite(p) && p > 0 && p < 65536 ? p : DEFAULT_PORT;
    const override = process.env.MAGPIE_PACE_BOARD_DATA_DIR;
    const dataDir = override || join(input?.directory || configDir(), "pace-board");
    boot(port, dataDir);
    return {};
  },
};
