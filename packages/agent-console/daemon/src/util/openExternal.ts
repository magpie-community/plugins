// Open an http(s) URL in the system browser (1.2). Inside Magpie the page has no allow-popups, so target=_blank and
// window.open do nothing; the daemon opens the link instead. execFile only (no shell), the URL is re-serialized by URL
// and passed as one argument:
//   macOS  open <href>
//   Linux  xdg-open <href>
//   Windows rundll32.exe url.dll,FileProtocolHandler <href>   (not `cmd /c start`: cmd would parse & | ^ in the URL)
import { execFile } from "node:child_process";
import { externalHref } from "../preview/url.js";

export function openerFor(platform: NodeJS.Platform, href: string): { cmd: string; args: string[] } {
  if (platform === "win32") return { cmd: "rundll32.exe", args: ["url.dll,FileProtocolHandler", href] };
  if (platform === "darwin") return { cmd: "open", args: [href] };
  return { cmd: "xdg-open", args: [href] };
}

type ExecLike = (cmd: string, args: string[], opts: { windowsHide: boolean; timeout: number }, cb: (err: Error | null) => void) => { on(ev: "error", fn: (e: Error) => void): unknown };

/** ok:false when the URL is refused or no opener could run (e.g. no xdg-open): the page then copies the link instead */
export async function openExternal(
  raw: string,
  opts: { platform?: NodeJS.Platform; exec?: ExecLike; waitMs?: number } = {},
): Promise<{ ok: boolean; href?: string; reason?: string }> {
  const href = externalHref(raw);
  if (!href) return { ok: false, reason: "bad_url" };
  const { cmd, args } = openerFor(opts.platform ?? process.platform, href);
  const run = opts.exec ?? (execFile as unknown as ExecLike);
  return await new Promise((resolve) => {
    let settled = false;
    const done = (v: { ok: boolean; href?: string; reason?: string }) => {
      if (!settled) { settled = true; resolve(v); }
    };
    try {
      const child = run(cmd, args, { windowsHide: true, timeout: 15000 }, (err) => {
        // rundll32 / open / xdg-open return quickly; a non-zero exit means nothing was opened
        done(err ? { ok: false, href, reason: "opener_failed" } : { ok: true, href });
      });
      child.on("error", () => done({ ok: false, href, reason: "no_opener" }));
    } catch {
      done({ ok: false, href, reason: "no_opener" });
    }
    // Some openers stay running (a browser launched in the foreground): treat "still running" as opened
    setTimeout(() => done({ ok: true, href }), opts.waitMs ?? 4000).unref?.();
  });
}
