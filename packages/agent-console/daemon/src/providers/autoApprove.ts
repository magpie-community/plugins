// 1.3 "全部自动同意" (full auto-approve): the permission chip's bypassPermissions mode, for every Agent.
//
// Where the Agent has its own switch we use it (see FULL_AUTO); the daemon also answers every tool approval the Agent
// still asks for while the mode is on, so Agents that only ask over their protocol (Cursor / OpenCode / dsh over ACP)
// stop asking too, and a card already on screen is approved the moment the user turns the mode on.
//
// The answer is always the option that covers this one request ("Allow once" / accept), never "Allow always":
// an allow-always answer can make the Agent write a permanent rule into the user's own config (Cursor's allowlist,
// OpenCode's permission file), which would outlive the mode. Questions and plan approvals are never auto-answered.
import type { Mode } from "./types.js";

export const FULL_AUTO: Mode = "bypassPermissions";

export type ApprovalOption = { id: string; label?: string; kind?: string };
export type ApprovalRequest = { kind?: string; options: ApprovalOption[] };

/** How full-auto works for each Agent (also the source of the plan's table) */
export const FULL_AUTO_NATIVE: Record<string, { native: string; live: "live" | "nextTurn" | "none"; daemonAnswers: boolean }> = {
  claude: { native: "--permission-mode bypassPermissions (+ --allow-dangerously-skip-permissions)", live: "nextTurn", daemonAnswers: true },
  codex: { native: "approvalPolicy never + sandbox danger-full-access (turn/start)", live: "nextTurn", daemonAnswers: true },
  cursor: { native: "none over ACP (--force is spawn-only); ACP mode agent", live: "live", daemonAnswers: true },
  copilot: { native: "ACP config allow_all = on (agent mode)", live: "live", daemonAnswers: true },
  opencode: { native: "none over ACP (OPENCODE_PERMISSION is spawn-only); ACP mode build", live: "live", daemonAnswers: true },
  devin: { native: "ACP mode bypass", live: "live", daemonAnswers: true },
  dsh: { native: "none known; ACP default mode", live: "live", daemonAnswers: true },
  // pi never asks before its own tools; requestPermission only carries Pi extensions' own dialogs, which stay with the user
  pi: { native: "always (Pi has no tool approvals)", live: "live", daemonAnswers: false },
  mock: { native: "mock", live: "live", daemonAnswers: true },
};

const REJECT = /reject|deny|decline|cancel|never|拒绝/i;
const ALLOW = /allow|accept|approve|yes|允许|同意/i;

/**
 * The option that allows just this request: kind allow_once, else an allow-looking id/label that is not "always" /
 * "session". Never allow_always (that writes a lasting rule into the Agent's own config): when a request offers
 * nothing narrower, null, and the card is left for the user.
 */
export function pickAllowOnce(options: ApprovalOption[]): ApprovalOption | null {
  const once = options.find((o) => o.kind === "allow_once");
  if (once) return once;
  const plain = options.find((o) => {
    const s = `${o.id} ${o.label ?? ""}`;
    return !o.kind?.startsWith("reject") && !REJECT.test(s) && ALLOW.test(s) && !/always|session|总是|始终/i.test(s);
  });
  return plain ?? null;
}

/** The daemon answers this request itself: the mode is full-auto, the Agent lets us, it is a tool approval and something allows it */
export function autoApproveOption(
  mode: Mode | null | undefined,
  providerId: string,
  req: ApprovalRequest,
): ApprovalOption | null {
  if (mode !== FULL_AUTO) return null;
  if (FULL_AUTO_NATIVE[providerId]?.daemonAnswers === false) return null;
  // A plan ("implement this plan?") is a decision, not a tool permission
  if (req.kind === "plan" || req.kind === "switch_mode") return null;
  return pickAllowOnce(req.options);
}
