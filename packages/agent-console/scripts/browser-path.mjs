// Chromium-family browser for the e2e / screenshot scripts: MSEDGE_PATH / CHROME_PATH first,
// then the usual Edge, Chrome and Chromium install locations per platform.
import { existsSync } from "node:fs";

export function findBrowser(env = process.env, platform = process.platform, exists = existsSync) {
  const explicit = env.MSEDGE_PATH || env.CHROME_PATH;
  if (explicit) return explicit;
  const local = env.LOCALAPPDATA || "";
  const candidates =
    platform === "win32"
      ? [
          "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
          "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
          "C:/Program Files/Google/Chrome/Application/chrome.exe",
          "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
          local && `${local.replace(/\\/g, "/")}/Google/Chrome/Application/chrome.exe`,
        ]
      : platform === "darwin"
        ? [
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
          ]
        : [
            "/usr/bin/microsoft-edge",
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/snap/bin/chromium",
          ];
  return candidates.filter(Boolean).find((p) => exists(p));
}
