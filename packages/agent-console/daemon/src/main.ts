// Daemon entry: parse arguments, initialize services, start HTTP+WS, write daemon.json, handle exit.
import { mkdirSync, existsSync, rmSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfig } from "./config.js";
import { initLog, log } from "./log.js";
import { createHttpServer } from "./http.js";
import { AttachmentStore } from "./store/attachments.js";
import { SettingsStore } from "./store/settings.js";
import { ProjectsStore } from "./store/projects.js";
import { ThreadsStore } from "./store/threads.js";
import { Gateway } from "./ws/gateway.js";
import { registerMethods } from "./ws/methods.js";
import { writeJsonAtomic } from "./util/atomic.js";
import { initProviders } from "./providers/registry.js";
import { AgentManager } from "./agents/manager.js";
import { GitService } from "./git/service.js";
import { FileService } from "./files/service.js";
import { TerminalService } from "./terminal/service.js";
import { augmentPath, pidAlive } from "./util/proc.js";

// The bundle targets node20: an older Node (or being started by Bun by mistake) gets a clear message instead of crashing on some API
const nodeMajor = Number(/^v?(\d+)/.exec(process.versions.node ?? "")?.[1] ?? 0);
if (nodeMajor < 20) {
  console.error(`[agent-console] 需要 Node.js 20 或更高版本，当前 ${process.version}（${process.execPath}）`);
  process.exit(3);
}

// Agent CLI .js entries and the Claude SDK look up "node" by name; GUI apps launched from the macOS Dock get a minimal PATH,
// so append the current node's directory and common install directories to PATH (existing order unchanged)
process.env.PATH = augmentPath(process.env, dirname(process.execPath));

const cfg = parseConfig(process.argv.slice(2));

// Top-level safety net: log, don't exit
process.on("uncaughtException", (e) => {
  log("error", "uncaughtException", { err: String(e?.stack ?? e) });
});
process.on("unhandledRejection", (e) => {
  log("error", "unhandledRejection", { err: String(e) });
});

