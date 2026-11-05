// Asks the picked models at once and gets `need` answers as soon as it can:
//   - one that fails is replaced by a stand-in, from its own provider first
//     when the failure was that model's alone;
//   - one far slower than the others (2.5 times their middle time, never
//     before graceMs / 4) gets a stand-in alongside it, and whichever answers
//     counts; a server that only keeps the line open can't hold the answer;
//   - once `need` answers are in, or graceMs (or 3 times the middle time) has
//     passed since the first, the ones still going are let go.

import { levelFor } from "./catalog.mjs"
import { talk } from "./call.mjs"
import { PROVIDER_WIDE } from "./health.mjs"

const stop = (kind, message) => Object.assign(new Error(message), { kind })

export function fanOut({ o, health, picks, reserve = [], spare = [], prompt, effort, need, graceMs = 60_000, hardMs = 8 * 60_000, onChange }) {
  const runs = []
  const queue = [...reserve]
  const slowQueue = [...spare]
  const overdue = new Set()
  const t0 = Date.now()
  let ended = false
  let finish
  let hedgeTimer
  let graceTimer
  const finished = new Promise((r) => {
    finish = r
  })
  const running = () => runs.filter((x) => !x.r)
  const answered = () => runs.filter((x) => x.r?.ok)
  const live = () => answered().length + running().filter((x) => !overdue.has(x)).length

  const launch = (m) => {
    const ctrl = new AbortController()
    const run = { m, level: m.fixedLevel ?? levelFor(m, effort), ctrl, r: null, at: Date.now() }
    runs.push(run)
    const hard = setTimeout(() => ctrl.abort(stop("timeout", "timed out")), hardMs)
    talk(o, m, prompt, { level: run.level, signal: ctrl.signal }).then((r) => {
      clearTimeout(hard)
      health.record(r, m)
      if (ended) return
      run.r = r
      if (!r.ok) refill(m, PROVIDER_WIDE.has(r.kind))
      onChange?.(runs)
      check()
    })
  }

  // the next stand-in: from the failed model's own provider when only that
  // model failed, else the next in line; the slow ones only while fewer than
  // two would answer
  const take = (failed, wide) => {
    const ok = (m) => !runs.some((x) => x.m.id === m.id) && !health.held(m) && !(wide && failed && m.provider === failed.provider)
    for (const list of [queue, slowQueue]) {
      if (list === slowQueue && live() >= Math.min(2, need)) break
      const i = failed && !wide ? list.findIndex((m) => m.provider === failed.provider && ok(m)) : -1
      const j = i >= 0 ? i : list.findIndex(ok)
      if (j >= 0) return list.splice(j, 1)[0]
    }
  }

  const refill = (failed, wide) => {
    for (let next; live() < need && (next = take(failed, wide)); ) launch(next)
  }

  const end = () => {
    if (ended) return
    ended = true
    clearTimeout(hedgeTimer)
    clearTimeout(graceTimer)
    for (const x of running()) {
      const slow = overdue.has(x)
      x.r = { ok: false, ms: Date.now() - x.at, kind: slow ? "slow" : "extra", level: x.level }
      x.ctrl.abort(stop(slow ? "slow" : "extra", slow ? "too slow" : "enough answers"))
    }
    finish(runs)
  }

  const check = () => {
    if (answered().length >= need || !running().length) return end()
    const ms = answered().map((x) => x.r.ms).sort((a, b) => a - b)
    if (!ms.length) return
    const mid = ms[Math.floor(ms.length / 2)]
    const hedgeAt = Math.max(graceMs / 4, 2.5 * mid)
    const graceAt = Math.max(graceMs, 3 * mid)
    clearTimeout(hedgeTimer)
    hedgeTimer = setTimeout(() => {
      for (const x of running()) if (Date.now() - x.at >= hedgeAt - 50) overdue.add(x)
      refill()
    }, Math.max(0, t0 + hedgeAt - Date.now()))
    clearTimeout(graceTimer)
    graceTimer = setTimeout(() => {
      for (const x of running()) overdue.add(x)
      end()
    }, Math.max(0, t0 + graceAt - Date.now()))
  }

  picks.forEach(launch)
  if (!picks.length) end()
  return { runs, finished }
}
