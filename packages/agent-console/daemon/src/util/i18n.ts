/** Same as the frontend's normalizeLang */
export type AppLocale = "zh" | "en";

let locale: AppLocale = "zh";

export function normalizeLang(raw: string | null | undefined): AppLocale {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return "zh";
  if (s === "zh" || s.startsWith("zh-")) return "zh";
  return "en";
}

export function setAppLocale(lang: string | undefined): void {
  locale = normalizeLang(lang);
}

export function getAppLocale(): AppLocale {
  return locale;
}

export function intlLocale(): string {
  return locale === "zh" ? "zh-CN" : "en-US";
}

const dict: Record<AppLocale, Record<string, string>> = {
  zh: {
    "thread.defaultTitle": "新对话",
    "notice.daemonRestart": "后台已重启，本轮已中断",
    "notice.sessionStartFailed": "会话启动失败：{detail}",
    "notice.sendFailed": "发送失败：{detail}",
    "notice.effortNextTurn": "思考强度已保存，将在下一轮生效",
    "notice.effortResetOnModel": "当前模型不支持该思考强度，已恢复为 Default",
    "turn.agentExit": "Agent 进程意外退出",
    "attachment.missing": "附件不存在或已失效（{ref}），请重新上传",
    "export.defaultModel": "默认",
  },
  en: {
    "thread.defaultTitle": "New chat",
    "notice.daemonRestart": "Daemon restarted — this turn was interrupted",
    "notice.sessionStartFailed": "Session start failed: {detail}",
    "notice.sendFailed": "Send failed: {detail}",
    "notice.effortNextTurn": "Reasoning effort saved — takes effect on the next turn",
    "notice.effortResetOnModel": "This model does not support that effort level; reset to Default",
    "turn.agentExit": "Agent process exited unexpectedly",
    "attachment.missing": "Attachment missing or expired ({ref}) — upload again",
    "export.defaultModel": "Default",
  },
};

export function tr(key: string, params?: Record<string, string | number>): string {
  let s = dict[locale][key] ?? dict.en[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, String(v));
  }
  return s;
}
