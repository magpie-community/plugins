// End-to-end self test: create the plugin, call its loader fetch with an
// OpenAI chat request (non-stream), expect a real completion.
import { default as make } from "./index.mjs"

const plugin = await make({})
const cfg = { provider: {} }
await plugin.config(cfg)
const opts = await plugin.auth.loader(async () => ({ type: "oauth", access: "{}" }), { id: "gemini-web-relay", models: {} })

const body = JSON.stringify({
  model: "gemini-web-relay/gemini-3.1-pro",
  messages: [
    { role: "system", content: "You are a calculator assistant. Answer with just the number." },
    { role: "user", content: "What is 17*23?" },
  ],
  stream: false,
})
const res = await opts.fetch("https://gemini-web-relay.invalid/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body })
console.log("status:", res.status)
const data = await res.json()
console.log(JSON.stringify(data, null, 2).slice(0, 600))
await plugin.dispose()
process.exit(0)
