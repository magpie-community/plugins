// HarnessWeight as an OpenCode v1 plugin: magpie's Bun host loads it and calls
// server(), which starts the local service the page navigates to. It adds no
// provider. Importing this module alone binds no port.
import { serve } from "./service.mjs"

let started = null
function start(options) {
  if (!started) {
    started = serve(options || {})
    started.ready.then((p) => p && console.log(`[harnessweight] listening on http://127.0.0.1:${p}`))
  }
  return started
}

export default {
  id: "harnessweight",
  server: async (_input, options) => {
    start(options)
    return {}
  },
}
