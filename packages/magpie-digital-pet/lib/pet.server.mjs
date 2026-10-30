// magpie-digital-pet · sidebar page server
//
// The page-chat pattern: magpie's plugin pages run in a sandboxed iframe with
// CSP connect-src 'none' — the only networking they may do is navigating
// themselves. So the sidebar "page" is a guide page (page/index.html + boot.js)
// that jumps to this local HTTP server, which serves the real dashboard and
// a small JSON API over pet.db.
//
// Binds 127.0.0.1 only. Fixed default port (3571) so the guide page can jump
// blindly — several host processes may load the plugin; the first one serves,
// the others see EADDRINUSE and quietly step aside (their watchers still run).

import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { createPetAdapter, nodeById, DIGIMON_DATA } from "./pet.adapter.mjs";
import { createCareStore } from "./pet.care-store.mjs";
import { EXPEDITIONS } from "./pet.care-rules.mjs";
import { DECORATIONS } from "./pet.care-store.mjs";
import { chooseFrame, getSpriteFrames, loadMonsterFrames } from "./pet.frames.mjs";

const HERE = dirname(fileURLToPath(import.meta.url)); // .../lib
const UI_ROOT = join(dirname(HERE), "page");

const DEFAULT_PORT = 3571;

// engine stage thresholds, mirrored for display only (upstream defaults)
const STAGE_THRESHOLDS = [5e6, 1e7, 2e7, 4e7, 75e6, 125e6, 2e8, 3e8];
const STAGE_NAMES = ["egg", "baby I", "baby II", "child", "adult", "perfect", "ultimate", "super ultimate"];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

