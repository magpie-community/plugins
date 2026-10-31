// How an ACP Agent reopens an old conversation: initialize → agentCapabilities.
// - loadSession (top-level): session/load — returns prior messages as session/update
// - sessionCapabilities.resume: session/resume — reconnects without replaying history
// Prefer load when both are advertised (OpenCode); resume when only resume (dsh);
// neither → the caller starts a new session and tells the user prior context wasn't restored.
export type AcpSessionOpen = { load: boolean; resume: boolean };
export type AcpReconnect = "load" | "resume" | "none";

/** Normalize an initialize response: missing/false/null means the Agent doesn't advertise that method */
export function sessionOpenFromInitialize(res: unknown): AcpSessionOpen {
  const caps = (res as { agentCapabilities?: {
    loadSession?: unknown;
    sessionCapabilities?: { resume?: unknown } | null;
  } | null } | null)?.agentCapabilities;
  // ACP: omitted or null = no; {} (any object) = yes
  const resume = caps?.sessionCapabilities?.resume != null && typeof caps.sessionCapabilities.resume === "object";
  return { load: caps?.loadSession === true, resume };
}

export function pickReconnect(open: AcpSessionOpen): AcpReconnect {
  if (open.load) return "load";
  if (open.resume) return "resume";
  return "none";
}
