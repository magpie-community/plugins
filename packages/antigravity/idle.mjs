// idleDeadline is a signal that ends a streaming call when nothing arrives
// for ms, rather than at a fixed socket deadline (#1318): Bun's own
// ~300-second timeout fires on the whole call, so a request that streams
// slowly but steadily is cut, while a stalled one holds a turn for five
// minutes and then stacks with the retry. touch() is called as each chunk
// arrives, and the deadline starts over, so only a silence of ms ends it.
//
// A call that ends by itself must dispose() it, or the timer keeps the
// process awake for ms after the last chunk.
export function idleDeadline(ms, { onIdle } = {}) {
  const ctl = new AbortController()
  let timer = null
  let done = false
  const stop = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }
  const arm = () => {
    stop()
    if (done || !(ms > 0)) return
    timer = setTimeout(() => {
      timer = null
      if (done) return
      done = true
      onIdle?.(ms)
      ctl.abort(new Error(`the stream said nothing for ${ms}ms`))
    }, ms)
    // a deadline must not be the reason a run keeps the host alive
    if (typeof timer.unref === "function") timer.unref()
  }
  arm()
  return {
    signal: ctl.signal,
    // touch starts the deadline over: one call per chunk read
    touch: () => {
      if (!done) arm()
    },
    // dispose ends the deadline without aborting, for a call that finished
    dispose: () => {
      done = true
      stop()
    },
    get aborted() {
      return ctl.signal.aborted
    },
  }
}

// firstChunk is idleDeadline for the wait before a stream's first chunk,
// which is the one that stalls longest on Gemini 4 (#1318): after that the
// idle deadline takes over, at the same ms.
export function firstChunk(ms) {
  return idleDeadline(ms)
}