function fmtTokens(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

function openReadOnly(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  db.run("PRAGMA busy_timeout = 5000");
  return db;
}

function nodeInfo(id) {
  const node = nodeById(id);
  if (!node) return { id, nameEn: id, nameJp: id, stage: 0, sprite: "egg", url: "" };
  return {
    id: node.id,
    nameEn: node.name_en,
    nameJp: node.name_jp,
    stage: node.stage,
    sprite: node.sprite,
    url: node.url,
  };
}

// the whole dashboard in one object
function readState(dbPath) {
  try {
    const db = openReadOnly(dbPath);
    try {
      const trainer = db.query("SELECT total_tokens FROM trainer_state WHERE trainer_id = 1").get();
      const control = db.query("SELECT frozen, cheat_node_id FROM vpet_control_state WHERE control_id = 1").get();
      const partner = db
        .query(
          `SELECT partner_id, generation, current_node_id, gauge, is_terminal,
                  pending_evolution_target_id, battle_opponent_node_id, created_at
           FROM partners
           WHERE partner_id = (SELECT principal_id FROM partner_team WHERE team_id = 1)
             AND retired_at IS NULL LIMIT 1`,
        )
        .get();
      const receipts = db.query("SELECT COUNT(*) c, SUM(token_delta) t, SUM(cost) s FROM usage_receipts").get();
      const events = db
        .query(
          `SELECT kind, current_node_id, gauge, token_delta, created_at
           FROM partner_events ORDER BY created_at DESC, event_id DESC LIMIT 12`,
        )
        .all();
      const partners = db
        .query(
          `SELECT generation, current_node_id, retired_at, created_at
           FROM partners ORDER BY generation ASC`,
        )
        .all();

      const engineNode = partner ? nodeInfo(partner.current_node_id) : null;
      const node = control?.cheat_node_id ? nodeInfo(control.cheat_node_id) : engineNode;
      const threshold = node ? STAGE_THRESHOLDS[node.stage] ?? 0 : 0;
      return {
        ok: true,
        trainerTokens: trainer?.total_tokens ?? 0,
        fedRequests: receipts?.c ?? 0,
        fedTokens: receipts?.t ?? 0,
        fedCost: Number.isFinite(Number(receipts?.s)) ? Number(receipts.s) : 0,
        frozen: control?.frozen === 1,
        pinned: control?.cheat_node_id ?? null,
        partner: partner
          ? {
              id: partner.partner_id,
              generation: partner.generation,
              node,
              engineNode,
              stageName: STAGE_NAMES[node?.stage] ?? "?",
              gauge: partner.gauge,
              threshold,
              pct: threshold > 0 ? Math.min(100, (partner.gauge / threshold) * 100) : 0,
              isTerminal: partner.is_terminal === 1,
              battle: partner.battle_opponent_node_id
                ? nodeInfo(partner.battle_opponent_node_id)
                : null,
              createdAt: partner.created_at,
            }
          : null,
        events: events.map((e) => ({
          kind: e.kind,
          node: nodeInfo(e.current_node_id),
          gauge: e.gauge,
          tokenDelta: e.token_delta,
          createdAt: e.created_at,
        })),
        partners: partners.map((p) => ({
          generation: p.generation,
          node: nodeInfo(p.current_node_id),
          retired: p.retired_at !== null,
          createdAt: p.created_at,
        })),
        fmt: { trainer: fmtTokens(trainer?.total_tokens ?? 0), fed: fmtTokens(receipts?.t ?? 0) },
      };
    } finally {
      db.close();
    }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

const COMMANDS = new Set(["digital-pet-spawn", "digital-pet-freeze", "digital-pet-unfreeze", "digital-pet-set"]);

// page care whitelist: page command -> care action. petEgg additionally
// carries the current stage so the egg-only rule is enforced server-side.
const CARE_COMMANDS = new Map([
  ["pet-feed-snack", "snack"],
  ["pet-play", "play"],
  ["pet-clean", "clean"],
  ["pet-rest", "rest"],
  ["pet-pet-egg", "petEgg"],
]);
const EXPEDITION_KINDS = new Set(Object.keys(EXPEDITIONS));
const DECORATION_IDS = new Set(Object.keys(DECORATIONS));
const API_TOKEN = randomBytes(32).toString("hex");
const TOKEN_HEADER = "x-magpie-pet-token";

// First-frame preference for the dashboard sprite, from the live care state.
// The page can still switch to any of the other frames shipped in `frames`.
function framePreference(careState) {
  if (!careState) return ["walk_1", "walk_2", "happy"];
  if (careState.energy < 25) return ["sleep_1", "sleep_2", "walk_1", "walk_2"];
  if (careState.satiety < 25) return ["angry", "eat_1", "eat_2", "walk_1", "walk_2"];
  if (careState.hygiene < 25) return ["injured_1", "injured_2", "walk_1", "walk_2"];
  if (careState.mood >= 75) return ["happy", "walk_1", "walk_2"];
  return ["walk_1", "walk_2", "happy"];
}

export function createPetServer({ databasePath, dbPath, adapter: sharedAdapter, port = DEFAULT_PORT, notifyGate, retryMs = 30_000 } = {}) {
  const adapter = sharedAdapter ?? createPetAdapter({ databasePath, dbPath, notifyGate });
  const dbFile = adapter.databasePath;
  const careStore = createCareStore({ databasePath: dbFile });
  const frames = loadMonsterFrames();

  // upstream snapshot merged with the care layer; never throws past readState
  function readFullState() {
    const state = readState(dbFile);
    const partnerId = state.ok && state.partner ? state.partner.id : null;
    const nowMs = Date.now();
    let care = null;
    let expedition = null;
    let daily = null;
    if (partnerId) {
      const snapshot = careStore.getCareSnapshot(partnerId, nowMs);
      care = snapshot;
      expedition = snapshot.activeExpedition;
      daily = snapshot.daily;
    }
    let collection = null;
    try {
      collection = careStore.getCollection();
    } catch {
      // store already closed; leave collection null
    }
    let frame = null;
    let allFrames = {};
    const sprite = state.ok && state.partner ? state.partner.node?.sprite : null;
    const spriteFrames = sprite ? getSpriteFrames(frames, sprite) : undefined;
    if (spriteFrames) {
      allFrames = spriteFrames;
      const picked = chooseFrame(frames, sprite, framePreference(care?.state));
      if (picked) frame = { ...picked, available: Object.keys(spriteFrames) };
    }
    const unlockedIds = new Set();
    if (state.ok) {
      for (const p of state.partners || []) if (p.node?.id) unlockedIds.add(p.node.id);
      if (state.partner?.node?.id) unlockedIds.add(state.partner.node.id);
    }
    const dex = DIGIMON_DATA.map((d) => ({
      id: d.id,
      nameEn: d.name_en,
      nameJp: d.name_jp,
      stage: d.stage,
      sprite: d.sprite,
      unlocked: unlockedIds.has(d.id),
      current: state.ok && state.partner?.node?.id === d.id,
    }));
    return { ...state, care, expedition, collection, daily, frame, frames: allFrames, petName: care?.petName ?? null, dex };
  }

  function sendCareResult(res, result, achievements) {
    return send(res, 200, {
      text: result.message ?? "",
      toasts: (achievements ?? result.achievements ?? []).map((id) => ({ title: "成就解锁", message: id })),
      state: readFullState(),
    });
  }

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > 64 * 1024) throw new Error("body too large");
      chunks.push(c);
    }
    if (!chunks.length) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return {};
    }
  }

  // The magpie page frame is sandboxed with an opaque origin, so Origin: null
  // alone is not proof of anything. Every /api/* route except /api/ping needs
  // the per-process token that only the served HTML gets; Host must be this
  // server's own loopback name, and CORS is never wildcarded.
  function hostAllowed(req) {
    const actual = server.address()?.port;
    if (!actual) return false;
    const host = String(req.headers.host || "").toLowerCase();
    return host === `127.0.0.1:${actual}` || host === `localhost:${actual}`;
  }

  function ownOrigins() {
    const actual = server.address()?.port;
    if (!actual) return new Set();
    return new Set([`http://127.0.0.1:${actual}`, `http://localhost:${actual}`]);
  }

  function originAllowed(req) {
    const origin = req.headers.origin;
    return origin === undefined || origin === "null" || ownOrigins().has(origin);
  }

  function tokenOK(req) {
    const got = Buffer.from(String(req.headers[TOKEN_HEADER] || ""));
    const want = Buffer.from(API_TOKEN);
    return got.length === want.length && timingSafeEqual(got, want);
  }

  function corsHeaders(req) {
    const origin = req.headers.origin;
    const allow = origin === "null" ? "null" : origin && ownOrigins().has(origin) ? origin : "null";
    return {
      "access-control-allow-origin": allow,
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": `content-type, ${TOKEN_HEADER}`,
      vary: "Origin",
    };
  }

  function send(res, status, body, type = "application/json; charset=utf-8", cors = true) {
    const data = typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body);
    res.writeHead(status, {
      ...(cors ? corsHeaders(res.req) : {}),
      "content-type": type,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    res.end(data);
  }

  function sendPreflight(res) {
    res.writeHead(204, {
      ...corsHeaders(res.req),
      "access-control-max-age": "600",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    res.end();
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
    const path = url.pathname;
    if (!hostAllowed(req)) return send(res, 403, { error: "只服务本机宠物页" }, undefined, false);
    if (!originAllowed(req)) return send(res, 403, { error: "只服务本机宠物页" });
    if (req.method === "OPTIONS") return sendPreflight(res);
    if (path.startsWith("/api/") && path !== "/api/ping" && !tokenOK(req)) {
      return send(res, 403, { error: "口令不对：请重新打开宠物页", reload: true });
    }
    try {
      if (path === "/api/ping" && req.method === "GET") {
        return send(res, 200, { ok: true });
      }
      if (path === "/api/state" && req.method === "GET") {
        return send(res, 200, readFullState());
      }
      if (path === "/api/command" && req.method === "POST") {
        const body = await readBody(req);
        const name = String(body.name || "");
        const args = body.args === undefined ? undefined : String(body.args).slice(0, 64);

        // --- care layer commands (Task 5); everything validated server-side
        if (
          CARE_COMMANDS.has(name) ||
          name === "pet-expedition-start" ||
          name === "pet-expedition-claim" ||
          name === "pet-decoration-equip" ||
          name === "pet-rename"
        ) {
          const nowMs = Date.now();
          const current = readState(dbFile);
          const partnerId = current.ok && current.partner ? current.partner.id : null;

          if (CARE_COMMANDS.has(name)) {
            if (!partnerId) return send(res, 400, { error: "没有活跃的伙伴可以照顾。", reason: "no-active-partner" });
            const action = CARE_COMMANDS.get(name);
            const context = action === "petEgg" ? { stage: current.partner.engineNode?.stage ?? current.partner.node?.stage } : {};
            const result = careStore.performAction(partnerId, action, nowMs, context);
            if (!result.ok) return send(res, 400, { error: result.message ?? "操作失败。", reason: result.reason });
            return sendCareResult(res, result);
          }

          if (name === "pet-expedition-start") {
            const kind = String(args ?? "");
            if (!EXPEDITION_KINDS.has(kind)) {
              return send(res, 400, { error: `unknown expedition kind: ${kind}`, reason: "unknown-expedition" });
            }
            if (!partnerId) return send(res, 400, { error: "没有活跃的伙伴可以探险。", reason: "no-active-partner" });
            const result = careStore.startExpedition(partnerId, kind, nowMs);
            if (!result.ok) return send(res, 400, { error: `无法开始探险：${result.reason}`, reason: result.reason });
            return send(res, 200, {
              text: `出发去${kind}探险了！`,
              toasts: [],
              state: readFullState(),
            });
          }

          if (name === "pet-expedition-claim") {
            const expeditionId = String(args ?? "");
            if (!expeditionId) {
              return send(res, 400, { error: "claim 需要 expeditionId", reason: "no-expedition" });
            }
            const result = careStore.claimExpedition(expeditionId, nowMs);
            if (!result.ok) return send(res, 400, { error: `无法结算探险：${result.reason}`, reason: result.reason });
            return sendCareResult(res, { ...result, message: result.reward.note });
          }

          if (name === "pet-rename") {
            if (!partnerId) return send(res, 400, { error: "没有活跃的伙伴可以命名。", reason: "no-active-partner" });
            const result = careStore.renamePet(partnerId, args, nowMs);
            if (!result.ok) return send(res, 400, { error: "名字需要 1–20 个字符。", reason: result.reason });
            return send(res, 200, { text: `给它取名为「${result.name}」`, toasts: [], state: readFullState() });
          }

          // pet-decoration-equip
          const decorationId = String(args ?? "");
          if (!DECORATION_IDS.has(decorationId)) {
            return send(res, 400, { error: `unknown decoration: ${decorationId}`, reason: "unknown-decoration" });
          }
          const result = careStore.equipDecoration(decorationId);
          if (!result.ok) return send(res, 400, { error: `无法装备装饰：${result.reason}`, reason: result.reason });
          return send(res, 200, {
            text: `已换上「${decorationId}」主题。`,
            toasts: (result.achievements ?? []).map((id) => ({ title: "成就解锁", message: id })),
            state: readFullState(),
          });
        }

        // --- local guards and pin management
        if (name === "pet-unpin") {
          try {
            const rw = new Database(dbFile);
            rw.run("PRAGMA busy_timeout = 5000");
            rw.run("UPDATE vpet_control_state SET cheat_node_id = NULL WHERE control_id = 1");
            rw.close();
            return send(res, 200, { text: "已取消钉住，恢复自然生长。", toasts: [], state: readFullState() });
          } catch (e) {
            return send(res, 400, { error: `无法取消钉住：${e?.message ?? e}`, reason: "unpin-failed" });
          }
        }
        if (name === "digital-pet-spawn") {
          const current = readState(dbFile);
          const stage = current.ok && current.partner
            ? current.partner.engineNode?.stage ?? current.partner.node?.stage ?? 0
            : null;
          if (stage !== null && stage < 2) {
            return send(res, 400, { error: "当前伙伴达到 baby II 后才能孵下一颗蛋。", reason: "stage-required" });
          }
          const createdAt = current.ok && current.partner ? Date.parse(current.partner.createdAt) : NaN;
          if (Number.isFinite(createdAt) && Date.now() - createdAt < 60_000) {
            const waitSec = Math.ceil((60_000 - (Date.now() - createdAt)) / 1000);
            return send(res, 400, { error: `新蛋刚孵化，${waitSec} 秒后才能再次孵蛋。`, reason: "spawn-cooldown" });
          }
        }

        // --- original engine commands, unchanged
        if (!COMMANDS.has(name)) return send(res, 400, { error: `unknown command: ${name}`, reason: "unknown-command" });
        if (name === "digital-pet-set" && !/^[0-9]-[0-9]{1,3}$/.test(String(args ?? ""))) {
          return send(res, 400, { error: "set 需要一个 Digimon ID，例如 4-001", reason: "invalid-args" });
        }
        const result = await adapter.runCommand(name, args);
        return send(res, 200, {
          text: result.text,
          toasts: result.toasts.map((t) => ({ title: t?.title, message: t?.message })),
          state: readFullState(),
        });
      }

      // static: the dashboard itself (page/app.html and friends). Resolve the
      // decoded URL against UI_ROOT and only serve files strictly inside it.
      let rel;
      try {
        rel = decodeURIComponent(path).replace(/^\/+/, "");
      } catch {
        return send(res, 400, { error: "bad path", reason: "bad-path" });
      }
      const file = resolve(UI_ROOT, rel === "" ? "app.html" : rel);
      const insideRoot = relative(UI_ROOT, file);
      if (insideRoot.startsWith("..") || isAbsolute(insideRoot)) {
        return send(res, 403, { error: "forbidden" });
      }
      let data = await readFile(file).catch(() => null);
      if (!data) return send(res, 404, "not found", "text/plain; charset=utf-8");
      if (file.endsWith("app.html")) {
        const html = data.toString("utf8");
        const tokenScript = `<script>window.PET_TOKEN=${JSON.stringify(API_TOKEN)};</script>`;
        const stamped = html.replace('src="app.js"', `src="app.js?v=${API_TOKEN.slice(0, 8)}"`);
        data = Buffer.from(stamped.replace("</head>", `${tokenScript}</head>`), "utf8");
      }
      return send(res, 200, data, MIME[extname(file).toLowerCase()] || "application/octet-stream");
    } catch (e) {
      return send(res, 500, { error: String(e?.message ?? e) });
    }
  });

  // track live sockets so close() can drop keep-alive connections instead of
  // waiting for the client to let go
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  const bind = (p) =>
    new Promise((resolve, reject) => {
      const onErr = (err) => {
        server.removeListener("listening", onOk);
        reject(err);
      };
      const onOk = () => {
        server.removeListener("error", onErr);
        resolve();
      };
      server.once("error", onErr);
      server.once("listening", onOk);
      server.listen(p, "127.0.0.1");
    });

  let retryTimer = null;
  let serving = false;
  let boundPort = port;

  async function tryBindOnce() {
    try {
      await bind(port);
      boundPort = server.address()?.port ?? port;
      serving = true;
      if (retryTimer) {
        clearInterval(retryTimer);
        retryTimer = null;
      }
      console.log(`[magpie-digital-pet] sidebar page at http://127.0.0.1:${boundPort}/ · db ${dbFile}`);
      return true;
    } catch (e) {
      if (e?.code !== "EADDRINUSE") {
        console.log("[magpie-digital-pet] server bind failed:", e?.message ?? e);
        if (retryTimer) {
          clearInterval(retryTimer);
          retryTimer = null;
        }
        return false;
      }
      // another host process holds the port right now. Hosts come and go
      // (a CLI `plugin add` host lives seconds); keep retrying quietly and
      // take the port over when it frees up.
      return false;
    }
  }

  async function start() {
    const bound = await tryBindOnce();
    if (bound) return true;
    if (!retryTimer) {
      console.log(`[magpie-digital-pet] port ${port} busy; will retry until it frees`);
      retryTimer = setInterval(
        () => {
          if (serving) return;
          tryBindOnce().catch(() => {});
        },
        Math.max(200, retryMs),
      );
      if (typeof retryTimer?.unref === "function") retryTimer.unref();
    }
    return false;
  }

  let closed = false;

  return {
    get port() {
      return boundPort;
    },
    databasePath: dbFile,
    adapter,
    apiToken: API_TOKEN,
    start,
    close: async () => {
      if (closed) return;
      closed = true;
      if (retryTimer) {
        clearInterval(retryTimer);
        retryTimer = null;
      }
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(() => resolve()));
      careStore.close();
    },
  };
}

export const PET_PAGE_PORT = DEFAULT_PORT;
