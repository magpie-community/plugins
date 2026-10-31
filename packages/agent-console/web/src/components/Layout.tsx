// Three-column layout shell: sidebar | drag handle | main | drag handle | right panel (§8.5).
// Narrow-screen breakpoints live in layout.css (<900 panel drawer, <760 sidebar drawer); this only handles state and dragging.
// Whether a drawer counts as an overlay is decided by matchMedia breakpoints (not clientWidth, to avoid transient jitter).
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useUi, SB_MIN, PN_MIN } from "../stores/ui";
import { maxPanelWidth, maxSidebarWidth, clampLayoutWidths } from "../layout/bounds";

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function useMedia(query: string): boolean {
  const [on, setOn] = useState(() => window.matchMedia?.(query).matches ?? false);
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return;
    const fn = () => setOn(mq.matches);
    mq.addEventListener?.("change", fn);
    fn();
    return () => mq.removeEventListener?.("change", fn);
  }, [query]);
  return on;
}

function useColumnDrag(
  getBase: () => number,
  apply: (base: number, dx: number) => void,
  commit: () => void,
) {
  const startX = useRef(0);
  const base = useRef(0);
  const [drag, setDrag] = useState(false);
  const down = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      startX.current = e.clientX;
      base.current = getBase();
      setDrag(true);
      document.body.classList.add("col-drag");
      const move = (ev: PointerEvent) => apply(base.current, ev.clientX - startX.current);
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        document.body.classList.remove("col-drag");
        setDrag(false);
        commit();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [getBase, apply, commit],
  );
  return { drag, down };
}

export function Layout({
  sidebar,
  topbar,
  children,
  panel,
}: {
  sidebar: ReactNode;
  topbar: ReactNode;
  children: ReactNode;
  panel: ReactNode;
}) {
  const ui = useUi();
  const sbDrawer = useMedia("(max-width: 759px)"); // Sidebar drawer breakpoint
  const pnDrawer = useMedia("(max-width: 899px)"); // Panel drawer breakpoint
  const sbDragged = useRef(false);
  const pnDragged = useRef(false);

  const sbDrag = useColumnDrag(
    useCallback(() => useUi.getState().sidebarWidth, []),
    useCallback((base, dx) => {
      sbDragged.current = true;
      const s = useUi.getState();
      const hi = maxSidebarWidth(s);
      useUi.setState({ sidebarWidth: clamp(Math.round(base + dx), SB_MIN, hi) });
    }, []),
    useCallback(() => {
      if (!sbDragged.current) return;
      sbDragged.current = false;
      useUi.getState().setSidebarWidth(useUi.getState().sidebarWidth);
    }, []),
  );
  const pnDrag = useColumnDrag(
    useCallback(() => useUi.getState().panelWidth, []),
    useCallback((base, dx) => {
      pnDragged.current = true;
      const s = useUi.getState();
      const hi = maxPanelWidth(s);
      useUi.setState({ panelWidth: clamp(Math.round(base - dx), PN_MIN, hi) });
    }, []),
    useCallback(() => {
      if (!pnDragged.current) return;
      pnDragged.current = false;
      useUi.getState().setPanelWidth(useUi.getState().panelWidth);
    }, []),
  );

  // Shortcuts: Ctrl+B sidebar, Ctrl+J panel (§8.7; inside inputs/dialogs/terminals only Ctrl+K/B/J are intercepted)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === "b") {
        e.preventDefault();
        const s = useUi.getState();
        if (window.matchMedia("(max-width: 759px)").matches) s.setSbOpen(!s.sbOpen);
        else s.toggleSidebarHidden();
      } else if (k === "j") {
        e.preventDefault();
        const s = useUi.getState();
        if (s.panelOpen) s.closePanel();
        else s.openPanel();
      }
      // The Ctrl+K command palette is handled by P2-6
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Sync width changes to CSS variables
  useEffect(() => {
    document.documentElement.style.setProperty("--sb-w", `${ui.sidebarWidth}px`);
  }, [ui.sidebarWidth]);
  useEffect(() => {
    document.documentElement.style.setProperty("--pn-w", `${ui.panelWidth}px`);
  }, [ui.panelWidth]);

  // Shrink the sidebar/panel when the window narrows so the conversation in the middle isn't squeezed into a vertical column of characters
  useEffect(() => {
    const sync = () => {
      const s = useUi.getState();
      const sized = clampLayoutWidths(s);
      if (sized.sidebarWidth !== s.sidebarWidth) {
        useUi.getState().setSidebarWidth(sized.sidebarWidth);
      }
      if (sized.panelWidth !== s.panelWidth) {
        useUi.getState().setPanelWidth(sized.panelWidth);
      }
    };
    window.addEventListener("resize", sync);
    sync();
    return () => window.removeEventListener("resize", sync);
  }, []);

  const scrim = ui.sbOpen || (ui.panelOpen && pnDrawer);
  return (
    <div className="app">
      <aside
        className={`sidebar${ui.sbHidden && !sbDrawer ? " w-hide" : ""}${ui.sbOpen ? " open" : ""}`}
      >
        {sidebar}
      </aside>
      <div className={`rs rs-l${sbDrag.drag ? " drag" : ""}`} onPointerDown={sbDrag.down} />
      <main className="main">
        {topbar}
        {children}
      </main>
      <div className={`rs rs-r${pnDrag.drag ? " drag" : ""}`} onPointerDown={pnDrag.down} />
      <section className={`panel${ui.panelOpen ? " open" : " w-hide"}`} aria-hidden={!ui.panelOpen}>
        {panel}
      </section>
      <div
        className={`scrim${scrim ? " show" : ""}`}
        onClick={() => {
          useUi.getState().setSbOpen(false);
          if (useUi.getState().panelOpen && pnDrawer) useUi.getState().closePanel();
        }}
      />
    </div>
  );
}
