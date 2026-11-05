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
// Two scenes are kept checked in, both on the same endpoint:
//
//   daily_sign_in  the account's 每日签到 — restores usage (~+3%). This is THE
//                  check-in the user sees under the avatar. It was missing for
//                  a long time because we only ever signed desktop_pet.
//   desktop_pet    the desktop pet's consecutive-day streak (→ a pet).
//
// Each scene is read, claimed if today is unsigned for it, and then verified by
// re-reading the status: a claim reply of "success"/"signed" is only believed
// when the fresh status shows signed_today === true AND the sign-in day equals
// the user's local day. A claim fired at the midnight day boundary can be
// answered "success" for the wrong day (that is exactly how "magpie says signed
// but Tabbit still lets you sign in" happened); if it did not land, the scene is
// reported failed so magpie retries later the same day instead of a false "done".

import { signIn, signInStatus, SIGN_IN_SCENES } from "./api.mjs"

// Tabbit's own answers, measured: a fresh daily_sign_in claim says "success",
// a fresh desktop_pet claim says "signed", a second try in the day says
// "already_signed".
const SIGNED = new Set(["signed", "success", "signed_in"])
const ALREADY = new Set(["already_signed", "already", "duplicate"])

// localDay is today's calendar date where the user lives (the machine magpie
// runs on), as YYYY-MM-DD — the day the Tabbit browser shows as "today", and
// the day a sign-in must land on to actually count.
function localDay(now = new Date()) {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, "0")
  const d = String(now.getDate()).padStart(2, "0")
  return `${y}-${m}-${d}`
}

// sameDay compares Tabbit's `sign_in_date` (YYYY-MM-DD, sometimes with a time)
// with the local day. An absent date can't be compared, so it is not a mismatch.
function sameDay(signInDate, day) {
  if (typeof signInDate !== "string" || signInDate.length < 10) return true
  return signInDate.slice(0, 10) === day
}

// rewardOf reads a numeric reward out of a row without assuming its shape.
function rewardOf(row) {
  for (const key of ["usage_reward_result", "reward_result", "reward"]) {
    const reward = row?.[key]
    if (reward === null || reward === undefined) continue
    if (typeof reward === "number") return Number.isFinite(reward) ? reward : undefined
    if (typeof reward !== "object") continue
    for (const field of ["amount", "credit", "value", "quota", "count"]) {
      const value = Number(reward?.[field])
      if (Number.isFinite(value)) return value
    }
  }
  return undefined
}

// saidOf is a line for the card: what the scene gave, in Tabbit's terms.
function saidOf(row, status) {
  const parts = []
  const rewarded = rewardOf(row)
  if (rewarded !== undefined && rewarded > 0) parts.push(`usage +${rewarded}`)
  else {
    const usage = row?.usage_reward_result
    if (usage === "success" || usage === "granted") parts.push("usage ✓")
  }
  const days = Number(row?.signed_days ?? status?.signed_days)
  if (Number.isFinite(days) && days > 0) {
    const required = Number(row?.required_days ?? status?.required_days)
    parts.push(Number.isFinite(required) && required > 0 ? `${days}/${required} days` : `${days} days`)
  }
  const pet = row?.pet_entitlement_result ?? status?.pet_entitlement_result
  if (pet && pet !== "not_eligible" && pet !== "available") parts.push(`pet: ${pet}`)
  return parts.join(" · ")
}

// checkinOf runs one day's sign-in for every scene. The status is read first;
// each unsigned-and-open scene is claimed, then verified against a fresh status.
export async function checkinOf(creds, { signal, now = new Date() } = {}) {
  const today = localDay(now)

  const status = await signInStatus(creds, { signal })
  const rows = status?.results ?? []
  if (!rows.length) return { outcome: "ineligible", message: `Tabbit knows no sign-in for ${SIGN_IN_SCENES.join(", ")}` }
  if (rows.every((row) => row.activity_open === false)) {
    return { outcome: "inactive", message: "Tabbit's sign-in activity is closed" }
  }

  const statusDay = status?.sign_in_date
  const dayOk = sameDay(statusDay, today)

  const notes = []
  let claimed = false
  let credit
  let streak
  let pendingDay = false
  let stuck = false

  for (const row of rows) {
    const scene = row.scene_code || "?"
    if (row.activity_open === false) { notes.push(`${scene}: closed`); continue }

    if (row.signed_today === true) {
      if (!dayOk) { pendingDay = true; notes.push(`${scene}: server day ${statusDay}≠${today}`) }
      else notes.push(`${scene}: ${saidOf(row, status) || "signed"}`)
      continue
    }
    if (!dayOk) { pendingDay = true; notes.push(`${scene}: waiting for server day (${statusDay}≠${today})`); continue }

    // Not signed today for this scene — claim it.
    const result = await signIn(creds, { scenes: [scene], signal })
    const answered = (result?.results ?? [])[0]
    const word = String(answered?.sign_in_result ?? "").toLowerCase()
    if (!SIGNED.has(word) && !ALREADY.has(word)) {
      stuck = true
      notes.push(`${scene}: "${answered?.sign_in_result}"`)
      continue
    }

    // A "success"/"signed" reply is not trusted on its own: read the status
    // again and require today to actually be marked signed for this scene.
    const after = await signInStatus(creds, { scenes: [scene], signal })
    const afterRow = (after?.results ?? [])[0]
    const afterDay = after?.sign_in_date
    if (!(afterRow?.signed_today === true && sameDay(afterDay, today))) {
      stuck = true
      notes.push(`${scene}: answered ${word} but not landed (day ${afterDay || "?"})`)
      continue
    }

    if (SIGNED.has(word)) {
      claimed = true
      const rowCredit = rewardOf(answered) ?? rewardOf(row)
      if (rowCredit !== undefined) credit = (credit ?? 0) + rowCredit
      streak = Number(answered?.signed_days) || streak
      notes.push(`${scene}: ✓ ${saidOf(answered ?? row, status)}`)
    } else {
      streak = Number(answered?.signed_days) || streak
      notes.push(`${scene}: already`)
    }
  }

  const message = notes.join(" · ")
  if (claimed) return { outcome: "claimed", credit, streak, message }
  if (pendingDay) return { outcome: "failed", message }
  if (stuck) return { outcome: "failed", message }
  // Every scene was already signed (or closed) — nothing to do today.
  const signedRow = rows.find((row) => row.signed_today === true)
  return { outcome: "done", streak: Number(signedRow?.signed_days) || undefined, message }
}

export const _internal = { rewardOf, saidOf, SIGNED, ALREADY, localDay, sameDay }
