// Entry: read the hash token and theme params, mount <App/>.
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/layout.css";
import "./styles/chat.css";
import "./styles/composer.css";
import { createRoot } from "react-dom/client";
import { applyMagpieTokensFromSearch } from "./layout/applyMagpieTokens.js";
import { initLocale, getLocale } from "./i18n/index.js";
import { WsClient } from "./api/ws";
import { useConnection } from "./stores/connection";
import { useUi } from "./stores/ui";
import { useData } from "./stores/data";
import { App } from "./App";
import { DebugApp } from "./Debug";

import { getToken } from "./api/token";
const token = getToken();

// Theme: ?theme=light|dark first, otherwise follow the system (settings.theme override happens after hydrate, completed in P2-6)
const params = new URLSearchParams(location.search);
const themeParam = params.get("theme");
initLocale(location.search);
applyMagpieTokensFromSearch(location.search);
const preferDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
document.documentElement.dataset.theme =
  themeParam === "light" || themeParam === "dark" ? themeParam : preferDark ? "dark" : "light";

export const ws = new WsClient(token, getLocale());
// For the debug page (P1-8) and e2e driving: expose the authenticated client and internal stores.
(window as unknown as { __ws?: WsClient; __stores?: unknown }).__ws = ws;
(window as unknown as { __stores?: unknown }).__stores = { useData, useUi, useConnection };
void import("./stores/timeline").then((m) => {
  (window as unknown as { __tl?: unknown }).__tl = m.useTimeline;
});
ws.onState((s) => useConnection.getState().set({ state: s }));
ws.connect();
ws.waitHello().then(async (h) => {
  useConnection.getState().set({ version: (h as { version?: string }).version ?? null });
  // Fetch UI preferences (sidebar width / panel / collapsed projects / last opened conversation)
  useUi.getState().bind(ws);
  try {
    const s = (await ws.call("settings.get")) as Record<string, unknown>;
    useUi.getState().hydrate(s);
    // settings.theme override (only without a ?theme= parameter)
    if (!themeParam) {
      const { applyTheme } = await import("./components/Settings");
      applyTheme((s.theme as string) ?? "auto");
    }
  } catch {}
  // Fetch the project/conversation/provider lists and subscribe to the sidebar channel
  await useData.getState().bind(ws);
});
setInterval(() => ws.ping(), 10000);

const isDebug = params.get("debug") === "1";
createRoot(document.getElementById("root")!).render(isDebug ? <DebugApp /> : <App />);

// ?audit=1 (§11.3 screenshot self-check metrics): count visible borders on the first screen, font-size set, accent-colored elements, horizontal scroll,
// written to <pre id="audit"> (after 1.5s so the first screen settles).
if (params.get("audit") === "1") {
  setTimeout(() => {
    try {
      const vw = window.innerWidth;
      const docW = document.documentElement.scrollWidth;
      const fontSizes = new Set<string>();
      const accentEls: string[] = [];
      let borders = 0;
      const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
      const inFirstScreen = (r: DOMRect) => r.top < window.innerHeight && r.bottom > 0 && r.width > 0;
      document.querySelectorAll("*").forEach((el) => {
        const e = el as HTMLElement;
        const cs = getComputedStyle(e);
        const r = e.getBoundingClientRect();
        if (!inFirstScreen(r) || cs.display === "none" || cs.visibility === "hidden") return;
        if (r.width < 3 || r.height < 3) return;
        fontSizes.add(cs.fontSize);
        if (cs.borderTopWidth !== "0px" && cs.borderTopStyle !== "none") borders++;
        if (cs.borderBottomWidth !== "0px" && cs.borderBottomStyle !== "none") borders++;
        // Accent-colored elements (background or text color equals the resolved --accent)
        const bg = cs.backgroundColor, fg = cs.color;
        if (accent && (bg === accent || fg === accent)) {
          const cls = (e.getAttribute("class") ?? "").split(" ")[0];
          if (!accentEls.includes(cls)) accentEls.push(cls);
        }
      });
      const out = {
        vw, docW,
        noHScroll: docW <= vw + 1,
        fontSizes: [...fontSizes].sort(),
        bordersFirstScreen: borders,
        accentEls,
      };
      const pre = document.createElement("pre");
      pre.id = "audit";
      pre.style.display = "none";
      pre.textContent = JSON.stringify(out);
      document.body.appendChild(pre);
    } catch (e) {
      const pre = document.createElement("pre");
      pre.id = "audit";
      pre.textContent = JSON.stringify({ error: String(e) });
      document.body.appendChild(pre);
    }
  }, 1500);
}
