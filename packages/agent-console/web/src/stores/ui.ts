// UI state: sidebar/panel widths and open state, narrow-screen drawers, current project/conversation.
// Preferences persist through settings.set (localStorage isn't available in the sandbox, §8.2).
import { create } from "zustand";
import type { WsClient } from "../api/ws.js";
import { clampLayoutWidths, maxPanelWidth, maxSidebarWidth } from "../layout/bounds.js";

export type PanelTab = "changes" | "files" | "terminal";

export type UiSettings = {
  sidebarWidth?: number;
  panel?: { open?: boolean; tab?: PanelTab; width?: number };
  collapsedProjects?: string[];
  lastProjectId?: string | null;
  lastThreadId?: string | null;
  [k: string]: unknown;
};

type UiStore = {
  ws: WsClient | null;
  sidebarWidth: number;
  sbHidden: boolean;      // Ctrl+B hides the whole column (wide screens)
  sbOpen: boolean;        // Narrow-screen drawer
  panelOpen: boolean;
  panelTab: PanelTab;
  panelWidth: number;
  collapsed: Record<string, boolean>;
  currentProjectId: string | null;
  currentThreadId: string | null;

  bind(ws: WsClient): void;
  hydrate(s: UiSettings): void;
  setSidebarWidth(w: number): void;
  setPanelWidth(w: number): void;
  openPanel(tab?: PanelTab): void;
  closePanel(): void;
  setPanelTab(tab: PanelTab): void;
  toggleSidebarHidden(): void;
  setSbOpen(open: boolean): void;
  toggleCollapsed(projectId: string): void;
  select(projectId: string | null, threadId: string | null): void;
  /** Correct lastProjectId / lastThreadId after the project/conversation lists load, so the UI never stays on an old conversation with no project */
  reconcileSelection(projects: { id: string }[], threads: { id: string; projectId: string }[]): void;
};

export const SB_MIN = 200, SB_MAX = 360, PN_MIN = 320, PN_MAX = 900;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function persist(get: () => UiStore, patch: Record<string, unknown>): void {
  const ws = get().ws;
  if (!ws) return;
  void ws.call("settings.set", { patch }).catch(() => {});
}

export const useUi = create<UiStore>((set, get) => ({
  ws: null,
  sidebarWidth: 248,
  sbHidden: false,
  sbOpen: false,
  panelOpen: false,
  panelTab: "changes",
  panelWidth: 440,
  collapsed: {},
  currentProjectId: null,
  currentThreadId: null,

  bind: (ws) => set({ ws }),
  hydrate: (s) => {
    const collapsed: Record<string, boolean> = {};
    for (const id of s.collapsedProjects ?? []) collapsed[id] = true;
    const draft = {
      sidebarWidth: s.sidebarWidth ?? 248,
      panelWidth: s.panel?.width ?? 440,
      panelOpen: s.panel?.open ?? false,
      sbHidden: false,
    };
    const sized = clampLayoutWidths(draft);
    set({
      sidebarWidth: sized.sidebarWidth,
      panelOpen: draft.panelOpen,
      panelTab: s.panel?.tab ?? "changes",
      panelWidth: sized.panelWidth,
      collapsed,
      currentProjectId: s.lastProjectId ?? null,
      currentThreadId: s.lastThreadId ?? null,
    });
  },
  setSidebarWidth: (w) => {
    const s = get();
    const hi = maxSidebarWidth(s);
    w = clamp(Math.round(w), SB_MIN, hi);
    set({ sidebarWidth: w });
    persist(get, { sidebarWidth: w });
  },
  setPanelWidth: (w) => {
    const s = get();
    const hi = maxPanelWidth(s);
    w = clamp(Math.round(w), PN_MIN, hi);
    set({ panelWidth: w });
    persist(get, { panel: { open: get().panelOpen, tab: get().panelTab, width: w } });
  },
  openPanel: (tab) => {
    const t = tab ?? get().panelTab;
    const s = get();
    const w = clamp(s.panelWidth, PN_MIN, maxPanelWidth({ ...s, panelOpen: true }));
    set({ panelOpen: true, panelTab: t, panelWidth: w });
    persist(get, { panel: { open: true, tab: t, width: w } });
  },
  closePanel: () => {
    set({ panelOpen: false });
    persist(get, { panel: { open: false, tab: get().panelTab, width: get().panelWidth } });
  },
  setPanelTab: (tab) => {
    set({ panelTab: tab });
    persist(get, { panel: { open: get().panelOpen, tab, width: get().panelWidth } });
  },
  toggleSidebarHidden: () => set((s) => ({ sbHidden: !s.sbHidden })),
  setSbOpen: (open) => set({ sbOpen: open }),
  toggleCollapsed: (projectId) => {
    const collapsed = { ...get().collapsed };
    if (collapsed[projectId]) delete collapsed[projectId];
    else collapsed[projectId] = true;
    set({ collapsed });
    persist(get, { collapsedProjects: Object.keys(collapsed) });
  },
  select: (projectId, threadId) => {
    set({ currentProjectId: projectId, currentThreadId: threadId, sbOpen: false });
    persist(get, { lastProjectId: projectId, lastThreadId: threadId });
  },
  reconcileSelection: (projects, threads) => {
    const { currentProjectId, currentThreadId } = get();
    if (projects.length === 0) {
      if (currentProjectId || currentThreadId) get().select(null, null);
      return;
    }
    let pid = currentProjectId;
    if (!pid || !projects.some((p) => p.id === pid)) pid = null;
    let tid = currentThreadId;
    if (tid) {
      const th = threads.find((x) => x.id === tid);
      if (!th || !projects.some((p) => p.id === th.projectId)) tid = null;
      else if (pid && th.projectId !== pid) tid = null;
      else if (!pid) pid = th.projectId;
    }
    if (pid !== currentProjectId || tid !== currentThreadId) get().select(pid, tid);
  },
}));
