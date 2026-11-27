import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { activity } from "../lib/activity.mjs";
import { inventory } from "../lib/agents.mjs";
import { listBanks } from "../lib/banks.mjs";
import { agentId, agentPolicy, configuration, DEFAULTS, gatewayBank, gatewayBanks } from "../lib/config.mjs";
import { hash } from "../lib/turns.mjs";
import { testConnection } from "./probe.mjs";

const TOKEN_HEADER = "x-hindsight-token";
const MAX_BODY = 32768;
const UI = ["workbench.html", "style.css", "workbench.js"];
const PERIODS = new Set([24, 168, 720]);

async function readBody(req) {
  const contentLength = Number(req.headers.get("content-length"));
  if (contentLength > MAX_BODY) return undefined;
  const chunks = [];
  let size = 0;
  for await (const chunk of req.body ?? []) {
    size += chunk.byteLength;
    if (size > MAX_BODY) return undefined;
    chunks.push(Buffer.from(chunk));
  }
  try { return size ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}; }
  catch { return undefined; }
}

function authorized(req, token) {
  const value = req.headers.get(TOKEN_HEADER) || "";
  return value.length === token.length && Buffer.byteLength(value) === token.length &&
    timingSafeEqual(Buffer.from(value), Buffer.from(token));
}

