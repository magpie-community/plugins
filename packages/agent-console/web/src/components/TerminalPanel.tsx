// Terminal panel (§8.6 + §7.5): multiple tabs, xterm.js + fit, attach snapshot, resize, kill confirmation.
// Binary frames: op 1=output (daemon→here), 2=input, 3=resize.
import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { useUi } from "../stores/ui";
import { useData } from "../stores/data";
import { ws } from "../main";
import { Icon } from "./Icons";
import { ConfirmDialog } from "./Dialog";
import { toast } from "./Toast";
import { errMsg, t as tr, tf } from "../i18n/index.js";
import "@xterm/xterm/css/xterm.css";
import { xtermTheme } from "../terminal/theme";

type TermInfo = { id: string; index: number; projectId: string; title: string; alive: boolean; simple?: boolean };

export function TerminalPanel() {
  const { projects, threads } = useData();
  const ui = useUi();
  const thread = threads.find((t) => t.id === ui.currentThreadId) ?? null;
  const project = thread
    ? projects.find((p) => p.id === thread.projectId)
    : projects.find((p) => p.id === ui.currentProjectId);
  const projectId = project?.id ?? null;

  const [terms, setTerms] = useState<TermInfo[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<TermInfo | null>(null);

  const refresh = useCallback(async () => {
    if (!projectId) { setTerms([]); return; }
    try {
      const list = (await ws.call("terminal.list", { projectId })) as TermInfo[];
      setTerms(list);
      setActive((a) => (a && list.some((t) => t.id === a) ? a : (list[0]?.id ?? null)));
    } catch {}
  }, [projectId]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Terminal exit push
  useEffect(() => {
    const unsub = ws.subscribe("terminals", (_ch, d) => {
      const ev = d as { type?: string; id?: string };
      if (ev?.type === "terminal.exit") {
        setTerms((l) => l.filter((t) => t.id !== ev.id));
        setActive((a) => (a === ev.id ? null : a));
      }
    });
    return unsub;
  }, []);

  const create = async () => {
    if (!projectId) return;
    try {
      const r = (await ws.call("terminal.create", { projectId, cols: 100, rows: 28 })) as { id: string };
      await refresh();
      setActive(r.id);
    } catch (e) {
      toast(tr("terminal.failNew") + errMsg(e), true);
    }
  };

  const kill = async (term: TermInfo) => {
    try {
      await ws.call("terminal.kill", { id: term.id });
      setTerms((l) => l.filter((x) => x.id !== term.id));
      setActive((a) => (a === term.id ? null : a));
    } catch (e) {
      toast(tr("terminal.failKill") + errMsg(e), true);
    }
  };

  if (!project) return <div className="pn-empty">{tr("panel.pickProject")}</div>;

  const activeTerm = terms.find((t) => t.id === active) ?? null;
  return (
    <>
      <div className="tm-tabs">
        {terms.map((t) => (
          <button
            key={t.id}
            className={`tm-tab${t.id === active ? " on" : ""}`}
            onClick={() => setActive(t.id)}
            title={t.title}
          >
            {t.title}
            <span className="tm-x" onClick={(e) => { e.stopPropagation(); setConfirm(t); }}>×</span>
          </button>
        ))}
        <button className="ibtn" title={tr("terminal.new")} onClick={() => void create()}><Icon name="plus" size={14} /></button>
      </div>
      {activeTerm?.simple && <div className="tm-note">{tr("terminal.simpleNote")}</div>}
      <div className="tm-body">
        {terms.length === 0 && (
          <div className="pn-empty">
            {tr("terminal.noTerm")}
            <div style={{ marginTop: 8 }}>
              <button className="btn primary" onClick={() => void create()}>{tr("terminal.new")}</button>
            </div>
          </div>
        )}
        {terms.map((t) => (
          <TermView key={t.id} term={t} visible={t.id === active} />
        ))}
      </div>
      {confirm && (
        <ConfirmDialog
          title={tr("terminal.closeTitle")}
          body={tf("terminal.closeBody", { title: confirm.title })}
          okLabel={tr("terminal.closeOk")}
          danger
          onOk={() => void kill(confirm)}
          onClose={() => setConfirm(null)}
        />
      )}
    </>
  );
}

function TermView({ term, visible }: { term: TermInfo; visible: boolean }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [attached, setAttached] = useState(false);

  // Mount once: xterm + fit + attach snapshot + output frames + input
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const xterm = new Terminal({
      // Monospace fonts for Windows / macOS / Linux, followed by each platform's Chinese font
      fontFamily:
        '"Cascadia Mono", "Cascadia Code", Consolas, "SF Mono", Menlo, Monaco, "DejaVu Sans Mono", "Ubuntu Mono", ' +
        '"Microsoft YaHei UI", "PingFang SC", "Noto Sans Mono CJK SC", monospace',
      fontSize: 13,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 5000,
      allowTransparency: false,
      theme: xtermTheme(),
    });
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    xterm.open(host);
    termRef.current = xterm;
    fitRef.current = fit;
    try { fit.fit(); } catch {}

    const dec = new TextDecoder();
    const enc = new TextEncoder();
    const offBin = ws.onBinaryFrame((op, index, payload) => {
      if (index !== term.index || op !== 1) return;
      xterm.write(dec.decode(payload));
    });
    xterm.onData((d) => ws.sendBinary(2, term.index, enc.encode(d)));

    // attach returns the snapshot (and completes the subscription)
    void (async () => {
      try {
        const r = (await ws.call("terminal.attach", { id: term.id })) as {
          snapshot?: string;
          windowsPty?: { backend: "conpty"; buildNumber: number };
        };
        if (r.windowsPty) xterm.options.windowsPty = r.windowsPty;
        if (r.snapshot) xterm.write(r.snapshot);
        setAttached(true);
      } catch {
        xterm.writeln(tr("terminal.ended"));
      }
    })();

    return () => {
      offBin();
      xterm.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [term.id, term.index]);

  // Sync xterm colors when switching light/dark theme
  useEffect(() => {
    const el = document.documentElement;
    const sync = () => {
      const xt = termRef.current;
      if (xt) xt.options.theme = xtermTheme();
    };
    const obs = new MutationObserver(sync);
    obs.observe(el, { attributes: true, attributeFilter: ["data-theme"] });
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", sync);
    return () => {
      obs.disconnect();
      mq.removeEventListener("change", sync);
    };
  }, []);

  // Visibility/size change → fit + resize frame
  useEffect(() => {
    if (!visible) return;
    const fit = fitRef.current;
    const xterm = termRef.current;
    if (!fit || !xterm || !attached) return;
    const t = setTimeout(() => {
      try {
        fit.fit();
        const enc = new TextEncoder();
        ws.sendBinary(3, term.index, enc.encode(JSON.stringify({ cols: xterm.cols, rows: xterm.rows })));
      } catch {}
    }, 50);
    return () => clearTimeout(t);
  }, [visible, attached, term.index]);

  // ResizeObserver: fit + resize automatically when the container size changes
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ro = new ResizeObserver(() => {
      const fit = fitRef.current;
      const xterm = termRef.current;
      if (!fit || !xterm || !visible) return;
      try {
        fit.fit();
        const enc = new TextEncoder();
        ws.sendBinary(3, term.index, enc.encode(JSON.stringify({ cols: xterm.cols, rows: xterm.rows })));
      } catch {}
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, [visible, term.index]);

  return <div className="tm-view" ref={hostRef} style={{ display: visible ? "block" : "none" }} />;
}
