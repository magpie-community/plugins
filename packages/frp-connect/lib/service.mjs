// frp-connect's part of magpie: the page's files, its control API, and
// frpc kept in sight while the plugin is on. It listens on 127.0.0.1 only,
// at the port the package names (magpie.page.service), and every call to
// it needs the key it writes into its folder — which only magpie's host
// reads, so a page's own scripts, a browser tab or another program can't
// start a tunnel through it. Changing the options restarts it: magpie
// reloads a plugin whose options it sets.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { check } from "./config.mjs";
import * as frpc from "./frpc.mjs";
import { options } from "./options.mjs";
import * as paths from "./paths.mjs";
import { run } from "./run.mjs";
import * as sup from "./supervise.mjs";

const OPEN = ["/", "/index.html", "/app.js", "/style.css", "/i18n.js"];

// key is the secret this host hands out: a random value kept in the
// plugin's state folder, made the first time it is wanted.
export function key(dir = paths.stateDir()) {
  try {
    return fs.readFileSync(path.join(dir, "service.key"), "utf8").trim();
  } catch {
    try {
      const k = Math.random().toString(36).slice(2) + Date.now().toString(36) + process.pid.toString(36);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "service.key"), k + "\n", { mode: 0o600 });
      return k;
    } catch {
      return "";
    }
  }
}

// where frpc comes from: a checked install of the pinned version, or the
// user's own frpc. A download is a start's to do, not the page's.
async function binary(cfg, dir) {
  if (cfg.frpcBinary === "local") {
    return { path: cfg.frpcPath || "frpc", source: "local", ready: true };
  }
  const a = frpc.asset();
  if (!a) return { path: null, source: "download", ready: false, why: `frp builds no frpc for this platform. Set a local frpc.` };
  const found = frpc.ready(dir, a);
  return { path: found, source: "download", ready: !!found, why: found ? null : "frpc isn't downloaded yet." };
}

async function ensureBinary(cfg, dir, say) {
  const b = await binary(cfg, dir);
  if (b.path || cfg.frpcBinary === "local") return { ...b, path: b.path ?? cfg.frpcPath ?? "frpc" };
  const a = frpc.asset();
  const dest = await frpc.install(dir, { a, say });
  return { path: dest, source: "download", ready: true };
}

// frp is the plugin's running part: its options, where it writes, and the
// frpc it started.
export function frp(rawOptions, { say = () => {}, base = paths.stateDir() } = {}) {
  return make(options(rawOptions), { say, base });
}

function make(cfg, { say, base }) {
  const install = path.join(base, "frpc");
  let current = null; // the frpc this host started: {child, record, exited}

  // end is a frpc that left on its own: it is forgotten, its last words
  // kept in the log.
  const watch = (run) => {
    current = run;
    run.exited.then(async ({ code, signal, error }) => {
      sup.forget(paths.files(base), run.record.pid);
      if (current === run) current = null;
      say(`frpc ended${error ? `: ${error}` : signal ? ` (${signal})` : ` (exit ${code})`}`);
    });
  };

  const state = () => sup.state(paths.files(base));

  async function start() {
    const validated = check(cfg);
    if (!validated.ok) throw new Error(validated.error);
    const files = paths.files(base);
    fs.mkdirSync(files.dir, { recursive: true });
    const hash = sup.hash(validated.toml);
    const now = state();
    if (now.running && now.configHash === hash) return { ...now, alreadyRunning: true };
    if (now.running) sup.stop(files);

    const bin = await ensureBinary(cfg, install, say);
    fs.writeFileSync(files.toml, validated.toml, "utf8");
    const version = await frpc.said(bin.path);
    if (current) {
      // a child of ours that is still going, on a config that changed
      try {
        current.child.kill();
      } catch {
        // gone
      }
    }
    const run = sup.start(files, bin.path, { version, hash });
    watch(run);
    say(`frpc started (pid ${run.record.pid}) with ${files.toml}`);
    // a frpc that can't start, or that leaves at once, is said here
    const quick = await Promise.race([
      run.exited,
      new Promise((r) => setTimeout(() => r(null), 900)),
    ]);
    const after = state();
    return {
      ...after,
      started: after.running,
      frpcPath: bin.path,
      version,
      logTail: after.running ? undefined : sup.tail(files.log, 4000),
      hint: after.running
        ? undefined
        : quick?.error
          ? `frpc couldn't start: ${quick.error}`
          : "frpc left right after starting; see logTail.",
    };
  }

  function stop() {
    if (current) {
      try {
        current.child.kill();
      } catch {
        // gone
      }
      current = null;
    }
    return sup.stop(paths.files(base));
  }

  async function verify() {
    const validated = check(cfg);
    if (!validated.ok) throw new Error(validated.error);
    const b = await binary(cfg, install);
    if (!b.path) {
      return { ok: false, checked: false, why: b.why, toml: validated.toml };
    }
    const files = paths.files(base);
    fs.mkdirSync(files.dir, { recursive: true });
    fs.writeFileSync(files.toml, validated.toml, "utf8");
    const out = await run(b.path, ["verify", "-c", files.toml], 15000);
    return {
      ok: out.ok,
      checked: true,
      frpcPath: b.path,
      stdout: out.stdout.trim(),
      stderr: out.stderr.trim(),
      error: out.error,
    };
  }

  return {
    options: cfg,
    base,
    start,
    stop,
    verify,
    restart: async () => {
      stop();
      return start();
    },
    state,
    log: () => sup.tail(paths.files(base).log),
    binary: () => binary(cfg, install),
  };
}

