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
    "notice.acpImageByPath": "{agent} 不能直接看图片（它的 ACP 初始化未声明支持图片输入），已改为发送图片的文件路径：{paths}",
    "notice.acpImageByPathSwitched": "{agent} 是在另一个模型上启动的，只对那个模型接收图片，这次改为发送图片的文件路径（当前模型能看图时它会用 read_image 打开）：{paths}",
    "notice.acpSessionNotRestored": "{agent} 不能恢复上一轮对话（它的 ACP 既不支持 session/load 也不支持 session/resume），已新开一轮；先前的上下文不会带回。",
    "notice.attachmentIssue": "附件问题：{detail}",
    "claude.notFound": "找不到 claude（{detail}）。本插件不附带 Claude Code，请先安装：{hint}",
    "claude.startFailed": "无法启动 claude：{detail}",
    "claude.exited": "claude 进程意外退出（{code}）",
    "claude.notRunning": "claude 没有在运行，消息未发出",
    "claude.closed": "会话已关闭",
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
    "notice.acpImageByPath": "{agent} can't see images directly (its ACP initialize doesn't advertise image input); sent the image file path instead: {paths}",
    "notice.acpImageByPathSwitched": "{agent} was started on another model and takes image blocks only for that one, so the image went as its file path (it opens it with read_image when this model sees images): {paths}",
    "notice.acpSessionNotRestored": "{agent} can't restore the previous conversation (its ACP advertises neither session/load nor session/resume); started a new one — prior context won't come back.",
    "notice.attachmentIssue": "Attachment issue: {detail}",
    "claude.notFound": "claude was not found ({detail}). Claude Code is not bundled with this plugin; install it first: {hint}",
    "claude.startFailed": "Could not start claude: {detail}",
    "claude.exited": "claude exited unexpectedly ({code})",
    "claude.notRunning": "claude is not running; the message was not sent",
    "claude.closed": "The session is closed",
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
