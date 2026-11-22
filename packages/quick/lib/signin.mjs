// The one-click sign-in's authorize(): opens the plugin's own browser on
// quick.aws.com, reads the session cookies over CDP (the moss module's
// pattern), discovers the account id and csrf from the session itself, and
// verifies the account with the same probe a paste goes through. The host's
// authorize call has a short deadline, so the browser work runs in the
// callback.
import { signInWithBrowser, requireBrowser } from "./browser.mjs"
import { discoverAccount, importAccount } from "./session.mjs"

export async function browserAuthorize() {
  // the browser is checked before the host is told a window opened: a
  // machine with none fails here, with the paste method as the way out
  try {
    requireBrowser()
  } catch (e) {
    return { type: "failed", error: e?.message ?? String(e) }
  }
  return {
    url: "",
    opened: true,
    method: "auto",
    instructions:
      process.platform === "win32"
        ? "A browser window opens on quick.aws.com. Sign in there (or it may already be signed in from a previous run); the plugin reads the session by itself and closes the window. You do not need to close it."
        : "A browser window opens on quick.aws.com. Sign in there (or it may already be signed in from a previous run); the plugin watches the profile and closes the window itself. You can leave the window open.",
    async callback() {
      let cookie
      try {
        cookie = await signInWithBrowser({})
      } catch (e) {
        if (e?.cancelled) return { type: "failed", error: "the sign-in was cancelled" }
        return { type: "failed", error: `Quick sign-in: ${e?.message ?? e}` }
      }
      // the cookies → the account id + csrf, from the session itself
      let account
      try {
        account = await discoverAccount(cookie)
      } catch (e) {
        return { type: "failed", error: e?.message ?? String(e) }
      }
      // the same verify + save shape a pasted account takes (the usage
      // probe confirms the cookie, id and csrf against the live account)
      return importAccount({ account: JSON.stringify(account) })
    },
  }
}
