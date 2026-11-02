// What the page needs to know about the daemon's OS to decide whether the in-panel preview can run (#582).
// Apple froze the OS version in the WebKit UA at "Mac OS X 10_15_7" (WKWebView and Safari on macOS 26+ still send it),
// so the page can't tell macOS 15 from 26 by itself. The daemon runs on the same Mac (it listens on 127.0.0.1 only)
// and reads the real version: Darwin kernel 25.x is macOS 26, whose WebKit resolves *.localhost to loopback itself.
import os from "node:os";

export type PreviewHost = {
  /** os.platform() of the daemon host */
  platform: string;
  /** major of os.release() when platform is darwin (25 = macOS 26), else null; null too when it can't be parsed */
  darwinMajor: number | null;
};

/** Darwin 25 = macOS 26, the first macOS whose WebKit answers *.localhost with loopback without asking DNS */
export const DARWIN_LOCALHOST_LOOPBACK = 25;

export function previewHost(platform: string = os.platform(), release: string = os.release()): PreviewHost {
  if (platform !== "darwin") return { platform, darwinMajor: null };
  const m = /^(\d+)\./.exec(String(release ?? "").trim()) ?? /^(\d+)$/.exec(String(release ?? "").trim());
  const major = m ? Number(m[1]) : NaN;
  return { platform, darwinMajor: Number.isInteger(major) && major > 0 ? major : null };
}