async function main(): Promise<void> {
  initLog(cfg.dataDir);
  for (const d of ["threads", "attachments", "trash", "logs"]) {
    mkdirSync(join(cfg.dataDir, d), { recursive: true });
  }

  const appDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "app");
  const attachments = new AttachmentStore(join(cfg.dataDir, "attachments"));
  const { bindAttachmentStore } = await import("./util/attachmentRefs.js");
  bindAttachmentStore(attachments);
  const settings = new SettingsStore(cfg.dataDir);
  const projects = new ProjectsStore(cfg.dataDir);
  const threads = new ThreadsStore(cfg.dataDir);
  const gateway = new Gateway(cfg);

  initProviders(cfg.version);
  // Legacy data migration (§10.1): runs once, skipped after v1Migrated; old files are read-only
  const { migrateLegacy } = await import("./migrate/legacy.js");
  try {
    await migrateLegacy(cfg.dataDir, { settings, projects, threads });
  } catch (e) {
    log("error", "旧数据迁移失败", { err: String(e) });
  }
  const manager = new AgentManager(gateway, threads, projects, settings, attachments);
  await manager.recoverOnStart();
  const terminals = new TerminalService(gateway);
  registerMethods(gateway, {
    cfg,
    settings,
    gateway,
    projects,
    threads,
    manager,
    git: new GitService(),
    files: new FileService(),
    terminals,
    runtime: (id) => manager.runtimeInfo(id),
  });

  const server = createHttpServer(cfg, appDir, attachments, {
    onUpgrade: (req, socket, head) => gateway.handleUpgrade(req, socket, head),
  });

  // Retry 5 times if the port is in use
  let attempts = 0;
  await new Promise<void>((resolveListen, rejectListen) => {
    const tryListen = () => {
      attempts++;
      server.once("error", (e: NodeJS.ErrnoException) => {
        if (e.code === "EADDRINUSE" && attempts < 6) {
          log("warn", `端口 ${cfg.port} 被占用，500ms 后重试（第 ${attempts} 次）`);
          setTimeout(tryListen, 500);
        } else {
          rejectListen(e);
        }
      });
      server.listen(cfg.port, "127.0.0.1");
    };
    server.once("listening", () => resolveListen());
    tryListen();
  }).catch((e) => {
    log("error", `端口 ${cfg.port} 无法监听`, { err: String(e) });
    process.exit(2);
  });

  // --port 0: after listening on a random port, write the actual port back into cfg.port. Host/Origin checks read cfg.port,
  // and no request can arrive before this (listen has only just completed), so there is no window checking against the old port.
  const bound = server.address();
  if (bound && typeof bound === "object") cfg.port = bound.port;
  // Ready line: the plugin host reads this line from stdout to learn the actual port (port and pid only, no token)
  process.stdout.write(JSON.stringify({ agentConsoleReady: true, port: cfg.port, pid: process.pid }) + "\n");
  // Background warm-up: after start, pull detection/models for enabled providers into the cache so the first page open doesn't wait
  void (async () => {
    const { warmProviderCache } = await import("./providers/warm.js");
    await warmProviderCache(await settings.get());
  })().catch((e) => log("warn", "Provider 预热失败", { err: String(e) }));

  const daemonJsonPath = join(cfg.dataDir, "daemon.json");
  await writeJsonAtomic(daemonJsonPath, {
    pid: process.pid,
    port: cfg.port,
    token: cfg.token,
    version: cfg.version,
    buildStamp: cfg.buildStamp,
    startedAt: Date.now(),
  });
  chmodSync(daemonJsonPath, 0o600);
  log("info", `daemon 已启动 端口 ${cfg.port} 数据目录 ${cfg.dataDir} 版本 ${cfg.version} pid ${process.pid}`);
  // Standalone dev mode: print the open URL with the token to the console (console only, never the log file)
  // B20: standalone (dev) runs only: the token goes to an interactive terminal, never to a redirected stdout or a log
  if (!cfg.parentPid) {
    console.log(process.stdout.isTTY
      ? `[agent-console] open http://127.0.0.1:${cfg.port}/#t=${cfg.token}`
      : `[agent-console] listening on http://127.0.0.1:${cfg.port}/ (token not printed: stdout is not a terminal)`);
  }

  // Idle exit: check every minute; no WS connection + no running conversation + no open terminal → exit after idleExitMinutes
  let idleSince = Date.now();
  setInterval(() => {
    const busy = gateway.connectionCount > 0 || manager.anyBusy() || terminals.count > 0;
    if (busy) idleSince = Date.now();
    if (Date.now() - idleSince > cfg.idleExitMinutes * 60 * 1000) {
      log("info", "空闲超时，daemon 退出");
      shutdown(0);
    }
  }, 60 * 1000).unref();

  let shuttingDown = false;
  function shutdown(code: number): void {
    if (shuttingDown) return;
    shuttingDown = true;
    log("info", "daemon 关闭中");
    terminals.killAll();
    gateway.closeAll();
    try {
      rmSync(daemonJsonPath, { force: true });
    } catch {}
    // Wait for Agent sessions to close cleanly (at most 2.5 s) before exiting; process trees still alive are cleaned up by util/bin's exit hook
    const sessionsClosed = Promise.race([manager.shutdown(), new Promise((r) => setTimeout(r, 2500))]);
    void sessionsClosed.then(() => server.close(() => process.exit(code)));
    setTimeout(() => process.exit(code), 4000).unref();
  }
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
  // Lifeline: when spawned by the plugin host (Magpie's Bun plugin process) we get --parent-pid, and stdin is a pipe the host holds.
  // Host exits (normally or killed) → pipe closes → stdin end/close → exit;
  // also check every 2 seconds whether the parent is still alive, in case stdin was inherited by another process and never closed.
  // Not enabled in standalone dev mode (npm run dev, no --parent-pid); there we rely on idle exit only.
  if (cfg.parentPid) {
    const parentPid = cfg.parentPid;
    const parentWatch = setInterval(() => {
      if (!pidAlive(parentPid)) {
        clearInterval(parentWatch);
        log("info", `父进程 ${parentPid} 已退出，daemon 跟随退出`);
        shutdown(0);
      }
    }, 2000);
    parentWatch.unref();
    // Logged so a daemon that went away with its plugin host (Magpie restarting it) can be told from an idle exit
    const lifelineClosed = () => { log("info", "plugin host closed the lifeline (stdin); daemon exiting with it"); shutdown(0); };
    process.stdin.on("end", lifelineClosed);
    process.stdin.on("close", lifelineClosed);
    process.stdin.on("error", () => shutdown(0));
    process.stdin.resume();
  }
}

main().catch((e) => {
  console.error("[agent-console] 启动失败", e);
  process.exit(1);
});