// listen is the control API and the page's files, on 127.0.0.1.
export function listen(part, { port, page, say = () => {} }) {
  const secret = key(part.base);
  const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

  async function answer(r, rw) {
    let url;
    try {
      url = new URL(r.url, "http://127.0.0.1");
    } catch {
      rw.writeHead(400).end();
      return;
    }
    const file = () => {
      const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      if (!OPEN.includes("/" + rel)) return null;
      const p = path.join(page, rel);
      try {
        return fs.readFileSync(p, "utf8");
      } catch {
        return null;
      }
    };

    // the page's own files need no key: the page's folder isn't secret,
    // and it holds no more than the page's markup and scripts
    const html = r.method === "GET" ? file() : null;
    if (html !== null) {
      rw.writeHead(200, {
        "Content-Type": types[path.extname(url.pathname === "/" ? "index.html" : url.pathname)] || "application/octet-stream",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      rw.end(html);
      return;
    }

    const json = (code, body) => {
      rw.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      rw.end(JSON.stringify(body));
    };
    if (url.pathname !== "/api/state" && url.pathname !== "/api/action") return json(404, { error: "no such call" });
    if (r.headers["x-frp-key"] !== secret || !secret) return json(403, { error: "this call needs frp-connect's key" });

    try {
      if (url.pathname === "/api/state") return json(200, await view(part));
      const body = await read(r);
      const action = String(body.action ?? "");
      say(`page: ${action}`);
      const result = await act(part, action);
      return json(200, { action, result, state: await view(part) });
    } catch (e) {
      return json(200, { error: e.message, state: await view(part) });
    }
  }

  const server = http.createServer((request, response) => {
    answer(request, response).catch((e) => {
      say(`control API: ${e.message}`, "error");
      try {
        response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: e.message }));
      } catch {
        // the reply had gone
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      server.on("error", (e) => say(`control API: ${e.message}`));
      say(`control API on 127.0.0.1:${port}`);
      resolve({ server, secret });
    });
  });
}

function read(r) {
  return new Promise((resolve) => {
    let body = "";
    r.on("data", (d) => {
      body += d;
      if (body.length > 64 * 1024) r.destroy();
    });
    r.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        resolve({});
      }
    });
    r.on("error", () => resolve({}));
  });
}

async function act(part, action) {
  switch (action) {
    case "state":
      return part.state();
    case "start":
      return part.start();
    case "stop":
      return part.stop();
    case "restart":
      return part.restart();
    case "verify":
      return part.verify();
    default:
      throw new Error(`no such action: ${action}`);
  }
}

async function view(part) {
  const s = part.state();
  return { ...s, log: part.log(), binary: await part.binary() };
}
