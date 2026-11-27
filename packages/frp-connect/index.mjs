// frp-connect: a frpc tunnel to the user's own frp server, with a page to
// set it up and to start and stop it.
//
// The plugin is OpenCode's shape (a default export with `id`, `server`, and
// the hooks that come back from it) and imports nothing: magpie's host runs
// it under Bun as it is, with no OpenCode package on the path.
//
//   - the page (magpie.page) is served by a part this plugin runs on
//     127.0.0.1; its Start and Stop press go to that part with the key the
//     host hands the page, so nothing else on the machine can open a
//     tunnel through it;
//   - every tool is read-only: no tool starts frpc, stops it, installs it
//     or downloads anything. An agent can see the state, the log and the
//     frpc.toml that would run — that is all.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { notice } from "./lib/notices.mjs";
import { options } from "./lib/options.mjs";
import * as paths from "./lib/paths.mjs";
import * as service from "./lib/service.mjs";
import * as frpc from "./lib/frpc.mjs";
import { check } from "./lib/config.mjs";
import { NO_ARGS, tool } from "./lib/tool.mjs";

// The plugin's own folder: Bun has import.meta.dir, Node has its URL.
const here = import.meta.dir ?? path.dirname(fileURLToPath(import.meta.url));

// The port the page's control API listens on. magpie.page.service names the
// same port for a browser's magpie (magpie web), where 127.0.0.1 is the
// viewer's own computer and magpie proxies it.
const SERVICE_PORT = 33417;

// say is what the plugin tells magpie: a line in magpie's log, as the host
// reads it off this process's stdout — never anything else, since that
// stream is magpie's protocol.
function say(line, level = "info") {
  try {
    console.error(`[frp-connect] ${line}`);
  } catch {
    // nowhere to write
  }
  try {
    process.stdout.write(JSON.stringify({ event: "log", level, message: `frp-connect: ${line}` }) + "\n");
  } catch {
    // the host is gone
  }
}

// part is the plugin's part once it is on: the control API listening, and
// the frpc it started.
let part = null;

async function up(rawOptions, hostDir) {
  const base = paths.stateDir();
  // an older version kept frpc.toml, the token in it, in the folder of
  // whatever project the agent was opened in; it is moved here
  paths.adopt(base, hostDir);
  const running = service.frp(rawOptions, { say, base });
  const { server } = await service.listen(running, {
    port: running.options.servicePort || SERVICE_PORT,
    page: path.join(here, "page"),
    say,
  });
  return { ...running, server };
}

export default {
  id: "frp-connect",
  async server(input, rawOptions) {
    const hostDir = typeof input?.directory === "string" ? input.directory : "";
    try {
      part = await up(rawOptions, hostDir);
      say(`on: frpc ${frpc.VERSION} is the version this package runs`);
    } catch (e) {
      part = null;
      say(`the page's service didn't start: ${e.message}`, "error");
    }

    return {
      // frpc starts with what the page saved, and only when the page's
      // Auto-start was ticked. Nothing in an event opens a tunnel.
      async event({ event }) {
        if (event?.type !== "started" || !part || !part.options.autoStart) return;
        try {
          const s = await part.start();
          say(s.started ? `auto-start: running (pid ${s.pid})` : `auto-start: ${s.hint}`);
        } catch (e) {
          say(`auto-start failed: ${e.message}`, "error");
        }
      },

      tool: {
        state: tool({
          description:
            "Report frp-connect's state: whether frpc is running, its version and pid, where it writes, and the tunnel's options (the auth token left out). Read-only: it never starts or stops a tunnel.",
          args: NO_ARGS,
          async execute() {
            if (!part) return { on: false, pinnedVersion: frpc.VERSION, ...notice };
            const s = part.state();
            return { on: true, ...s, pinnedVersion: frpc.VERSION, options: redacted(part.options) };
          },
        }),
        logs: tool({
          description: "Return the end of frpc's log and its path. Read-only.",
          args: NO_ARGS,
          async execute() {
            const file = paths.files(paths.stateDir()).log;
            return { logPath: file, log: part ? part.log() : tailOf(file) };
          },
        }),
        generate: tool({
          description:
            "Return the frpc.toml the plugin's options make — the file frpc runs — without writing it or starting anything.",
          args: NO_ARGS,
          async execute(raw) {
            const v = check(options(raw && Object.keys(raw).length ? raw : part?.options ?? {}));
            if (!v.ok) return { ok: false, error: v.error };
            return { ok: true, configPath: paths.files(paths.stateDir()).toml, toml: v.toml };
          },
        }),
        verify: tool({
          description:
            "Check the plugin's options and say whether the frpc that would run them is there, with the SHA256 this package pins. It downloads nothing and runs no frpc.",
          args: NO_ARGS,
          async execute(raw) {
            const cfg = options(raw && Object.keys(raw).length ? raw : part?.options ?? {});
            const v = check(cfg);
            const a = frpc.asset();
            const dir = frpc.installDir(path.join(paths.stateDir(), "frpc"));
            const frpcPart =
              cfg.frpcBinary === "local"
                ? { source: "local", path: cfg.frpcPath || "frpc" }
                : { source: "download", ready: !!frpc.ready(dir, a), dir, sha256: a ? frpc.pinned(a.name) : null };
            // `ok` is the config's own: frpc not downloaded yet is said,
            // not a fault
            if (!v.ok) return { ok: false, error: v.error, frpc: frpcPart };
            return {
              ok: true,
              configPath: paths.files(paths.stateDir()).toml,
              toml: v.toml,
              pinnedVersion: frpc.VERSION,
              frpc: frpcPart,
              note: "frp's own check is `frpc verify`: press Verify on the page",
            };
          },
        }),
      },
    };
  },
};

function redacted(cfg) {
  const { authToken, ...rest } = cfg;
  return { ...rest, authToken: authToken ? "(set)" : "" };
}

function tailOf(file) {
  try {
    const buf = fs.readFileSync(file);
    return buf.subarray(Math.max(0, buf.length - 64 * 1024)).toString("utf8");
  } catch {
    return "";
  }
}
