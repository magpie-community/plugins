// Project/conversation/provider store: initial fetch + incremental updates from the sidebar channel.
import { create } from "zustand";
import type { WsClient } from "../api/ws";
import type { Project, ThreadMeta, ProviderInfo, SidebarEvt } from "../types/models";
import { useUi } from "./ui.js";

type DataStore = {
  ws: WsClient | null;
  loaded: boolean;
  projects: Project[];
  threads: ThreadMeta[];
  providers: ProviderInfo[];

  bind(ws: WsClient): Promise<void>;
  upsertProject(p: Project): void;
  upsertThread(t: ThreadMeta): void;
};

// Default Agent choice: settings.defaultProvider if usable, otherwise the first usable one.
// providers.list is slow (codex detection takes seconds); fetch it once directly when the store is empty.
// New conversations don't wait for providers.list: until the list arrives use the default Agent from settings (the daemon validates again)
export async function pickDefaultProvider(): Promise<string> {
  let defId = "claude";
  try {
    const s = (await useData.getState().ws!.call("settings.get")) as { defaultProvider?: string };
    defId = s.defaultProvider ?? "claude";
  } catch {}
  const plist = useData.getState().providers;
  if (!plist.length) return defId;
  return (
    plist.find((p) => p.id === defId && providerPickOk(p))?.id ??
    plist.find((p) => providerPickOk(p))?.id ??
    defId
  );
}

function providerPickOk(p: ProviderInfo): boolean {
  if (p.enabled === false || !p.available) return false;
  if (p.status === "planned") return false;
  if (p.status === "verified" || p.status === "experimental") return true;
  return p.ready !== false;
}

export const useData = create<DataStore>((set, get) => ({
  ws: null,
  loaded: false,
  projects: [],
  threads: [],
  providers: [],

  bind: async (ws) => {
    if (get().ws === ws && get().loaded) return;
    set({ ws });
    // Subscribe to sidebar before fetching the snapshot: providers.list may take seconds (codex detection) and no events may be missed meanwhile
    ws.subscribe("sidebar", (_ch, d) => {
      const ev = d as SidebarEvt;
      if (!ev || typeof ev !== "object") return;
      if (ev.type === "project.upsert") get().upsertProject(ev.project);
      else if (ev.type === "project.remove") {
        set({ projects: get().projects.filter((p) => p.id !== ev.id) });
        useUi.getState().reconcileSelection(get().projects, get().threads);
      } else if (ev.type === "thread.upsert") get().upsertThread(ev.thread);
      else if (ev.type === "thread.remove") {
        set({ threads: get().threads.filter((t) => t.id !== ev.id) });
        useUi.getState().reconcileSelection(get().projects, get().threads);
      }
    });
    // providers.list may take seconds (the first time it starts each CLI): update it separately and asynchronously so projects/conversations show right away
    void (ws.call("providers.list") as Promise<ProviderInfo[]>)
      .then((providers) => set({ providers }))
      .catch(() => {});
    const [projects, threads] = await Promise.all([
      ws.call("projects.list") as Promise<Project[]>,
      ws.call("threads.list") as Promise<ThreadMeta[]>,
    ]);
    // Merge: entities upserted while fetching must not be overwritten by the older snapshot
    const cur = get();
    const projMap = new Map(projects.map((p) => [p.id, p] as const));
    for (const p of cur.projects) projMap.set(p.id, p);
    const thMap = new Map(threads.map((t) => [t.id, t] as const));
    for (const t of cur.threads) thMap.set(t.id, t);
    set({
      projects: [...projMap.values()].sort((a, b) => a.createdAt - b.createdAt),
      threads: [...thMap.values()],
      loaded: true,
    });
    useUi.getState().reconcileSelection(get().projects, get().threads);
  },
  upsertProject: (p) => {
    const list = get().projects.filter((x) => x.id !== p.id);
    set({ projects: [...list, p].sort((a, b) => a.createdAt - b.createdAt) });
  },
  upsertThread: (t) => {
    const list = get().threads.filter((x) => x.id !== t.id);
    set({ threads: [...list, t] });
  },
}));
