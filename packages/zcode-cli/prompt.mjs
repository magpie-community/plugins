// An Anthropic Messages request as the one prompt `zcode --prompt` takes.
//
// Each request runs a ZCode of its own, so the whole conversation goes in
// every time: the client's instructions, then each turn in order. Images
// the client sent inline are written next to it and attached
// (`--attach`). A conversation too long for a command line is written to a
// file in ZCode's working directory, and the prompt asks ZCode to read it.

import { writeFileSync } from "node:fs"
import { join } from "node:path"

const EXT = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" }

// The most a prompt passed on the command line holds. Windows' command
// line is 32K UTF-16 units in all; elsewhere argv has room for far more.
export const ARGV_PROMPT_MAX = process.platform === "win32" ? 24 * 1024 : 96 * 1024

export function systemText(body) {
  const s = body?.system
  if (typeof s === "string") return s.trim()
  if (Array.isArray(s)) return s.map((b) => (typeof b === "string" ? b : b?.type === "text" ? b.text : "")).filter(Boolean).join("\n\n").trim()
  return ""
}

function stringify(v) {
  if (typeof v === "string") return v
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

// blocksOf renders one message's content; an image is written to dir and
// its path added to attach.
function blocksOf(content, dir, attach) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  const out = []
  for (const b of content) {
    if (!b || typeof b !== "object") continue
    switch (b.type) {
      case "text":
        if (b.text) out.push(b.text)
        break
      case "image": {
        const src = b.source ?? {}
        if (src.type === "base64" && typeof src.data === "string" && dir) {
          const file = join(dir, `image-${attach.length + 1}.${EXT[src.media_type] ?? "png"}`)
          writeFileSync(file, Buffer.from(src.data, "base64"))
          attach.push(file)
          out.push(`[image attached: ${file}]`)
        } else if (src.type === "url" && src.url) {
          out.push(`[image: ${src.url}]`)
        }
        break
      }
      case "document": {
        const src = b.source ?? {}
        if (src.type === "text" && src.data) out.push(src.data)
        break
      }
      case "tool_use":
        out.push(`[called tool ${b.name} with ${stringify(b.input ?? {})}]`)
        break
      case "tool_result": {
        const inner = typeof b.content === "string" ? b.content : blocksOf(b.content, dir, attach)
        out.push(`[result of tool call${b.is_error ? ", an error" : ""}]\n${inner}`)
        break
      }
      // thinking and redacted_thinking were ZCode's own; it doesn't take them back
      default:
        break
    }
  }
  return out.join("\n\n")
}

// render gives { prompt, attach, inFile }: the prompt for --prompt, the
// files for --attach, and whether the conversation went to a file in dir.
export function render(body, dir) {
  const attach = []
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const sys = systemText(body)
  const turns = messages.map((m) => ({ role: m?.role === "assistant" ? "assistant" : "user", text: blocksOf(m?.content, dir, attach).trim() }))
  let prompt
  if (!sys && turns.length === 1 && turns[0].role === "user") {
    prompt = turns[0].text
  } else {
    const parts = []
    if (sys) parts.push(`<instructions>\n${sys}\n</instructions>`)
    if (turns.length > 1) {
      parts.push("<conversation>")
      for (const t of turns.slice(0, -1)) parts.push(`<${t.role}>\n${t.text}\n</${t.role}>`)
      parts.push("</conversation>")
    }
    const last = turns.at(-1)
    if (last?.role === "assistant") {
      // a prefill: the reply goes on from it
      parts.push(`Continue this reply from where it stops:\n${last.text}`)
    } else {
      parts.push(`<user>\n${last?.text ?? ""}\n</user>`)
      if (turns.length > 1 || sys) parts.push("Answer the last user message.")
    }
    prompt = parts.join("\n\n")
  }
  if (Buffer.byteLength(prompt) <= ARGV_PROMPT_MAX || !dir) return { prompt, attach, inFile: false }
  const file = join(dir, "conversation.md")
  writeFileSync(file, prompt)
  return {
    prompt: `The file ${file} holds the request: instructions, the conversation so far and the last user message. Read all of it, then answer as it asks.`,
    attach,
    inFile: true,
  }
}
