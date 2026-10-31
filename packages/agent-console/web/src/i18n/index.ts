import { messages, type LocaleId, type MessageTree } from "./messages.js";

let locale: LocaleId = "zh";

/** Magpie / BCP47 → zh | en (other languages follow English for now) */
export function normalizeLang(raw: string | null | undefined): LocaleId {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return guessFromNavigator();
  if (s === "zh" || s.startsWith("zh-")) return "zh";
  return "en";
}

function guessFromNavigator(): LocaleId {
  const nav = typeof navigator !== "undefined" ? navigator.language : "";
  return normalizeLang(nav || "zh");
}

/** Called at startup: ?lang= comes from page/boot.js (Magpie theme.lang) */
export function initLocale(search: string): LocaleId {
  const q = new URLSearchParams(search).get("lang");
  locale = normalizeLang(q);
  const htmlLang = locale === "zh" ? "zh-CN" : "en";
  if (typeof document !== "undefined") document.documentElement.lang = htmlLang;
  return locale;
}

export function getLocale(): LocaleId {
  return locale;
}

export function getIntlLocale(): string {
  return locale === "zh" ? "zh-CN" : "en-US";
}

function getPath(tree: MessageTree, key: string): string | undefined {
  const parts = key.split(".");
  let cur: string | Record<string, unknown> = tree;
  for (const p of parts) {
    if (typeof cur !== "object" || cur == null || !(p in cur)) return undefined;
    cur = cur[p] as string | Record<string, unknown>;
  }
  return typeof cur === "string" ? cur : undefined;
}

/** Dotted key, e.g. sidebar.newProject */
export function t(key: string): string {
  return getPath(messages[locale], key) ?? getPath(messages.en, key) ?? key;
}

/** Replace {name} placeholders */
export function tf(key: string, params: Record<string, string | number>): string {
  let s = t(key);
  for (const [k, v] of Object.entries(params)) {
    s = s.replaceAll(`{${k}}`, String(v));
  }
  return s;
}

export function errMsg(e: unknown): string {
  const err = e as Error & { code?: string };
  const code = err?.code;
  if (code) {
    const mapped = t(`api.${code}`);
    if (mapped !== `api.${code}`) return mapped;
  }
  const msg = String(err?.message ?? e);
  return localizeDaemonMessage(msg);
}

export function localizeDaemonMessage(msg: string): string {
  if (locale === "zh") return msg;
  if (msg === "后台已重启，本轮已中断") return "Daemon restarted — this turn was interrupted";
  if (msg.startsWith("会话启动失败：")) return "Session start failed: " + msg.slice("会话启动失败：".length);
  if (msg.startsWith("发送失败：")) return "Send failed: " + msg.slice("发送失败：".length);
  if (msg === "Agent 进程意外退出") return "Agent process exited unexpectedly";
  const att = msg.match(/^附件不存在或已失效（(.+)），请重新上传$/);
  if (att) return `Attachment missing or expired (${att[1]}) — upload again`;
  return msg;
}

export function displayThreadTitle(title: string, titleAuto: boolean): string {
  if (titleAuto && (title === "新对话" || title === "New chat")) return t("thread.new");
  return title;
}
