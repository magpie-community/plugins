// Work that outlives one tool call. magpie gives a tool 55 seconds, and a
// strong model thinking hard takes longer: the call waits a while, then hands
// back what is in and an id, and the work goes on here until council_result
// asks for it. The plugin host stays up while magpie runs, so it does.

const jobs = new Map()
const KEEP_MS = 60 * 60_000
const MAX_JOBS = 100

export function start(kind, run) {
  const id = `${kind}-${Math.random().toString(36).slice(2, 8)}`
  const job = { id, kind, started: Date.now(), done: false, text: null, view: () => "" }
  job.promise = Promise.resolve()
    .then(() => run(job))
    .then(
      (text) => {
        job.text = text
      },
      (e) => {
        job.text = `council: ${e?.message || e}`
      },
    )
    .finally(() => {
      job.done = true
      job.ended = Date.now()
    })
  jobs.set(id, job)
  prune()
  return job
}

export const find = (id) => jobs.get(String(id || "").trim())

export async function wait(job, ms, abort) {
  if (job.done) return true
  let timer
  const sleep = new Promise((r) => {
    timer = setTimeout(r, Math.max(0, ms))
  })
  const stop = abort && !abort.aborted ? new Promise((r) => abort.addEventListener("abort", r, { once: true })) : null
  await Promise.race([job.promise, sleep, stop].filter(Boolean))
  clearTimeout(timer)
  return job.done
}

function prune() {
  const now = Date.now()
  for (const [id, j] of jobs) if (j.done && now - j.ended > KEEP_MS) jobs.delete(id)
  while (jobs.size > MAX_JOBS) {
    const oldest = [...jobs.values()].find((j) => j.done) || jobs.values().next().value
    jobs.delete(oldest.id)
  }
}
