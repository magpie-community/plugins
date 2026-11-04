// Opening links from chat (1.2): local addresses go to the Preview tab, everything http(s) else to the system browser
// (the sandboxed page can't open popups, so target=_blank did nothing). Only a user's click gets here.
import { ws } from "../main";
import { useUi } from "../stores/ui";
import { usePreview, threadKey } from "../stores/preview";
import { localHref } from "../util/localLinks";
import { copyText } from "../components/Markdown";
import { toast } from "../components/Toast";
import { t } from "../i18n/index.js";

export function openPreview(url: string): void {
  const ui = useUi.getState();
  const threadId = ui.currentThreadId;
  ui.openPanel("preview");
  void usePreview.getState().navigate((m, p) => ws.call(m, p), threadKey(threadId), threadId, url, { push: true });
}

export async function openExternal(url: string): Promise<void> {
  try {
    const r = (await ws.call("app.openExternal", { url })) as { ok?: boolean };
    if (r?.ok) return;
  } catch {}
  await copyText(url);
  toast(t("links.externalFailed"));
}

/** Delegated click handler for chat content: handles <a> clicks, never lets the frame navigate away */
export function onChatLinkClick(e: React.MouseEvent | MouseEvent): void {
  const target = e.target as HTMLElement | null;
  const a = target?.closest?.("a");
  if (!a) return;
  const href = a.getAttribute("href") ?? "";
  e.preventDefault();
  const local = (a as HTMLElement).dataset.acLocal || localHref(href);
  const modified = e.ctrlKey || e.metaKey;
  if (local && !modified) {
    openPreview(local);
    return;
  }
  if (/^https?:\/\//i.test(local || href)) void openExternal(local || href);
}
