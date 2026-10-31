// Settings › Launch command: a custom executable for an Agent plus extra arguments.
// The arguments the user types are APPENDED after the built-in ones (e.g. `opencode acp --foo`, `codex app-server --foo`,
// `claude <stream-json flags> --foo`). prefixArgs is internal (tests run `node fixture.mjs`) and goes before the built-ins.
import type { LaunchCommand } from "./types.js";
import type { Settings } from "../store/settings.js";
import { resolveBin, type ResolveResult } from "../util/bin.js";
import { tr } from "../util/i18n.js";

export function launchFromSettings(settings: Settings, providerId: string): LaunchCommand | undefined {
  const c = settings.providerCommand?.[providerId];
  const cmd = typeof c?.executable === "string" ? c.executable.trim() : "";
  if (!cmd) return undefined;
  const args = Array.isArray(c?.args) ? c!.args.filter((a): a is string => typeof a === "string") : [];
  return { cmd, args };
}

/** Built-in arguments wrapped with the launch command's internal prefix and the user's extra arguments. */
export function launchArgv(builtin: string[], launch?: LaunchCommand): string[] {
  return [...(launch?.prefixArgs ?? []), ...builtin, ...(launch?.args ?? [])];
}

/** Resolve a custom executable (absolute path or a name on PATH; Windows .cmd/.ps1 shims are handled by resolveBin). */
export async function resolveLaunch(launch: LaunchCommand): Promise<ResolveResult> {
  const r = await resolveBin(launch.cmd);
  if (r.ok) return r;
  return { ok: false, reason: tr("launch.notFound", { cmd: launch.cmd }) };
}

export function launchKey(launch?: LaunchCommand): string {
  return launch ? `${launch.cmd}\0${(launch.prefixArgs ?? []).join("\0")}\0\0${(launch.args ?? []).join("\0")}` : "";
}