function configView(options, snapshot, rows, hints) {
  const config = configuration(options);
  const agents = new Map(snapshot.agents.map(agent => [agent.id, agent]));
  for (const name of [...config.agents, ...Object.keys(config.agent_policies), ...hints, ...rows.map(row => row.agent)]) {
    const id = agentId(name);
    if (id && agents.size < 192 && !agents.has(id))
      agents.set(id, { id, name: id === "unknown" ? "未识别调用方" : id });
  }
  const data = [...agents.values()].map(agent => {
    const native = agent.native ?? snapshot.native[agent.id] ?? {};
    return { ...agent, native,
      fromUsage: hints.includes(agent.id),
      gatewayBank: gatewayBank(config, agent.id),
      bankOverride: config.agent_mode === "legacy" ? "" : config.agent_policies[agent.id]?.bank ?? "",
      policy: agentPolicy(config, agent.id === "unknown" ? "" : agent.id, native)
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
  return { agents: data, defaultBank: config.bank, mode: config.agent_mode, revision: hash(config).slice(0, 12) };
}

export function createService({ fetcher = fetch, readInventory = inventory, stats = activity } = {}) {
  const token = randomBytes(32).toString("hex");
  const nonce = randomBytes(24).toString("base64");
  let templates;
  let options = {};
  let checked;
  let probe;
  let lastProbeAt = 0;
  let polling;

  async function validateBanks(candidate) {
    let baseline;
    try { baseline = configuration(options); } catch { /* Recovering from invalid settings. */ }
    const known = baseline?.hindsight_api === candidate.hindsight_api ? gatewayBanks(baseline) : [];
    const targets = gatewayBanks(candidate).filter(bank => !known.includes(bank));
    if (!targets.length) return [];
    const listing = await listBanks(candidate, { fetcher });
    const listed = new Set(listing.banks.map(bank => bank.id));
    const missing = targets.filter(bank => !listed.has(bank));
    if (!listing.partial || !missing.length) return missing;
    const unverified = [];
    for (const bank of missing) {
      const result = await listBanks(candidate, { query: bank, fetcher, maxPages: 1 });
      if (!result.banks.some(entry => entry.id === bank)) unverified.push(bank);
    }
    return unverified;
  }

  function pollBanks(config) {
    if (polling) return polling;
    polling = (async () => {
      for (const bank of gatewayBanks(config)) await stats.poll({ ...config, bank });
    })().finally(() => { polling = undefined; });
    return polling;
  }

  async function page(port) {
    templates ??= Promise.all(UI.map(name => readFile(new URL(name, import.meta.url), "utf8")));
    const [html, css, script] = await templates;
    const body = html.replaceAll("%%NONCE%%", nonce).replace("%%TOKEN%%", token)
      .replace("/* %%STYLE%% */", () => css).replace("/* %%SCRIPT%% */", () => script);
    return new Response(body, { headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'; base-uri 'none'; form-action 'none'; " +
        "script-src 'nonce-" + nonce + "'; style-src 'nonce-" + nonce + "'; connect-src 'self' http://127.0.0.1:" + port + " http://localhost:" + port
    } });
  }

  async function handle(req, server) {
    const hosts = ["127.0.0.1:" + server.port, "localhost:" + server.port];
    const headerHost = req.headers.get("host")?.toLowerCase();
    if (!hosts.includes(headerHost)) return new Response("Forbidden", { status: 403 });
    const path = new URL(req.url).pathname;
    if (req.method === "GET" && ["/", "/workbench", "/test"].includes(path)) return page(server.port);
    if (!["/api/status", "/api/preview", "/api/check", "/api/banks", "/test"].includes(path)) return new Response("Not found", { status: 404 });
    const origin = req.headers.get("origin");
    if (origin !== null && origin !== "null" && !hosts.some(host => origin === "http://" + host))
      return new Response("Forbidden", { status: 403 });
    const headers = { "Cache-Control": "no-store" };
    if (origin === "null") {
      headers["Access-Control-Allow-Origin"] = "null";
      headers["Access-Control-Allow-Headers"] = TOKEN_HEADER + ", content-type";
      headers["Access-Control-Allow-Methods"] = "POST, OPTIONS";
      headers.Vary = "Origin";
    }
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers });
    if (!authorized(req, token)) return Response.json({ error: "forbidden" }, { status: 403, headers });
    const input = await readBody(req);
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return Response.json({ error: "invalid-input" }, { status: 400, headers });
    }
    const reply = data => Response.json(data, { headers });
    try {
      if (path === "/api/banks") {
        return reply(await listBanks(configuration(input.options ?? options), { fetcher }));
      }
      if (path === "/api/check" || path === "/test") {
        const candidate = input.options ?? options;
        if (probe || Date.now() - lastProbeAt < 1000) return reply({ error: "check-busy" });
        const saved = input.options === undefined;
        lastProbeAt = Date.now();
        probe = testConnection(candidate, fetcher);
        try {
          const result = await probe;
          if (saved && candidate === options) checked = result;
          return reply(result);
        } finally { probe = undefined; }
      }
      const hours = PERIODS.has(input.hours) ? input.hours : 24;
      const hints = Array.isArray(input.hints) ? input.hints.slice(0, 40).map(agentId).filter(Boolean) : [];
      const [native, events] = await Promise.all([readInventory(input.refresh === true), stats.summary(hours)]);
      if (path === "/api/preview") {
        const config = configuration(input.options);
        if (input.verifyBanks === true) {
          try {
            const missing = await validateBanks(config);
            if (missing.length) return reply({ error: "bank-unverified", missing });
          } catch { return reply({ error: "bank-directory-unavailable" }); }
        }
        return reply(configView(input.options, native, events.rows, hints));
      }
      let config;
      try { config = configuration(options); } catch { /* The settings page can recover invalid saved options. */ }
      if (config) void pollBanks(config).catch(() => {});
      return reply({
        ...(config ? configView(options, native, events.rows, hints) : { agents: native.agents, invalid: true }),
        activity: events,
        connection: checked ?? null,
        nativeLogs: native.nativeLogs,
        discoveredAt: native.checkedAt
      });
    } catch (error) {
      const invalid = error.message?.startsWith("invalid plugin option:");
      return reply(invalid ? { error: "invalid-options", field: error.message.split(": ").at(-1) } : { error: "service-unavailable" });
    }
  }

  return {
    handle,
    options(next) {
      if (hash(next ?? {}) !== hash(options)) checked = undefined;
      options = next ?? {};
    },
    poll() {
      let config;
      try { config = configuration(options); } catch { return; }
      void pollBanks(config).catch(() => {});
    }
  };
}

const service = createService();
let running;
let timer;
export default {
  id: "magpie-hindsight",
  async server(_input, options) {
    const port = options?.port ?? DEFAULTS.port;
    if (!Number.isInteger(port) || port < 1024 || port > 65535) return {};
    service.options(options);
    if (running?.port === port) return {};
    let server;
    try { server = Bun.serve({ hostname: "127.0.0.1", port, fetch: service.handle }); }
    catch {
      console.warn("[magpie-hindsight] Workbench could not listen on its local port.");
      return {};
    }
    running?.stop(true);
    clearInterval(timer);
    running = server;
    timer = setInterval(service.poll, 15000);
    timer.unref?.();
    return { close() {
      if (running !== server) return;
      clearInterval(timer);
      server.stop(true);
      running = undefined;
    } };
  }
};
