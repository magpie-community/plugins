// What each ACP Agent says it accepts in a prompt: initialize → agentCapabilities.promptCapabilities.
// ACP's baseline is text and resource_link; image / audio / embedded resources are opt-in per Agent.
// Learned from the model probe (startup warm-up, providers.list) and from every session's initialize,
// kept in memory per provider id, and read by the provider's capabilities (images) and by AcpSession.send.
export type AcpPromptCaps = { image: boolean; audio: boolean; embeddedContext: boolean };

const learned = new Map<string, AcpPromptCaps>();

/** Normalize an initialize response (anything: Agents may leave fields out, which means false) */
export function promptCapsFromInitialize(res: unknown): AcpPromptCaps {
  const pc = (res as { agentCapabilities?: { promptCapabilities?: Record<string, unknown> | null } | null } | null)
    ?.agentCapabilities?.promptCapabilities;
  return {
    image: pc?.image === true,
    audio: pc?.audio === true,
    embeddedContext: pc?.embeddedContext === true,
  };
}

export function rememberPromptCaps(providerId: string | undefined, caps: AcpPromptCaps): void {
  if (providerId) learned.set(providerId, caps);
}

/** undefined until the Agent has been probed or a session has initialized */
export function knownPromptCaps(providerId: string): AcpPromptCaps | undefined {
  return learned.get(providerId);
}

export function forgetPromptCaps(providerId?: string): void {
  if (providerId) learned.delete(providerId);
  else learned.clear();
}
