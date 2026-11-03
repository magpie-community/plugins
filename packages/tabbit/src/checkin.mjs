// The daily sign-in (签到), as magpie's check-in hook.
//
// magpie calls this once a day for each signed-in account while the user has
// the switch on (Settings → Usage → Plugins), and draws what came of it on
// the account's card. The outcomes it knows:
//
//   claimed     checked in just now
//   done        already checked in today
//   inactive    the vendor has no check-in event now
//   ineligible  this account can't check in at all
//   captcha     a human has to do it (never solved here)
//   failed      anything else; its message is shown, and magpie tries again
//               later the same day
//
// Only what Tabbit actually answers is classified. A `sign_in_result` this
// file hasn't seen is reported as a failure carrying Tabbit's own word for
// it, rather than guessed as a success — a wrong "claimed" is worse than a
// "failed" someone can read.

import { signIn, signInStatus, SIGN_IN_SCENES } from "./api.mjs"

// Tabbit's own answers, measured: a fresh claim says "signed", a second try
// in the same day says "already_signed".
const SIGNED = new Set(["signed", "success", "signed_in"])
const ALREADY = new Set(["already_signed", "already", "duplicate"])

// rewardOf reads a reward row without assuming its shape: a number somewhere
// in it, or a nested amount, is what magpie's `credit` takes.
function rewardOf(row) {
  for (const key of ["usage_reward_result", "reward_result", "reward"]) {
    const reward = row?.[key]
    if (reward === null || reward === undefined) continue
    if (typeof reward === "number") return Number.isFinite(reward) ? reward : undefined
    for (const field of ["amount", "credit", "value", "quota", "count"]) {
      const value = Number(reward?.[field])
      if (Number.isFinite(value)) return value
    }
  }
  return undefined
}

// saidOf is a line for the card: what the sign-in gave, in Tabbit's terms.
function saidOf(row, status) {
  const parts = []
  const rewarded = rewardOf(row)
  if (rewarded !== undefined && rewarded > 0) parts.push(`usage +${rewarded}`)
  const days = Number(row?.signed_days ?? status?.signed_days)
  if (Number.isFinite(days) && days > 0) {
    const required = Number(row?.required_days ?? status?.required_days)
    parts.push(Number.isFinite(required) && required > 0 ? `${days}/${required} days` : `${days} days`)
  }
  const pet = row?.pet_entitlement_result ?? status?.pet_entitlement_result
  if (pet && pet !== "not_eligible") parts.push(`pet: ${pet}`)
  return parts.join(" · ")
}

// checkinOf runs one day's sign-in. The status is read first: it costs
// nothing, it says whether the activity is even open, and it is what tells
// an already-signed day apart from a fresh claim.
export async function checkinOf(creds, { signal } = {}) {
  const status = await signInStatus(creds, { signal })
  const row = (status?.results ?? [])[0]
  if (!row) return { outcome: "ineligible", message: `Tabbit knows no sign-in for ${SIGN_IN_SCENES.join(", ")}` }
  if (row.activity_open === false) {
    return { outcome: "inactive", message: "Tabbit's sign-in activity is closed", ...(saidOf(row, status) ? { message: `Tabbit's sign-in activity is closed · ${saidOf(row, status)}` } : {}) }
  }
  if (row.signed_today === true) {
    return { outcome: "done", streak: Number(row.signed_days) || undefined, message: saidOf(row, status) || "already signed in today" }
  }

  const result = await signIn(creds, { signal })
  const answered = (result?.results ?? [])[0]
  const word = String(answered?.sign_in_result ?? "").toLowerCase()
  const reward = rewardOf(answered) ?? rewardOf(row)
  const said = saidOf(answered ?? row, status)
  if (SIGNED.has(word)) return { outcome: "claimed", credit: reward, streak: Number(answered?.signed_days) || undefined, message: said }
  if (ALREADY.has(word)) return { outcome: "done", streak: Number(answered?.signed_days) || undefined, message: said || "already signed in today" }
  if (!word && (result?.results ?? []).length === 0) {
    return { outcome: "failed", message: "Tabbit answered the sign-in with no result" }
  }
  return { outcome: "failed", message: `Tabbit answered the sign-in with "${answered?.sign_in_result}"${said ? ` · ${said}` : ""}` }
}

export const _internal = { rewardOf, saidOf, SIGNED, ALREADY }