// Arguments and environment: port, dataDir, token, version, idleExitMinutes
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { daemonBuildStamp } from "./util/buildStamp.js";

export type Config = {
  port: number;
  dataDir: string;
  token: string;
  version: string;
  idleExitMinutes: number;
  buildStamp: string;
  parentPid?: number;
};

function pkgVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/main.js → ../../package.json; src/main.ts also ends up in dist via esbuild
    const pkg = JSON.parse(readFileSync(join(here, "..", "..", "package.json"), "utf8"));
    return String(pkg.version || "0.0.0");
  } catch {
    return "0.0.0";
  }
}

// --data <dir> sets the data root (equivalent to setting XDG_CONFIG_HOME and then joining magpie/agent-console?
// EXEC §5.2: --data <dir> (data root, equivalent to setting XDG_CONFIG_HOME; default $XDG_CONFIG_HOME
// or ~/.config, then joined with magpie/agent-console). i.e. the --data value has XDG_CONFIG_HOME semantics.
export function parseConfig(argv: string[]): Config {
  let port: number | null = null;
  let data: string | null = null;
  let token: string | null = null;
  let parentPid: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port" && argv[i + 1]) port = Number(argv[++i]);
    else if (a.startsWith("--port=")) port = Number(a.slice(7));
    else if (a === "--data" && argv[i + 1]) data = argv[++i];
    else if (a.startsWith("--data=")) data = a.slice(7);
    else if (a === "--token" && argv[i + 1]) token = argv[++i];
    else if (a.startsWith("--token=")) token = a.slice(8);
    else if (a === "--parent-pid" && argv[i + 1]) parentPid = Number(argv[++i]);
    else if (a.startsWith("--parent-pid=")) parentPid = Number(a.slice(13));
  }
  if (port == null || !Number.isInteger(port) || port < 0 || port > 65535) {
    const envPort = Number(process.env.AGENT_CONSOLE_PORT || "");
    port = Number.isInteger(envPort) && envPort >= 0 && envPort <= 65535 ? envPort : 3488;
  }
  const xdg = data ?? process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  const dataDir = resolve(join(xdg, "magpie", "agent-console"));
  const idleEnv = Number(process.env.AGENT_CONSOLE_IDLE_EXIT_MIN || "");
  return {
    port,
    dataDir,
    token: token ?? process.env.AGENT_CONSOLE_TOKEN ?? randomBytes(16).toString("hex"),
    version: pkgVersion(),
    idleExitMinutes: Number.isFinite(idleEnv) && idleEnv > 0 ? idleEnv : 60,
    buildStamp: daemonBuildStamp(),
    parentPid: Number.isInteger(parentPid) ? parentPid : undefined,
  };
}
