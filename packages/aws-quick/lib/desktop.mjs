// Fields the AWS Quick 1.2.4660 desktop renderer stamps on the chat socket.
// Source: renderer startup bundle, connection function Gx plus helpers tf/nf/rl.
//
// URL (social / AIDP, token stays in the query — enterprise is the only arm
// that moves it to Authorization):
//   wss://<wsHost>/streaming/quickwork-chat-bidirectional-stream
//     ?surfaceType=QUICK_WORK_DESKTOP_WINDOWS
//     &token=<id_token>
//     &outpostId=<device id>          // always present, even when empty
//     &workingSessionId=<uuid>        // one id for the life of the client
//     &channel=prod|beta
//
// session_connect payload is { actor_id, ...tf(), ...nf() }.
// tf() (cloud mode, set before the frame is sent): surfaceType, appVersion,
// outpostId only when non-empty.
// nf() (cloud mode): the capability ack integers below.
// Application ping is every 45s ({type:ping, payload:{timestamp}}).
// The desktop then sends federate_status. Social login has no federate user.

export const APP_VERSION = '1.2.4660'
export const SURFACE = 'QUICK_WORK_DESKTOP_WINDOWS'
export const PING_MS = 45_000

export function capabilityFlags() {
  return {
    acp_first_text: 1,
    user_notification: 1,
    subtask_progress: 1,
    external_agent_sign_in: 1,
    recents_promotion: 1,
  }
}

/** tf() + nf() for one desktop client. */
export function clientFields({ surfaceType = SURFACE, appVersion = APP_VERSION, outpostId = '' } = {}) {
  const fields = {
    surfaceType,
    appVersion,
    ...capabilityFlags(),
  }
  if (outpostId) fields.outpostId = outpostId
  return fields
}
