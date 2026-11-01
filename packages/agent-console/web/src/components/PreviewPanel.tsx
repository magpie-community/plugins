// Preview tab (1.2): a light browser for local dev URLs. The page loads through the daemon's preview proxy
// (preview/proxy.ts): inside Magpie the frame is sandboxed and opaque, and a direct iframe of localhost breaks module scripts,
// fetch and storage. Back/forward/reload go through the injected bridge when the page has it, else through our own URL stack.
// Messages from the frame are only read when they come from this iframe and carry {ac_preview:1, href, title}; they only
// update the address bar and title. The parent page's history is never touched (it is Magpie's whole window).
import { useEffect, useRef, useState } from "react";
import { ws } from "../main";
import { useUi, PN_MAX } from "../stores/ui";
import { useData } from "../stores/data";
import { usePreview, threadKey, addressText } from "../stores/preview";
import { checkPreviewUrl, displayHref, externalHref } from "../../../daemon/src/preview/url.js";
import { openExternal } from "../preview/open";
import { localizeDaemonMessage, t } from "../i18n/index.js";
import { Icon } from "./Icons";
import { maxPanelWidth } from "../layout/bounds";

const call = (m: string, p?: unknown) => ws.call(m, p);

export function PreviewPanel() {
  const ui = useUi();
  const threads = useData((s) => s.threads);
  const threadId = ui.currentThreadId;
  const key = threadKey(threadId);
  const entry = usePreview((s) => s.byThread[key]);
  const thread = threads.find((x) => x.id === threadId) ?? null;
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [addr, setAddr] = useState("");
  const [editing, setEditing] = useState(false);
  const [bad, setBad] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Restore this conversation's last URL (or re-open the proxy after a release)
  useEffect(() => {
    const st = usePreview.getState();
    const cur = st.byThread[key];
    if (cur && cur.proxyHref) return;
    const url = cur?.url ?? thread?.previewUrl ?? null;
    if (url) void st.navigate(call, key, threadId, url, { push: false });
  }, [key, threadId, thread?.previewUrl]);

  // Leaving the tab / the conversation: let the proxy go (it is re-opened when the tab shows this URL again)
  const origin = entry?.origin;
  const proxied = !!entry?.proxyOrigin;
  useEffect(() => {
    if (!origin || !proxied) return;
    return () => {
      // another conversation may show the same target right now: only release when none does
      const st = usePreview.getState();
      const nowKey = threadKey(useUi.getState().currentThreadId);
      const stillShown = useUi.getState().panelOpen && useUi.getState().panelTab === "preview" && st.byThread[nowKey]?.origin === origin && nowKey !== key;
      st.detach(key);
      if (!stillShown) void ws.call("preview.release", { url: origin }).catch(() => {});
    };
  }, [origin, proxied, key]);

  // Address bar follows the page unless the user is typing
  useEffect(() => {
    if (!editing) setAddr(entry ? addressText(entry.url) : "");
  }, [entry?.url, editing]);

  // Navigation bridge messages from our iframe only
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const win = frameRef.current?.contentWindow;
      if (!win || e.source !== win) return;
      const d = e.data as { ac_preview?: unknown; href?: unknown; title?: unknown };
      if (!d || typeof d !== "object" || d.ac_preview !== 1 || typeof d.href !== "string") return;
      const cur = usePreview.getState().byThread[key];
      if (!cur?.proxyOrigin) return;
      const shown = displayHref(d.href.slice(0, 2048), cur.proxyOrigin, cur.origin);
      const c = checkPreviewUrl(shown);
      if (!c.ok || c.target.origin !== cur.origin) return;
      const title = typeof d.title === "string" ? d.title.slice(0, 200) : "";
      usePreview.getState().reported(key, c.target.href, title);
      // remember in-page navigation on the conversation (debounced)
      if (threadId && c.target.href !== cur.url) {
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => void ws.call("threads.update", { id: threadId, previewUrl: c.target.href }).catch(() => {}), 800);
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [key, threadId]);

  const go = (raw: string) => {
    const v = raw.trim();
    if (!v) return;
    const c = checkPreviewUrl(v);
    if (!c.ok) {
      setBad(v);
      return;
    }
    setBad(null);
    setEditing(false);
    void usePreview.getState().navigate(call, key, threadId, c.target.href, { push: true });
  };

  const post = (cmd: "back" | "forward" | "reload") => {
    try { frameRef.current?.contentWindow?.postMessage({ ac_preview_cmd: cmd }, "*"); } catch {}
  };
  const back = () => {
    if (entry?.bridged) return post("back");
    const u = usePreview.getState().step(key, -1);
    if (u) void usePreview.getState().navigate(call, key, threadId, u, { push: false });
  };
  const forward = () => {
    if (entry?.bridged) return post("forward");
    const u = usePreview.getState().step(key, 1);
    if (u) void usePreview.getState().navigate(call, key, threadId, u, { push: false });
  };
  const reload = () => {
    if (!entry) return;
    if (entry.error || !entry.proxyHref) {
      void usePreview.getState().navigate(call, key, threadId, entry.url, { push: false });
      return;
    }
    if (entry.bridged) post("reload");
    else usePreview.getState().reload(key);
  };

  const canBack = !!entry && (entry.bridged || entry.idx > 0);
  const canFwd = !!entry && (entry.bridged || entry.idx < entry.stack.length - 1);
  const external = entry ? externalHref(entry.url) : null;
  const badExternal = bad ? externalHref(/^[a-z][a-z0-9+.-]*:\/\//i.test(bad) ? bad : `https://${bad}`) : null;
  const widen = () => ui.setPanelWidth(Math.min(PN_MAX, maxPanelWidth({ ...useUi.getState(), panelOpen: true })));

  return (
    <div className="pv">
      <div className="pv-bar">
        <button type="button" className="ibtn" title={t("preview.back")} aria-label={t("preview.back")} disabled={!canBack} onClick={back}><Icon name="arrowLeft" size={15} /></button>
        <button type="button" className="ibtn" title={t("preview.forward")} aria-label={t("preview.forward")} disabled={!canFwd} onClick={forward}><Icon name="arrowRight" size={15} /></button>
        <button type="button" className="ibtn" title={t("preview.reload")} aria-label={t("preview.reload")} disabled={!entry} onClick={reload}><Icon name="refresh" size={14} /></button>
        <input
          className={`pv-addr${bad ? " err" : ""}`}
          value={addr}
          spellCheck={false}
          placeholder={t("preview.placeholder")}
          aria-label={t("preview.address")}
          onFocus={(e) => { setEditing(true); e.currentTarget.select(); }}
          onBlur={() => { setEditing(false); }}
          onChange={(e) => { setAddr(e.target.value); if (bad) setBad(null); }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter") { e.preventDefault(); go(addr); }
            else if (e.key === "Escape") { setEditing(false); setBad(null); setAddr(entry ? addressText(entry.url) : ""); (e.target as HTMLInputElement).blur(); }
          }}
        />
        <button type="button" className="ibtn" title={t("preview.openExternal")} aria-label={t("preview.openExternal")} disabled={!external} onClick={() => external && void openExternal(external)}><Icon name="external" size={14} /></button>
        <button type="button" className="ibtn" title={t("preview.widen")} aria-label={t("preview.widen")} onClick={widen}><Icon name="widen" size={15} /></button>
      </div>
      {bad && (
        <div className="pv-note err">
          <span>{t("preview.onlyLocal")}</span>
          {badExternal && <button type="button" className="btn" onClick={() => { void openExternal(badExternal); setBad(null); }}>{t("preview.openExternal")}</button>}
        </div>
      )}
      {entry?.error && (
        <div className="pv-note err">
          <span>{t("preview.failed")}{localizeDaemonMessage(entry.error)}</span>
          {external && <button type="button" className="btn" onClick={() => void openExternal(external)}>{t("preview.openExternal")}</button>}
          <button type="button" className="btn" onClick={reload}>{t("common.retry")}</button>
        </div>
      )}
      {!entry ? (
        <div className="pv-empty">
          <div>{t("preview.empty")}</div>
          <div className="pv-hint">{t("preview.limits")}</div>
        </div>
      ) : (
        <div className="pv-frame-wrap">
          {entry.loading && <div className="pv-loading" />}
          {entry.proxyHref && (
            <iframe
              key={`${entry.proxyOrigin}|${entry.nonce}`}
              ref={frameRef}
              className="pv-frame"
              title={entry.title || addressText(entry.url)}
              src={entry.proxyHref}
              referrerPolicy="no-referrer"
            />
          )}
        </div>
      )}
    </div>
  );
}
