// One request on its way to Mistral: the key its wallet names, the body
// shaped for the API, one retry when an effort is refused, and the reply put
// back in OpenAI's shape.

import { adjustEffort } from "./effort.mjs"
import { ReplyFixer, fixReply } from "./reply.mjs"
import { WALLET_SUFFIX, shapeRequest } from "./request.mjs"

const CHAT_PATH = /\/(chat\/completions|responses)\/?$/
const RESPONSES_PATH = /\/responses\/?$/

// rebuild answers with a body we read ourselves: the upstream's encoding and
// length describe bytes we no longer send.
function rebuild(response, body) {
  const headers = new Headers(response.headers)
  headers.delete("content-encoding")
  headers.delete("content-length")
  return new Response(body, { status: response.status, statusText: response.statusText, headers })
}

function modelOf(text) {
  try {
    return JSON.parse(text)?.model ?? ""
  } catch {
    return ""
  }
}

// sendChat is the provider's fetch. A 429 is returned as it came: magpie
// rests the account and falls back on it, guided by Retry-After.
export async function sendChat(input, init, keys) {
  const request = input instanceof Request ? input : new Request(input, init)
  const url = request.url
  const method = request.method
  const path = new URL(url).pathname
  const chat = CHAT_PATH.test(path)

  let sent = ""
  if (method !== "GET" && method !== "HEAD") {
    sent = init?.body != null && typeof init.body === "string" ? init.body : await request.clone().text()
  }

  // The model id says which wallet: `<id>--api` spends the API budget, the
  // bare id the Vibe budget.
  const asked = modelOf(sent)
  const onApiWallet = typeof asked === "string" && asked.endsWith(WALLET_SUFFIX)
  const key = onApiWallet ? keys?.api : (keys?.vibe ?? keys?.api)

  if (!key) {
    return new Response(
      JSON.stringify({
        error: {
          message: `${asked || "this request"} needs the ${onApiWallet ? "API" : "Vibe"} key, which this sign-in doesn't hold`,
          type: "invalid_request_error",
        },
      }),
      { status: 401, headers: { "content-type": "application/json" } },
    )
  }

  const headers = new Headers(init?.headers ?? request.headers)
  headers.delete("authorization")
  headers.delete("x-api-key")
  headers.delete("content-length")
  headers.set("authorization", `Bearer ${key}`)

  let body = chat ? shapeRequest(sent, { responses: RESPONSES_PATH.test(path) }) : sent
  let streaming = false
  try {
    streaming = JSON.parse(body)?.stream === true
  } catch {}

  const send = (payload) =>
    fetch(url, {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : payload,
      signal: request.signal,
      redirect: "follow",
    })

  let response = await send(body)

  if (chat && (response.status === 400 || response.status === 422)) {
    const refusal = await response.text()
    const retryBody = adjustEffort(body, refusal)
    if (retryBody == null) return rebuild(response, refusal)
    const retried = await send(retryBody)
    if (!retried.ok) return rebuild(retried, await retried.text())
    response = retried
    body = retryBody
  }

  if (!response.ok || !chat) return response

  if (streaming && /(^|\n)text\/event-stream/i.test(response.headers.get("content-type") ?? "")) {
    return new ReplyFixer().fixStream(response)
  }

  const text = await response.text()
  try {
    return rebuild(response, JSON.stringify(fixReply(JSON.parse(text))))
  } catch {
    return rebuild(response, text)
  }
}
