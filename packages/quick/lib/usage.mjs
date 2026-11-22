// The usage numbers, exactly as /profile/usage reports them: a session
// pool (100 minutes), a monthly pool (600 minutes = the "10 hours" the
// plan markets as agent_hours), and the subscription with its trial end.
// Read-only — the plugin shows these and never acts on them (no
// auto-downgrade, no auto-stop).
//
// The live reply shapes (captured in the recon): windows carry
// {used, limit, percent, resets_at?, resume_in_minutes?} with epoch-second
// resets_at; the subscription is {subscription_type, free_trial_metadata:
// {status, expiry_date}} with an epoch-second expiry_date.

// isoEpoch renders an epoch-second (or -millisecond) timestamp as ISO UTC;
// other values pass through unchanged
function isoEpoch(v) {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return v
  const ms = n > 1e12 ? n : n * 1000
  const d = new Date(ms)
  return isNaN(d.getTime()) ? v : d.toISOString()
}

export function usageOf(raw) {
  const u = raw ?? {}
  const out = { plan: "quick", signIn: "kept", windows: [] }
  const sub = u.subscription ?? {}
  const trial = sub.free_trial_metadata ?? {}
  out.subscription = {
    name: sub.subscription_type ?? sub.name ?? sub.type ?? "QUICK",
    ...(trial.status || sub.status ? { status: trial.status ?? sub.status } : {}),
    ...(trial.expiry_date || sub.expiresAt || sub.trial_end
      ? { expiresAt: isoEpoch(trial.expiry_date ?? sub.expiresAt ?? sub.trial_end) }
      : {}),
  }
  const push = (name, pool) => {
    if (!pool || typeof pool !== "object") return
    const used = Number(pool.used), limit = Number(pool.limit)
    if (!Number.isFinite(limit)) return
    out.windows.push({
      name,
      label: pool.label ?? name,
      used: Number.isFinite(used) ? used : 0,
      limit,
      ...(Number.isFinite(used) && limit > 0 ? { percent: Math.min(100, (used / limit) * 100) } : {}),
      ...(pool.resets_at !== undefined && pool.resets_at !== null ? { resetsAt: isoEpoch(pool.resets_at) } : {}),
      ...(Number(pool.resume_in_minutes) > 0 ? { resumeInMinutes: Number(pool.resume_in_minutes) } : {}),
    })
  }
  push("session", u.session)
  push("monthly", u.monthly)
  if (u.monthly?.limit) out.note = `${u.monthly.limit} minutes/month (agent hours)`
  return out
}
